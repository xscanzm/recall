import type { DB } from "../Database";
import type { BatchCaptureBundle, CaptureBundle } from "../../models/types";
import { assertBatchStage } from "../sqlIdentifiers";

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

interface ImagePathRow {
  image_path: string | null;
}

export interface PendingCaptureStats {
  count: number;
  oldestCapturedAt: string | null;
}

export interface TerminalCompactionResult {
  batches: number;
  captures: number;
  bytesBefore: number;
  bytesAfter: number;
  reclaimedBytes: number;
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

  listPendingCaptures(limit = 6): CaptureBundle[] {
    const rows = this.db.prepare(
      `SELECT bundle_json FROM capture_inbox
       WHERE status = 'pending' ORDER BY captured_at ASC, created_at ASC LIMIT ?`
    ).all(Math.max(1, Math.floor(limit))) as CaptureRow[];
    return rows.map((row) => JSON.parse(row.bundle_json) as CaptureBundle);
  }

  countPendingCaptures(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM capture_inbox WHERE status = 'pending'"
    ).get() as { count: number };
    return row.count;
  }

  getPendingCaptureStats(): PendingCaptureStats {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count, MIN(captured_at) AS oldestCapturedAt
       FROM capture_inbox WHERE status = 'pending'`
    ).get() as { count: number; oldestCapturedAt: string | null };
    return row;
  }

  listPendingCaptureImagePaths(): string[] {
    const rows = this.db.prepare(
      `SELECT json_extract(bundle_json, '$.stitchedImagePath') AS image_path
       FROM capture_inbox
       WHERE status = 'pending'
         AND json_valid(bundle_json)
         AND json_type(bundle_json, '$.stitchedImagePath') = 'text'
       UNION ALL
       SELECT image.value AS image_path
       FROM capture_inbox
       CROSS JOIN json_each(
         CASE
           WHEN json_valid(bundle_json) THEN COALESCE(json_extract(bundle_json, '$.imagePaths'), '[]')
           ELSE '[]'
         END
       ) AS image
       WHERE status = 'pending' AND typeof(image.value) = 'text'`
    ).all() as ImagePathRow[];
    return rows.flatMap((row) => row.image_path ? [row.image_path] : []);
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

  listProcessableBatches(maxAttempts: number, limit = 2): CaptureBatchRecord[] {
    const rows = this.db.prepare(
       `SELECT batch_id, bundle_json, status, attempts, last_error,
               observer_status, episode_status, atom_status, linker_status, checkpoint_json
       FROM capture_batches
       WHERE status = 'pending' AND attempts < ? ORDER BY created_at ASC LIMIT ?`
    ).all(maxAttempts, normalizeLimit(limit)) as BatchRow[];
    return rows.map(mapBatch);
  }

  getLatestProcessableBatch(maxAttempts: number): CaptureBatchRecord | null {
    const row = this.db.prepare(
      `SELECT batch_id, bundle_json, status, attempts, last_error,
              observer_status, episode_status, atom_status, linker_status, checkpoint_json
       FROM capture_batches
       WHERE status = 'pending' AND attempts < ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(maxAttempts) as BatchRow | undefined;
    return row ? mapBatch(row) : null;
  }

  countProcessableBatches(maxAttempts: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM capture_batches
       WHERE status = 'pending' AND attempts < ?`
    ).get(maxAttempts) as { count: number };
    return row.count;
  }

  listProcessableBatchesForWindow(
    collectionStart: string,
    collectionEnd: string,
    maxAttempts: number,
    limit = 2
  ): CaptureBatchRecord[] {
    const rows = this.db.prepare(`SELECT DISTINCT cb.* FROM capture_batches cb
      JOIN capture_inbox ci ON ci.batch_id = cb.batch_id
      WHERE ci.captured_at >= ? AND ci.captured_at < ?
        AND cb.status = 'pending' AND cb.attempts < ?
      ORDER BY cb.created_at ASC LIMIT ?`)
      .all(collectionStart, collectionEnd, maxAttempts, normalizeLimit(limit)) as BatchRow[];
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
      this.compactTerminalBatch(batchId);
    })();
  }

  markFailed(batchId: string, error: string, retry: boolean): void {
    const status = retry ? "pending" : "failed";
    this.db.transaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE capture_batches SET status = ?, last_error = ?, updated_at = ? WHERE batch_id = ?`
      ).run(status, error.slice(0, 1000), now, batchId);
      if (!retry) {
        this.db.prepare(
          `UPDATE capture_inbox SET status = 'failed', updated_at = ? WHERE batch_id = ?`
        ).run(now, batchId);
        this.compactTerminalBatch(batchId);
      }
    })();
  }

  /**
   * Replace terminal capture payloads with the metadata needed by watermarks,
   * forgetRecent, and diagnostics. Pending/running work is left untouched.
   */
  compactTerminalBatch(batchId: string): void {
    this.db.prepare(COMPACT_TERMINAL_BATCH_SQL).run(batchId);
    this.db.prepare(COMPACT_TERMINAL_CAPTURES_FOR_BATCH_SQL).run(batchId);
  }

  /** Compact historical terminal capture payloads without touching memories. */
  compactTerminalPayloads(): TerminalCompactionResult {
    const before = this.db.prepare(
      `SELECT
         COALESCE((SELECT SUM(length(bundle_json)) FROM capture_batches
           WHERE status IN ('succeeded', 'failed')), 0) AS batchBytes,
         COALESCE((SELECT SUM(length(bundle_json)) FROM capture_inbox
           WHERE status IN ('succeeded', 'failed')
              OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed'))), 0) AS captureBytes`
    ).get() as { batchBytes: number; captureBytes: number };

    const result = this.db.transaction(() => {
      const batches = this.db.prepare(COMPACT_TERMINAL_BATCHES_SQL).run().changes;
      const captures = this.db.prepare(COMPACT_TERMINAL_CAPTURES_SQL).run().changes;
      return { batches, captures };
    })();

    const after = this.db.prepare(
      `SELECT
         COALESCE((SELECT SUM(length(bundle_json)) FROM capture_batches
           WHERE status IN ('succeeded', 'failed')), 0) AS batchBytes,
         COALESCE((SELECT SUM(length(bundle_json)) FROM capture_inbox
           WHERE status IN ('succeeded', 'failed')
              OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed'))), 0) AS captureBytes`
    ).get() as { batchBytes: number; captureBytes: number };
    const bytesBefore = before.batchBytes + before.captureBytes;
    const bytesAfter = after.batchBytes + after.captureBytes;
    return {
      ...result,
      bytesBefore,
      bytesAfter,
      reclaimedBytes: Math.max(0, bytesBefore - bytesAfter),
    };
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
    const safeStage = assertBatchStage(stage);
    const current = this.getBatch(batchId)?.checkpoint ?? {};
    this.db.prepare(`UPDATE capture_batches SET ${safeStage}_status = 'succeeded', checkpoint_json = ?, updated_at = ? WHERE batch_id = ?`)
      .run(JSON.stringify({ ...current, ...patch }), new Date().toISOString(), batchId);
  }

  markStageFailed(batchId: string, stage: BatchStage, error: string): void {
    const safeStage = assertBatchStage(stage);
    this.db.prepare(`UPDATE capture_batches SET ${safeStage}_status = 'failed', last_error = ?, updated_at = ? WHERE batch_id = ?`)
      .run(error.slice(0, 1000), new Date().toISOString(), batchId);
  }

  private updateStage(batchId: string, stage: BatchStage, status: BatchStageStatus): void {
    const safeStage = assertBatchStage(stage);
    this.db.prepare(`UPDATE capture_batches SET ${safeStage}_status = ?, updated_at = ? WHERE batch_id = ?`)
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

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

const TERMINAL_STATUS_SQL = "status IN ('succeeded', 'failed')";

const COMPACT_TERMINAL_BATCH_SQL = `
  UPDATE capture_batches
  SET bundle_json = CASE
    WHEN json_valid(bundle_json) THEN json_object(
      'batchId', batch_id,
      'capturedAtStart', json_extract(bundle_json, '$.capturedAtStart'),
      'capturedAtEnd', json_extract(bundle_json, '$.capturedAtEnd'),
      'timezone', json_extract(bundle_json, '$.timezone'),
      'appName', json_extract(bundle_json, '$.appName'),
      'windowTitle', json_extract(bundle_json, '$.windowTitle'),
      'captureReason', json_extract(bundle_json, '$.captureReason'),
      'frameCount', COALESCE(json_array_length(json_extract(bundle_json, '$.frames')), 0),
      'imageCount', COALESCE(json_array_length(json_extract(bundle_json, '$.imagePaths')), 0),
      'retentionPolicy', json_extract(bundle_json, '$.retentionPolicy'),
      'terminalStatus', status
    )
    ELSE json_object('batchId', batch_id, 'terminalStatus', status)
  END,
  updated_at = updated_at
  WHERE batch_id = ? AND ${TERMINAL_STATUS_SQL}`;

const COMPACT_TERMINAL_BATCHES_SQL = COMPACT_TERMINAL_BATCH_SQL.replace(
  "WHERE batch_id = ? AND status IN ('succeeded', 'failed')",
  `WHERE ${TERMINAL_STATUS_SQL}`
);

const COMPACT_TERMINAL_CAPTURES_SQL = `
  UPDATE capture_inbox
  SET status = CASE
    WHEN batch_id IN (SELECT batch_id FROM capture_batches WHERE status = 'failed') THEN 'failed'
    ELSE 'succeeded'
  END,
  bundle_json = CASE
    WHEN json_valid(bundle_json) THEN json_object(
      'captureId', capture_id,
      'capturedAt', captured_at,
      'batchId', batch_id,
      'retentionPolicy', json_extract(bundle_json, '$.retentionPolicy'),
      'terminalStatus', CASE
        WHEN batch_id IN (SELECT batch_id FROM capture_batches WHERE status = 'failed') THEN 'failed'
        ELSE 'succeeded'
      END
    )
    ELSE json_object(
      'captureId', capture_id,
      'capturedAt', captured_at,
      'batchId', batch_id,
      'terminalStatus', CASE
        WHEN batch_id IN (SELECT batch_id FROM capture_batches WHERE status = 'failed') THEN 'failed'
        ELSE 'succeeded'
      END
    )
  END,
  updated_at = updated_at
  WHERE status IN ('succeeded', 'failed')
     OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed'))`;

const COMPACT_TERMINAL_CAPTURES_FOR_BATCH_SQL = COMPACT_TERMINAL_CAPTURES_SQL.replace(
  "WHERE status IN ('succeeded', 'failed')\n     OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed'))",
  "WHERE batch_id = ? AND (status IN ('succeeded', 'failed')\n     OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed')))"
);
