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
  private isFlushing = false;

  constructor(config: CaptureBatcherConfig = {}) {
    super();
    this.compressedDir =
      config.compressedDir ?? path.join(os.tmpdir(), "recall-batch");
    fs.mkdirSync(this.compressedDir, { recursive: true });
  }

  /**
   * 添加一个 capture-bundle 到攒批队列
   * - 攒满 6 帧立即触发 flush
   * - 未满时启动 5 分钟超时定时器
   */
  add(bundle: CaptureBundle): void {
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
    // 防止并发 flush
    if (this.isFlushing) {
      return;
    }
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

    const frames = this.queue.splice(0);
    logger.info({
      message: `CaptureBatcher.flush: 提交 ${frames.length} 帧`,
    });

    try {
      // 压缩所有帧为 JPEG q=25
      const compressedImagePaths = await this.compressImages(frames);

      const batchBundle = this.composeBatch(frames, compressedImagePaths);
      this.emit("batch-ready", batchBundle);
    } catch (err) {
      logger.error({
        message: `CaptureBatcher 压缩/构造批次失败: ${err instanceof Error ? err.message : String(err)}`,
      });
      // 失败时不重入队列（避免无限循环），直接丢弃本次攽批
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 停止攒批（清除定时器，不 flush）
   * - 用于应用退出前的资源清理
   * - 如需提交当前攽批，应先调 flush() 再调 stop()
   */
  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 压缩所有 PNG 截图为 JPEG q=25（resize 到 800px 宽）
   * - 输出到 compressedDir 临时目录
   * - 文件名：batch_<batchId>_frame_<idx>.jpg
   * - 返回压缩后的文件路径数组（与 frames 顺序对应）
   */
  private async compressImages(frames: CaptureBundle[]): Promise<string[]> {
    const batchId = `batch_${Date.now().toString(36)}`;
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
    compressedImagePaths: string[]
  ): BatchCaptureBundle {
    const mid = Math.floor(frames.length / 2);
    return {
      batchId: `batch_${Date.now().toString(36)}`,
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
}
