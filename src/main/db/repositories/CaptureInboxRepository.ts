import type { DB } from "../Database";
import type { BatchCaptureBundle, CaptureBundle } from "../../models/types";

/**
 * batch 的最大尝试次数。放在仓储层是因为 getWindowWatermark 的 SQL 也要用它判定终态，
 * 必须和 BatchProcessor 的挑选条件（attempts < maxAttempts）保持同一个数。
 */
export const BATCH_MAX_ATTEMPTS = 3;

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

export interface CaptureWindowWatermark {
  totalCount: number;
  unsettledCount: number;
  failedCount: number;
  batchIds: string[];
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
       (capture_id, bundle_json, status, batch_id, created_at, updated_at, captured_at)
       VALUES (?, ?, 'pending', NULL, ?, ?, ?)`
    ).run(bundle.captureId, JSON.stringify(bundle), now, now, bundle.capturedAt);
    return result.changes > 0;
  }

  listPendingCaptures(): CaptureBundle[] {
    const rows = this.db.prepare(
      `SELECT bundle_json FROM capture_inbox
       WHERE status = 'pending' ORDER BY captured_at ASC, created_at ASC`
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

  /**
   * 把重试次数已经用尽却仍停在 pending/running 的 batch 落到终态 failed。
   *
   * 崩溃恢复（recoverRunningBatches）和优雅关闭（checkpointRunning）都会把 running
   * 改回 pending 而不动 attempts。如果那一次正好是第 maxAttempts 次尝试，这条 batch
   * 就落进死区：listProcessableBatches 因 attempts < maxAttempts 不再挑它，
   * getWindowWatermark 又因为它既非 succeeded 也非 failed 而永久算作 unsettled，
   * 于是覆盖它的时间轴窗口再也封不掉。
   */
  failExhaustedBatches(maxAttempts: number): number {
    return this.db.prepare(
      `UPDATE capture_batches
       SET status = 'failed',
           last_error = COALESCE(last_error, 'retry_exhausted_without_terminal_state'),
           updated_at = ?
       WHERE status IN ('pending', 'running') AND attempts >= ?`
    ).run(new Date().toISOString(), maxAttempts).changes;
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

  listProcessableBatchesForWindow(
    collectionStart: string,
    collectionEnd: string,
    maxAttempts: number
  ): CaptureBatchRecord[] {
    const rows = this.db.prepare(`SELECT DISTINCT cb.* FROM capture_batches cb
      JOIN capture_inbox ci ON ci.batch_id = cb.batch_id
      WHERE ci.captured_at >= ? AND ci.captured_at < ?
        AND cb.status = 'pending' AND cb.attempts < ?
      ORDER BY cb.created_at ASC`)
      .all(collectionStart, collectionEnd, maxAttempts) as BatchRow[];
    return rows.map(mapBatch);
  }

  getWindowWatermark(collectionStart: string, collectionEnd: string): CaptureWindowWatermark {
    const rows = this.db.prepare(`SELECT ci.batch_id,
        CASE
          WHEN ci.status = 'succeeded' OR cb.status = 'succeeded' THEN 'succeeded'
          WHEN cb.status = 'failed' THEN 'failed'
          WHEN cb.batch_id IS NOT NULL AND cb.attempts >= ${BATCH_MAX_ATTEMPTS} THEN 'failed'
          ELSE 'unsettled'
        END AS terminal_status
      FROM capture_inbox ci
      LEFT JOIN capture_batches cb ON cb.batch_id = ci.batch_id
      WHERE ci.captured_at >= ? AND ci.captured_at < ?`)
      .all(collectionStart, collectionEnd) as Array<{
        batch_id: string | null;
        terminal_status: "succeeded" | "failed" | "unsettled";
      }>;
    return {
      totalCount: rows.length,
      unsettledCount: rows.filter((row) => row.terminal_status === "unsettled").length,
      failedCount: rows.filter((row) => row.terminal_status === "failed").length,
      batchIds: [...new Set(rows.flatMap((row) => row.batch_id ? [row.batch_id] : []))],
    };
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
