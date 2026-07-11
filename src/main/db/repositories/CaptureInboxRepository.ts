import type { DB } from "../Database";
import type { BatchCaptureBundle, CaptureBundle } from "../../models/types";

export type CaptureBatchStatus = "pending" | "running" | "succeeded" | "failed";
export type BatchStageStatus = "pending" | "running" | "succeeded" | "failed";
export type BatchStage = "observer" | "episode" | "atom" | "linker";
export interface BatchCheckpoint {
  observationIds?: (string | null)[];
  episodeIds?: string[];
  atomIds?: string[];
}

interface CaptureRow {
  bundle_json: string;
}

interface BatchRow {
  batch_id: string;
  bundle_json: string;
  status: CaptureBatchStatus;
  attempts: number;
  last_error: string | null;
  observer_status: BatchStageStatus;
  episode_status: BatchStageStatus;
  atom_status: BatchStageStatus;
  linker_status: BatchStageStatus;
  checkpoint_json: string;
}

export interface CaptureBatchRecord {
  batchId: string;
  bundle: BatchCaptureBundle;
  status: CaptureBatchStatus;
  attempts: number;
  lastError: string | null;
  stages: Record<BatchStage, BatchStageStatus>;
  checkpoint: BatchCheckpoint;
}

export class CaptureInboxRepository {
  constructor(private readonly db: DB) {}

  enqueueCapture(bundle: CaptureBundle): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO capture_inbox
       (capture_id, bundle_json, status, batch_id, created_at, updated_at)
       VALUES (?, ?, 'pending', NULL, ?, ?)`
    ).run(bundle.captureId, JSON.stringify(bundle), now, now);
    return result.changes > 0;
  }

  listPendingCaptures(): CaptureBundle[] {
    const rows = this.db.prepare(
      `SELECT bundle_json FROM capture_inbox
       WHERE status = 'pending' ORDER BY created_at ASC`
    ).all() as CaptureRow[];
    return rows.map((row) => JSON.parse(row.bundle_json) as CaptureBundle);
  }

  createBatch(bundle: BatchCaptureBundle): boolean {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const inserted = this.db.prepare(
        `INSERT OR IGNORE INTO capture_batches
         (batch_id, bundle_json, status, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, 'pending', 0, NULL, ?, ?)`
      ).run(bundle.batchId, JSON.stringify(bundle), now, now);

      if (inserted.changes === 0) return false;
      const mark = this.db.prepare(
        `UPDATE capture_inbox SET status = 'batched', batch_id = ?, updated_at = ?
         WHERE capture_id = ? AND status = 'pending'`
      );
      for (const frame of bundle.frames) {
        mark.run(bundle.batchId, now, frame.captureId);
      }
      return true;
    })();
  }

  recoverRunningBatches(): number {
    return this.db.prepare(
      `UPDATE capture_batches SET status = 'pending', updated_at = ? WHERE status = 'running'`
    ).run(new Date().toISOString()).changes;
  }

  listProcessableBatches(maxAttempts: number): CaptureBatchRecord[] {
    const rows = this.db.prepare(
       `SELECT batch_id, bundle_json, status, attempts, last_error,
               observer_status, episode_status, atom_status, linker_status, checkpoint_json
       FROM capture_batches
       WHERE status = 'pending' AND attempts < ? ORDER BY created_at ASC`
    ).all(maxAttempts) as BatchRow[];
    return rows.map(mapBatch);
  }

  markRunning(batchId: string): void {
    this.db.prepare(
      `UPDATE capture_batches
       SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE batch_id = ?`
    ).run(new Date().toISOString(), batchId);
  }

  updateBatchBundle(bundle: BatchCaptureBundle): void {
    this.db.prepare(
      `UPDATE capture_batches SET bundle_json = ?, updated_at = ? WHERE batch_id = ?`
    ).run(JSON.stringify(bundle), new Date().toISOString(), bundle.batchId);
  }

  markSucceeded(batchId: string): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE capture_batches SET status = 'succeeded', last_error = NULL, updated_at = ?
         WHERE batch_id = ?`
      ).run(now, batchId);
      this.db.prepare(
        `UPDATE capture_inbox SET status = 'succeeded', updated_at = ? WHERE batch_id = ?`
      ).run(now, batchId);
    })();
  }

  markFailed(batchId: string, error: string, retry: boolean): void {
    this.db.prepare(
      `UPDATE capture_batches SET status = ?, last_error = ?, updated_at = ? WHERE batch_id = ?`
    ).run(retry ? "pending" : "failed", error.slice(0, 1000), new Date().toISOString(), batchId);
  }

  checkpointRunning(batchId: string): void {
    this.db.prepare(
      `UPDATE capture_batches SET status = 'pending', updated_at = ?
       WHERE batch_id = ? AND status = 'running'`
    ).run(new Date().toISOString(), batchId);
  }

  markStageRunning(batchId: string, stage: BatchStage): void {
    this.updateStage(batchId, stage, "running");
  }

  markStageSucceeded(batchId: string, stage: BatchStage, patch: BatchCheckpoint = {}): void {
    const current = this.getBatch(batchId)?.checkpoint ?? {};
    this.db.prepare(`UPDATE capture_batches SET ${stage}_status = 'succeeded', checkpoint_json = ?, updated_at = ? WHERE batch_id = ?`)
      .run(JSON.stringify({ ...current, ...patch }), new Date().toISOString(), batchId);
  }

  markStageFailed(batchId: string, stage: BatchStage, error: string): void {
    this.db.prepare(`UPDATE capture_batches SET ${stage}_status = 'failed', last_error = ?, updated_at = ? WHERE batch_id = ?`)
      .run(error.slice(0, 1000), new Date().toISOString(), batchId);
  }

  private updateStage(batchId: string, stage: BatchStage, status: BatchStageStatus): void {
    this.db.prepare(`UPDATE capture_batches SET ${stage}_status = ?, updated_at = ? WHERE batch_id = ?`)
      .run(status, new Date().toISOString(), batchId);
  }

  private getBatch(batchId: string): CaptureBatchRecord | null {
    const row = this.db.prepare(`SELECT * FROM capture_batches WHERE batch_id = ?`).get(batchId) as BatchRow | undefined;
    return row ? mapBatch(row) : null;
  }
}

function mapBatch(row: BatchRow): CaptureBatchRecord {
  return {
    batchId: row.batch_id,
    bundle: JSON.parse(row.bundle_json) as BatchCaptureBundle,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    stages: {
      observer: row.observer_status,
      episode: row.episode_status,
      atom: row.atom_status,
      linker: row.linker_status,
    },
    checkpoint: safeParseCheckpoint(row.checkpoint_json),
  };
}

function safeParseCheckpoint(json: string): BatchCheckpoint {
  try { return JSON.parse(json) as BatchCheckpoint; } catch { return {}; }
}
