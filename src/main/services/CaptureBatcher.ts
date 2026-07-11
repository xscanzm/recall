// src/main/services/CaptureBatcher.ts
// 截图攒批合并提交（阶段二：工程化落地）
//
// 职责：
// - 收集 CaptureService 发出的 capture-bundle，攒满 6 帧后合并提交
// - 未满 6 帧时，5 分钟超时兜底也提交（避免长时间等待）
// - 攒批时对每张 PNG 截图做 resize 800px + JPEG q=25 压缩，输出临时文件
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
import type { BatchCaptureBundle, CaptureBundle } from "../models/types";
import type { CaptureInboxRepository } from "../db/repositories/CaptureInboxRepository";
import { logger } from "./Logger";

/**
 * 攒批参数
 */
const BATCH_SIZE = 6; // 攒满 6 帧立即提交，避免 JSON 输出过长被截断
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟超时兜底
const FRAME_TARGET_WIDTH = 800; // 每帧 resize 到 800px 宽（等比缩放）
const JPEG_QUALITY = 25; // JPEG q=25（阶段一验证参数）

/**
 * CaptureBatcher 配置
 */
export interface CaptureBatcherConfig {
  repository: CaptureInboxRepository;
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
  private readonly compressedDir: string;
  private readonly repository: CaptureInboxRepository;
  private isFlushing = false;
  private flushPromise: Promise<void> | null = null;
  private accepting = true;

  constructor(config: CaptureBatcherConfig) {
    super();
    this.repository = config.repository;
    this.compressedDir =
      config.compressedDir ?? path.join(os.tmpdir(), "recall-batch");
    fs.mkdirSync(this.compressedDir, { recursive: true });
    this.queue = this.repository.listPendingCaptures();
    if (this.queue.length > 0) {
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
   * - 未满时启动 5 分钟超时定时器
   */
  add(bundle: CaptureBundle): boolean {
    if (!this.accepting) return false;
    if (!this.repository.enqueueCapture(bundle)) return true;
    this.queue.push(bundle);
    logger.info({
      message: `CaptureBatcher.add: 队列长度 ${this.queue.length}/${BATCH_SIZE} (captureId=${bundle.captureId})`,
    });

    if (this.queue.length >= BATCH_SIZE) {
      // 攒满立即触发（异步，不阻塞 add 调用方）
      this.flush().catch((err) => {
        logger.error({
          message: `CaptureBatcher.flush 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    } else if (!this.flushTimer) {
      // 未满，启动超时兜底
      this.flushTimer = setTimeout(() => {
        this.flush().catch((err) => {
          logger.error({
            message: `CaptureBatcher 超时 flush 失败: ${err instanceof Error ? err.message : String(err)}`,
          });
        });
      }, FLUSH_INTERVAL_MS);
    }
    return true;
  }

  /**
   * 冲刷当前攽批，构造 BatchCaptureBundle 并 emit "batch-ready"
   * - 清除超时定时器
   * - 压缩所有 PNG 为 JPEG q=25 临时文件
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
      return;
    }

    this.isFlushing = true;

    // 清除超时定时器
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    const frames = this.queue.splice(0, BATCH_SIZE);
    const batchId = createBatchId(frames);
    logger.info({
      message: `CaptureBatcher.flush: 提交 ${frames.length} 帧`,
    });

    try {
      // 压缩所有帧为 JPEG q=25
      const compressedImagePaths = await this.compressImages(frames, batchId);

      const batchBundle = this.composeBatch(frames, compressedImagePaths, batchId);
      if (this.repository.createBatch(batchBundle)) {
        this.emit("batch-ready");
      }
    } catch (err) {
      logger.error({
        message: `CaptureBatcher 压缩/构造批次失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.queue.unshift(...frames);
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

  async drain(): Promise<void> {
    this.stopAccepting();
    while (this.flushPromise || this.queue.length > 0) {
      await this.flush();
    }
    this.stop();
  }

  /**
   * 压缩所有 PNG 截图为 JPEG q=25（resize 到 800px 宽）
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
          .jpeg({ quality: JPEG_QUALITY })
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
      retentionPolicy: frames[0].retentionPolicy,
    };
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flush().catch((err) => {
        logger.error({
          message: `CaptureBatcher 超时 flush 失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, FLUSH_INTERVAL_MS);
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
          .jpeg({ quality: JPEG_QUALITY })
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
