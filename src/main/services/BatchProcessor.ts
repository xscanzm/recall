import type { BatchPipelineResult, MemoryPipeline } from "./MemoryPipeline";
import type { CaptureInboxRepository, CaptureBatchRecord } from "../db/repositories/CaptureInboxRepository";
import type { BatchCaptureBundle } from "../models/types";
import { BATCH_MAX_ATTEMPTS } from "../db/repositories/CaptureInboxRepository";
import { CaptureBatcher } from "./CaptureBatcher";
import { logger } from "./Logger";

const MAX_ATTEMPTS = BATCH_MAX_ATTEMPTS;
const BATCH_CONCURRENCY = 5;

export type BatchSettlementStatus = "succeeded" | "retry_pending" | "retry_exhausted";

export class BatchProcessor {
  private stopping = false;
  private readonly activeBatches = new Map<string, Promise<void>>();
  private processPromise: Promise<void> | null = null;

  constructor(
    private readonly repository: CaptureInboxRepository,
    private readonly pipeline: MemoryPipeline,
    private readonly onSucceeded?: (
      result: BatchPipelineResult,
      bundle: BatchCaptureBundle
    ) => Promise<void>,
    private readonly onSettled?: (
      status: BatchSettlementStatus,
      bundle: BatchCaptureBundle
    ) => Promise<void> | void
  ) {}

  start(): void {
    const recovered = this.repository.recoverRunningBatches();
    if (recovered > 0) {
      logger.warn({ message: `BatchProcessor recovered ${recovered} running batches` });
    }
    // 恢复动作会把 running 写回 pending 而不动 attempts，可能造出"永不可处理又永不终态"
    // 的 batch。启动时统一把它们落到 failed，避免卡死时间轴窗口的封窗水位。
    const exhausted = this.repository.failExhaustedBatches(MAX_ATTEMPTS);
    if (exhausted > 0) {
      logger.warn({ message: `BatchProcessor failed ${exhausted} retry-exhausted batches` });
    }
    this.notify();
  }

  notify(): void {
    if (this.stopping || this.processPromise) return;
    this.processPromise = this.processAvailable().finally(() => {
      this.processPromise = null;
    });
  }

  private drainPromise: Promise<void> | null = null;

  /** Stop accepting new batches and wait for every claimed batch to settle. */
  stopAndDrainActive(): Promise<void> {
    this.stopping = true;
    if (this.drainPromise) {
      return this.drainPromise;
    }
    this.drainPromise = (async () => {
      if (this.processPromise) {
        await this.processPromise;
      } else if (this.activeBatches.size > 0) {
        await Promise.allSettled([...this.activeBatches.values()]);
      }
    })();
    return this.drainPromise;
  }

  async drain(): Promise<void> {
    do {
      this.notify();
      if (this.processPromise) await this.processPromise;
    } while (this.repository.listProcessableBatches(MAX_ATTEMPTS).length > 0);
  }

  async drainThroughCapturedAt(collectionStart: string, collectionEnd: string): Promise<void> {
    while (!this.stopping) {
      const records = this.repository.listProcessableBatchesForWindow(
        collectionStart,
        collectionEnd,
        MAX_ATTEMPTS
      );
      let availableSlots = Math.max(0, BATCH_CONCURRENCY - this.activeBatches.size);
      for (const record of records) {
        if (availableSlots === 0) break;
        if (this.activeBatches.has(record.batchId)) continue;
        this.repository.markRunning(record.batchId);
        const promise = this.processOneBatch(record).finally(() => {
          this.activeBatches.delete(record.batchId);
        });
        this.activeBatches.set(record.batchId, promise);
        availableSlots -= 1;
      }
      const relevantIds = new Set(
        this.repository.getWindowWatermark(collectionStart, collectionEnd).batchIds
      );
      const relevant = [...this.activeBatches]
        .filter(([batchId]) => relevantIds.has(batchId))
        .map(([, promise]) => promise);
      if (relevant.length > 0) {
        await Promise.race(relevant);
        continue;
      }
      if (records.length === 0) break;
      // 并发槽可能被窗口外的后台 batch 占满；等任意一个释放后再优先补当前窗口。
      if (this.activeBatches.size > 0) {
        await Promise.race(this.activeBatches.values());
      }
    }
  }

  private async processAvailable(): Promise<void> {
    while (!this.stopping) {
      // 填满并发槽位
      while (
        !this.stopping &&
        this.activeBatches.size < BATCH_CONCURRENCY
      ) {
        const record = this.repository.listProcessableBatches(MAX_ATTEMPTS)[0];
        if (!record) break;
        this.repository.markRunning(record.batchId);
        const promise = this.processOneBatch(record).finally(() => {
          this.activeBatches.delete(record.batchId);
        });
        this.activeBatches.set(record.batchId, promise);
      }

      if (this.activeBatches.size === 0) break;

      // 等待任意一个完成，然后继续填充
      await Promise.race(this.activeBatches.values());
    }

    // 停止时等待所有进行中的 batch 完成
    if (this.activeBatches.size > 0) {
      await Promise.allSettled(this.activeBatches.values());
    }
  }

  private async processOneBatch(record: CaptureBatchRecord): Promise<void> {
    try {
      const hasImages = await CaptureBatcher.restoreCompressedImages(record.bundle);
      if (!hasImages) throw new Error("batch has no recoverable image files");
      this.repository.updateBatchBundle(record.bundle);
      const result = await this.pipeline.processBatchCaptureBundle(record.bundle, {
        stages: record.stages,
        checkpoint: record.checkpoint,
        markRunning: (stage) => this.repository.markStageRunning(record.batchId, stage),
        markSucceeded: (stage, checkpoint) => this.repository.markStageSucceeded(record.batchId, stage, checkpoint),
        markFailed: (stage, error) => this.repository.markStageFailed(record.batchId, stage, error),
      });
      const normalized = result.steps.normalizer;
      const complete = result.steps.observerExtractor && normalized.failed === 0 &&
        result.steps.episodes && result.steps.atoms && result.steps.linkerSceneJudge;
      if (!complete) {
        throw new Error(result.errors[0]?.message ?? result.errors[0]?.code ?? "batch pipeline failed");
      }
      this.repository.markSucceeded(record.batchId);
      CaptureBatcher.cleanupCompressedImages(record.bundle.compressedImagePaths);
      try {
        await this.onSucceeded?.(result, record.bundle);
      } catch (error) {
        logger.warn({
          jobType: "batch_pipeline",
          status: "failed",
          errorCode: "post_success_callback_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await this.notifySettled("succeeded", record.bundle);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retry = record.attempts + 1 < MAX_ATTEMPTS;
      this.repository.markFailed(record.batchId, message, retry);
      if (!retry) {
        CaptureBatcher.cleanupCompressedImages(record.bundle.compressedImagePaths);
      }
      logger.warn({
        jobType: "batch_pipeline",
        status: "failed",
        errorCode: retry ? "retry_pending" : "retry_exhausted",
        message,
      });
      await this.notifySettled(retry ? "retry_pending" : "retry_exhausted", record.bundle);
    }
  }

  private async notifySettled(status: BatchSettlementStatus, bundle: BatchCaptureBundle): Promise<void> {
    try {
      await this.onSettled?.(status, bundle);
    } catch (error) {
      logger.warn({
        jobType: "batch_pipeline",
        status: "failed",
        errorCode: "settlement_callback_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
