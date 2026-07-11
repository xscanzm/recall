import { randomUUID } from "node:crypto";
import type { DB } from "../Database";

export type CorrectionTargetType = "fact" | "scene" | "task" | "project" | "person" | "decision" | "reminder";
export type ProjectionType = "timeline" | "report" | "search" | "l3";

export interface CorrectionRevision {
  id: string;
  targetType: CorrectionTargetType;
  targetId: string;
  feedbackType: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface ProjectionInvalidation {
  id: string;
  projectionType: ProjectionType;
  targetType: CorrectionTargetType;
  targetId: string;
  reason: string;
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: string;
  processedAt: string | null;
  lastError: string | null;
}

interface RevisionRow { id: string; target_type: CorrectionTargetType; target_id: string; feedback_type: string; before_json: string | null; after_json: string | null; created_at: string }
interface InvalidationRow { id: string; projection_type: ProjectionType; target_type: CorrectionTargetType; target_id: string; reason: string; status: ProjectionInvalidation["status"]; created_at: string; processed_at: string | null; last_error: string | null }

export class CorrectionLifecycleRepository {
  constructor(private readonly db: DB) {}

  recordRevision(input: Omit<CorrectionRevision, "id" | "createdAt">): CorrectionRevision {
    const id = `revision_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT INTO correction_revisions
      (id, target_type, target_id, feedback_type, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.targetType, input.targetId, input.feedbackType, JSON.stringify(input.before), JSON.stringify(input.after), createdAt);
    return { id, createdAt, ...input };
  }

  listRevisions(targetType: CorrectionTargetType, targetId: string): CorrectionRevision[] {
    const rows = this.db.prepare(`SELECT * FROM correction_revisions
      WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC, id DESC`).all(targetType, targetId) as RevisionRow[];
    return rows.map((row) => ({
      id: row.id, targetType: row.target_type, targetId: row.target_id, feedbackType: row.feedback_type,
      before: parseJson(row.before_json), after: parseJson(row.after_json), createdAt: row.created_at,
    }));
  }

  enqueue(targetType: CorrectionTargetType, targetId: string, projections: ProjectionType[], reason: string): void {
    const insert = this.db.prepare(`INSERT INTO projection_invalidations
      (id, projection_type, target_type, target_id, reason, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(projection_type, target_type, target_id) WHERE status IN ('pending', 'processing')
      DO UPDATE SET reason = excluded.reason`);
    const now = new Date().toISOString();
    for (const projection of new Set(projections)) {
      insert.run(`invalidation_${randomUUID()}`, projection, targetType, targetId, reason, now);
    }
  }

  listPending(limit = 100): ProjectionInvalidation[] {
    const rows = this.db.prepare(`SELECT * FROM projection_invalidations
      WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT ?`).all(limit) as InvalidationRow[];
    return rows.map(mapInvalidation);
  }

  claimPending(limit = 100): ProjectionInvalidation[] {
    return this.db.transaction(() => {
      const pending = this.listPending(limit);
      if (pending.length === 0) return [];
      const claimedAt = new Date().toISOString();
      const claim = this.db.prepare(
        "UPDATE projection_invalidations SET status = 'processing', processed_at = ? WHERE id = ? AND status = 'pending'"
      );
      return pending.filter((item) => claim.run(claimedAt, item.id).changes > 0)
        .map((item) => ({ ...item, status: "processing" as const, processedAt: claimedAt }));
    })();
  }

  markCompleted(id: string): boolean {
    return this.db.prepare("UPDATE projection_invalidations SET status = 'completed', processed_at = ?, last_error = NULL WHERE id = ? AND status IN ('pending', 'processing')")
      .run(new Date().toISOString(), id).changes > 0;
  }

  markFailed(id: string, error: string): boolean {
    return this.db.prepare("UPDATE projection_invalidations SET status = 'failed', processed_at = ?, last_error = ? WHERE id = ? AND status IN ('pending', 'processing')")
      .run(new Date().toISOString(), error, id).changes > 0;
  }
}

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function mapInvalidation(row: InvalidationRow): ProjectionInvalidation {
  return { id: row.id, projectionType: row.projection_type, targetType: row.target_type, targetId: row.target_id,
    reason: row.reason, status: row.status, createdAt: row.created_at, processedAt: row.processed_at, lastError: row.last_error };
}
