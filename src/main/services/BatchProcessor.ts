import type { BatchPipelineResult, MemoryPipeline } from "./MemoryPipeline";
import type { CaptureInboxRepository } from "../db/repositories/CaptureInboxRepository";
import type { BatchCaptureBundle } from "../models/types";
import { CaptureBatcher } from "./CaptureBatcher";
import { logger } from "./Logger";

const MAX_ATTEMPTS = 3;

export class BatchProcessor {
  private running = false;
  private stopping = false;
  private currentBatchId: string | null = null;
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
    if (this.running || this.stopping) return;
    this.processPromise = this.processAvailable();
  }

  checkpoint(): void {
    this.stopping = true;
    if (this.currentBatchId) {
      this.repository.checkpointRunning(this.currentBatchId);
    }
  }

  async drain(): Promise<void> {
    do {
      this.notify();
      if (this.processPromise) await this.processPromise;
    } while (this.repository.listProcessableBatches(MAX_ATTEMPTS).length > 0);
  }

  private async processAvailable(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopping) {
        const record = this.repository.listProcessableBatches(MAX_ATTEMPTS)[0];
        if (!record) return;
        this.currentBatchId = record.batchId;
        this.repository.markRunning(record.batchId);
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
        } finally {
          this.currentBatchId = null;
        }
      }
    } finally {
      this.running = false;
      this.processPromise = null;
    }
  }
}
