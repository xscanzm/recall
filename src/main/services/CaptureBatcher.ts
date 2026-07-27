// src/main/services/CaptureBatcher.ts
// 截图攒批合并提交（阶段二：工程化落地）
//
// 职责：
// - 收集 CaptureService 发出的 capture-bundle，攒满 6 帧后合并提交
// - 未满 6 帧时，5 分钟超时兜底也提交（避免长时间等待）
// - 先对每张原始 PNG 做本地 OCR，再生成 resize 800px + JPEG q=45 临时文件
// - flush 时构造 BatchCaptureBundle，emit "batch-ready" 事件
// - 暂停/退出时主动 flush，避免丢攽批
//
// 线上稳定性调整：
// - 6 帧一批，降低模型输出被截断导致整批无法落库的概率

import { EventEmitter } from "events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import sharp from "sharp";
import type { BatchCaptureBundle, BatchFrameOcrResult, CaptureBundle } from "../models/types";
import type { CaptureInboxRepository } from "../db/repositories/CaptureInboxRepository";
import { logger } from "./Logger";
import { WindowsOcrService } from "./WindowsOcrService";
import { OcrFrameProcessor, type PreparedOcrBatch } from "./OcrFrameProcessor";
import type { OcrBatchService } from "./OcrService";

/**
 * 攒批参数
 */
const BATCH_SIZE = 6; // 攒满 6 帧立即提交，避免 JSON 输出过长被截断
/**
 * 空闲兜底：距离最后一帧超过这个时长才认为"活动停了"，把不满 6 帧的残批提交。
 *
 * 不能用"从第一帧起算固定 5 分钟"：ActivityService 的长会话间隔是 5 分钟、内容变化
 * 最小间隔 60 秒，真实到帧节奏约 60~70 秒一帧，攒满 6 帧要 6 分钟以上。固定 5 分钟
 * 的定时器会在批次快满时抢先提交，于是出现大量 4~5 帧、甚至 1 帧的批次。
 */
const IDLE_FLUSH_MS = 150 * 1000;
/**
 * 年龄上限：队列里最老的一帧不允许比这个时长更旧。
 *
 * 空闲定时器每来一帧就重置，光靠它在持续活动下可能无限推迟；这个上限保证残批
 * 最迟也会提交。取 10 分钟与时间轴采集窗口对齐，封窗时本来也会强制 flush 一次。
 */
const MAX_BATCH_AGE_MS = 10 * 60 * 1000;
const FRAME_TARGET_WIDTH = 800; // 每帧 resize 到 800px 宽（等比缩放）
const JPEG_QUALITY = 45;
const JPEG_CHROMA_SUBSAMPLING = "4:2:0";

/**
 * CaptureBatcher 配置
 */
export interface CaptureBatcherConfig {
  repository: CaptureInboxRepository;
  ocrService?: OcrBatchService;
  ocrFrameProcessor?: Pick<OcrFrameProcessor, "prepareBatch">;
  /**
   * 压缩图临时目录。默认用 os.tmpdir()/recall-batch
   * 压缩图使用后由调用方（ObserverExtractorWorker）清理
   */
  compressedDir?: string;
}

/**
 * CaptureBatcher：攒批 6 帧合并提交
 *
 * 使用：
 *   const batcher = new CaptureBatcher();
 *   captureService.on("capture-bundle", (b) => batcher.add(b));
 *   batcher.on("batch-ready", (batch) => memoryPipeline.processBatchCaptureBundle(batch));
 *   // 暂停/退出前
 *   await batcher.flush();
 *   batcher.stop();
 */
export class CaptureBatcher extends EventEmitter {
  private queue: CaptureBundle[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** 队首那一帧入队的本地时刻，用来给残批算年龄上限。 */
  private oldestQueuedAt: number | null = null;
  private readonly compressedDir: string;
  private readonly repository: CaptureInboxRepository;
  private readonly ocrFrameProcessor: Pick<OcrFrameProcessor, "prepareBatch">;
  private isFlushing = false;
  private flushPromise: Promise<void> | null = null;
  private accepting = true;

  constructor(config: CaptureBatcherConfig) {
    super();
    this.repository = config.repository;
    this.ocrFrameProcessor = config.ocrFrameProcessor ?? new OcrFrameProcessor({
      ocrService: config.ocrService ?? new WindowsOcrService(),
    });
    this.compressedDir =
      config.compressedDir ?? path.join(os.tmpdir(), "recall-batch");
    fs.mkdirSync(this.compressedDir, { recursive: true });
    this.queue = this.repository.listPendingCaptures();
    if (this.queue.length > 0) {
      this.oldestQueuedAt = Date.now();
      setImmediate(() => {
        this.flush().catch((err) => {
          logger.error({
            message: `CaptureBatcher 启动恢复 flush 失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      });
    }
  }

  /**
   * 添加一个 capture-bundle 到攒批队列
   * - 攒满 6 帧立即触发 flush
   * - 未满时排定兜底：空闲 IDLE_FLUSH_MS 后提交，且不超过 MAX_BATCH_AGE_MS
   */
  add(bundle: CaptureBundle): boolean {
    if (!this.accepting) return false;
    if (!this.repository.enqueueCapture(bundle)) return true;
    this.queue.push(bundle);
    logger.info({
      message: `CaptureBatcher.add: 队列长度 ${this.queue.length}/${BATCH_SIZE} (captureId=${bundle.captureId})`,
    });

    if (this.oldestQueuedAt === null) this.oldestQueuedAt = Date.now();

    if (this.queue.length >= BATCH_SIZE) {
      // 攒满立即触发（异步，不阻塞 add 调用方）
      this.flush().catch((err) => {
        logger.error({
          message: `CaptureBatcher.flush 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    } else {
      // 未满：按"空闲 + 年龄上限"重排兜底提交
      this.scheduleFlush();
    }
    return true;
  }

  /**
   * 冲刷当前攽批，构造 BatchCaptureBundle 并 emit "batch-ready"
   * - 清除超时定时器
   * - 使用未压缩原图做本地 OCR，再生成 JPEG q=45 临时文件
   * - 即使未满 6 帧也会提交（用于暂停/退出/long_session 触发）
   * - 队列为空时无操作
   *
   * 注意：调用方应在 MemoryPipeline 处理完 batch-ready 后清理 compressedImagePaths
   */
  async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.doFlush().finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  private async doFlush(): Promise<void> {
    if (this.queue.length === 0) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.oldestQueuedAt = null;
      return;
    }

    this.isFlushing = true;

    // 清除超时定时器
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const frames = this.queue.splice(0, BATCH_SIZE);
    const previousAnchor = this.oldestQueuedAt;
    // 剩下的帧从现在起重新计年龄；队列空了就清掉锚点。
    this.oldestQueuedAt = this.queue.length > 0 ? Date.now() : null;
    const batchId = createBatchId(frames);
    logger.info({
      message: `CaptureBatcher.flush: 提交 ${frames.length} 帧`,
    });

    try {
      // OCR 必须读取原始截图；识别完成后再生成模型使用的压缩图。
      const preparedOcr = await this.prepareOriginalImageOcr(frames);
      const ocrResults = preparedOcr.results;
      const compressedImagePaths = await this.compressImages(frames, batchId);

      const batchBundle = this.composeBatch(
        frames,
        compressedImagePaths,
        ocrResults,
        batchId
      );
      if (this.repository.createBatch(batchBundle)) {
        // Match Screenpipe's durability boundary: cache is visible only after
        // the OCR-bearing batch bundle has been committed to SQLite.
        preparedOcr.commit();
        this.emit("batch-ready");
      }
    } catch (err) {
      logger.error({
        message: `CaptureBatcher 压缩/构造批次失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.queue.unshift(...frames);
      // 帧退回队首，年龄锚点也要退回，不能让失败重排把它们"变新"。
      this.oldestQueuedAt = previousAnchor ?? Date.now();
      throw err;
    } finally {
      this.isFlushing = false;
      if (this.queue.length > 0) this.scheduleFlush();
    }
  }

  /**
   * 停止攒批（清除定时器，不 flush）
   * - 用于应用退出前的资源清理
   * - 如需提交当前攽批，应先调 flush() 再调 stop()
   */
  stop(): void {
    this.accepting = false;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) this.oldestQueuedAt = null;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async suspendAndFlush(): Promise<void> {
    this.stopAccepting();
    while (this.flushPromise || this.queue.length > 0) await this.flush();
  }

  resumeAccepting(): void {
    this.accepting = true;
  }

  /** Original screenshots still needed by queued or in-flight OCR work. */
  getPendingImagePaths(): string[] {
    return this.repository.listPendingCaptures().flatMap((frame) => [
      frame.stitchedImagePath,
      ...frame.imagePaths,
    ]).filter((filePath): filePath is string => !!filePath);
  }

  async drain(): Promise<void> {
    this.stopAccepting();
    while (this.flushPromise || this.queue.length > 0) {
      await this.flush();
    }
    this.stop();
  }

  private async prepareOriginalImageOcr(frames: CaptureBundle[]): Promise<PreparedOcrBatch> {
    try {
      return await this.ocrFrameProcessor.prepareBatch(frames);
    } catch (error) {
      logger.warn({
        jobType: "local_ocr",
        status: "failed",
        errorCode: "local_ocr_unhandled_error",
        message: `Local OCR integration failed: ${error instanceof Error ? error.name : "unknown_error"}`,
      });
      return {
        results: frames.map((_, index) => ({
          frameIndex: index + 1,
          text: "",
          lines: [],
          blocks: [],
          errorCode: "local_ocr_unhandled_error",
        })),
        commit: () => undefined,
      };
    }
  }

  /**
   * 压缩所有 PNG 截图为优化彩色 JPEG q=45（resize 到 800px 宽）
   * - 输出到 compressedDir 临时目录
   * - 文件名：batch_<batchId>_frame_<idx>.jpg
   * - 返回压缩后的文件路径数组（与 frames 顺序对应）
   */
  private async compressImages(frames: CaptureBundle[], batchId: string): Promise<string[]> {
    const paths: string[] = [];

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      // 取该帧的第一张图（单帧采集时 imagePaths 长度 = 1）
      const srcPath = frame.imagePaths[0];
      if (!srcPath || !fs.existsSync(srcPath)) {
        logger.warn({
          message: `CaptureBatcher: 帧 ${i + 1} 截图文件不存在: ${srcPath}`,
        });
        // 用空字符串占位，下游 collectImagePaths 会过滤
        paths.push("");
        continue;
      }

      const outPath = path.join(
        this.compressedDir,
        `${batchId}_frame_${i + 1}.jpg`
      );

      try {
        await sharp(srcPath)
          .resize({ width: FRAME_TARGET_WIDTH })
          .jpeg({
            quality: JPEG_QUALITY,
            chromaSubsampling: JPEG_CHROMA_SUBSAMPLING,
            mozjpeg: true,
          })
          .toFile(outPath);
        paths.push(outPath);
      } catch (err) {
        logger.warn({
          message: `CaptureBatcher: 帧 ${i + 1} 压缩失败: ${err instanceof Error ? err.message : String(err)}`,
        });
        paths.push("");
      }
    }

    return paths;
  }

  /**
   * 构造 BatchCaptureBundle
   * - 主帧取中位帧（appName / windowTitle）
   * - 时间范围取首末帧
   * - imagePaths 扁平化所有 frames[].imagePaths
   */
  private composeBatch(
    frames: CaptureBundle[],
    compressedImagePaths: string[],
    ocrResults: BatchFrameOcrResult[],
    batchId: string
  ): BatchCaptureBundle {
    const mid = Math.floor(frames.length / 2);
    return {
      batchId,
      frames,
      capturedAtStart: frames[0].capturedAt,
      capturedAtEnd: frames[frames.length - 1].capturedAt,
      timezone: frames[0].timezone,
      appName: frames[mid].appName,
      windowTitle: frames[mid].windowTitle,
      captureReason: "batch_flush",
      imagePaths: frames.flatMap((f) => f.imagePaths),
      compressedImagePaths,
      ocrResults,
      retentionPolicy: frames[0].retentionPolicy,
    };
  }

  /**
   * 排定残批的兜底提交时间：空闲 IDLE_FLUSH_MS 后提交，但不晚于最老一帧的
   * MAX_BATCH_AGE_MS。每次入队都要重排，让"空闲"这一半随新帧顺延。
   */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const oldestAge = this.oldestQueuedAt === null
      ? 0
      : Math.max(0, Date.now() - this.oldestQueuedAt);
    const delay = Math.max(0, Math.min(IDLE_FLUSH_MS, MAX_BATCH_AGE_MS - oldestAge));
    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        logger.error({
          message: `CaptureBatcher 超时 flush 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, delay);
  }

  /**
   * 清理压缩图临时文件（由 MemoryPipeline 处理完后调用）
   */
  static cleanupCompressedImages(compressedImagePaths: string[]): void {
    for (const p of compressedImagePaths) {
      if (!p) continue;
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
        }
      } catch {
        // 忽略清理失败
      }
    }
  }

  static async restoreCompressedImages(bundle: BatchCaptureBundle): Promise<boolean> {
    for (let i = 0; i < bundle.frames.length; i++) {
      const existing = bundle.compressedImagePaths[i];
      if (existing && fs.existsSync(existing)) continue;
      const source = bundle.frames[i].imagePaths[0];
      if (!source || !fs.existsSync(source)) {
        bundle.compressedImagePaths[i] = "";
        continue;
      }
      const output = existing || path.join(
        os.tmpdir(),
        "recall-batch",
        `${bundle.batchId}_frame_${i + 1}.jpg`
      );
      fs.mkdirSync(path.dirname(output), { recursive: true });
      try {
        await sharp(source)
          .resize({ width: FRAME_TARGET_WIDTH })
          .jpeg({
            quality: JPEG_QUALITY,
            chromaSubsampling: JPEG_CHROMA_SUBSAMPLING,
            mozjpeg: true,
          })
          .toFile(output);
        bundle.compressedImagePaths[i] = output;
      } catch {
        bundle.compressedImagePaths[i] = "";
      }
    }
    return bundle.compressedImagePaths.some((imagePath) => !!imagePath);
  }
}

function createBatchId(frames: CaptureBundle[]): string {
  return `batch_${frames.map((frame) => frame.captureId).join("_")}`;
}
