import type { DB } from "../Database";

export type TimelineWindowStatus =
  | "collecting"
  | "sealing"
  | "ready"
  | "generating"
  | "succeeded"
  | "skipped"
  | "failed";

export type TimelineWindowCloseReason =
  | "duration"
  | "idle"
  | "pause"
  | "day_rollover"
  | "report"
  | "shutdown"
  | "rebuild";

export type TimelineSourceCompleteness = "complete" | "partial";

export interface TimelineGenerationWindow {
  id: string;
  dateKey: string;
  collectionStart: string;
  collectionEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  status: TimelineWindowStatus;
  closeReason: TimelineWindowCloseReason | null;
  sourceCompleteness: TimelineSourceCompleteness;
  timelineBlockId: string | null;
  sourceObservationCount: number;
  retryCount: number;
  lastError: string | null;
  sealedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type WindowRow = {
  id: string;
  date_key: string;
  collection_start: string;
  collection_end: string;
  actual_start: string | null;
  actual_end: string | null;
  status: TimelineWindowStatus;
  close_reason: TimelineWindowCloseReason | null;
  source_completeness: TimelineSourceCompleteness;
  timeline_block_id: string | null;
  source_observation_count: number;
  retry_count: number;
  last_error: string | null;
  sealed_at: string | null;
  created_at: string;
  updated_at: string;
};

export class TimelineGenerationWindowRepository {
  constructor(private readonly db: DB) {}

  create(input: {
    dateKey: string;
    collectionStart: string;
    collectionEnd: string;
  }): TimelineGenerationWindow {
    const now = new Date().toISOString();
    const id = windowId(input.dateKey, input.collectionStart, input.collectionEnd);
    this.db.prepare(`INSERT OR IGNORE INTO timeline_generation_windows (
      id, date_key, collection_start, collection_end, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'collecting', ?, ?)`)
      .run(id, input.dateKey, input.collectionStart, input.collectionEnd, now, now);
    return this.getById(id)!;
  }

  getById(id: string): TimelineGenerationWindow | null {
    const row = this.db.prepare("SELECT * FROM timeline_generation_windows WHERE id = ?")
      .get(id) as WindowRow | undefined;
    return row ? mapRow(row) : null;
  }

  getActive(dateKey?: string): TimelineGenerationWindow | null {
    const row = dateKey
      ? this.db.prepare(`SELECT * FROM timeline_generation_windows
          WHERE date_key = ? AND status IN ('collecting', 'sealing')
          ORDER BY collection_start ASC LIMIT 1`).get(dateKey)
      : this.db.prepare(`SELECT * FROM timeline_generation_windows
          WHERE status IN ('collecting', 'sealing')
          ORDER BY collection_start ASC LIMIT 1`).get();
    return row ? mapRow(row as WindowRow) : null;
  }

  listPendingGeneration(): TimelineGenerationWindow[] {
    const rows = this.db.prepare(`SELECT * FROM timeline_generation_windows
      WHERE status IN ('ready', 'failed') ORDER BY collection_start ASC`).all() as WindowRow[];
    return rows.map(mapRow);
  }

  listSucceededPartial(): TimelineGenerationWindow[] {
    const rows = this.db.prepare(`SELECT * FROM timeline_generation_windows
      WHERE status = 'succeeded' AND source_completeness = 'partial'
      ORDER BY collection_start ASC`).all() as WindowRow[];
    return rows.map(mapRow);
  }

  listByDateKey(dateKey: string): TimelineGenerationWindow[] {
    const rows = this.db.prepare(`SELECT * FROM timeline_generation_windows
      WHERE date_key = ? ORDER BY collection_start ASC`).all(dateKey) as WindowRow[];
    return rows.map(mapRow);
  }

  getLastCollectionEnd(dateKey: string): string | null {
    const row = this.db.prepare(`SELECT MAX(collection_end) AS value
      FROM timeline_generation_windows WHERE date_key = ?`).get(dateKey) as { value: string | null };
    return row.value;
  }

  update(id: string, patch: Partial<Pick<TimelineGenerationWindow,
    | "collectionEnd"
    | "actualStart"
    | "actualEnd"
    | "status"
    | "closeReason"
    | "sourceCompleteness"
    | "timelineBlockId"
    | "sourceObservationCount"
    | "lastError"
    | "sealedAt"
  >> & { incrementRetry?: boolean }): TimelineGenerationWindow {
    const columns: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.collectionEnd !== undefined) assign("collection_end", patch.collectionEnd);
    if (patch.actualStart !== undefined) assign("actual_start", patch.actualStart);
    if (patch.actualEnd !== undefined) assign("actual_end", patch.actualEnd);
    if (patch.status !== undefined) assign("status", patch.status);
    if (patch.closeReason !== undefined) assign("close_reason", patch.closeReason);
    if (patch.sourceCompleteness !== undefined) assign("source_completeness", patch.sourceCompleteness);
    if (patch.timelineBlockId !== undefined) assign("timeline_block_id", patch.timelineBlockId);
    if (patch.sourceObservationCount !== undefined) assign("source_observation_count", patch.sourceObservationCount);
    if (patch.lastError !== undefined) assign("last_error", patch.lastError);
    if (patch.sealedAt !== undefined) assign("sealed_at", patch.sealedAt);
    if (patch.incrementRetry) columns.push("retry_count = retry_count + 1");
    columns.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE timeline_generation_windows SET ${columns.join(", ")} WHERE id = ?`)
      .run(...values);
    const updated = this.getById(id);
    if (!updated) throw new Error(`timeline window not found: ${id}`);
    return updated;
  }

  resetInterruptedGenerating(): number {
    return this.db.prepare(`UPDATE timeline_generation_windows
      SET status = 'failed', last_error = 'generation_interrupted', updated_at = ?
      WHERE status = 'generating'`).run(new Date().toISOString()).changes;
  }
}

function mapRow(row: WindowRow): TimelineGenerationWindow {
  return {
    id: row.id,
    dateKey: row.date_key,
    collectionStart: row.collection_start,
    collectionEnd: row.collection_end,
    actualStart: row.actual_start,
    actualEnd: row.actual_end,
    status: row.status,
    closeReason: row.close_reason,
    sourceCompleteness: row.source_completeness,
    timelineBlockId: row.timeline_block_id,
    sourceObservationCount: row.source_observation_count,
    retryCount: row.retry_count,
    lastError: row.last_error,
    sealedAt: row.sealed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function windowId(dateKey: string, start: string, end: string): string {
  const normalize = (value: string) => value.replace(/[^0-9]/g, "");
  return `tw_${dateKey.replace(/-/g, "")}_${normalize(start)}_${normalize(end)}`;
}
