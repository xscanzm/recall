import type { BatchPipelineResult, MemoryPipeline } from "./MemoryPipeline";
import type { CaptureInboxRepository, CaptureBatchRecord } from "../db/repositories/CaptureInboxRepository";
import type { BatchCaptureBundle } from "../models/types";
import { CaptureBatcher } from "./CaptureBatcher";
import { logger } from "./Logger";

const MAX_ATTEMPTS = 3;
const BATCH_CONCURRENCY = 5;

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
    ) => Promise<void>
  ) {}

  start(): void {
    const recovered = this.repository.recoverRunningBatches();
    if (recovered > 0) {
      logger.warn({ message: `BatchProcessor recovered ${recovered} running batches` });
    }
    this.notify();
  }

  notify(): void {
    if (this.processPromise) return;
    this.processPromise = this.processAvailable().finally(() => {
      this.processPromise = null;
    });
  }

  checkpoint(): void {
    this.stopping = true;
    for (const batchId of this.activeBatches.keys()) {
      this.repository.checkpointRunning(batchId);
    }
  }

  async drain(): Promise<void> {
    do {
      this.notify();
      if (this.processPromise) await this.processPromise;
    } while (this.repository.listProcessableBatches(MAX_ATTEMPTS).length > 0);
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
      if (this.stopping) return;
      const normalized = result.steps.normalizer;
      const complete = result.steps.observerExtractor && normalized.failed === 0 &&
        result.steps.episodes && result.steps.atoms && result.steps.linkerSceneJudge;
      if (!complete) {
        throw new Error(result.errors[0]?.message ?? result.errors[0]?.code ?? "batch pipeline failed");
      }
      this.repository.markSucceeded(record.batchId);
      CaptureBatcher.cleanupCompressedImages(record.bundle.compressedImagePaths);
      await this.onSucceeded?.(result, record.bundle);
    } catch (error) {
      if (this.stopping) return;
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
    }
  }
}
