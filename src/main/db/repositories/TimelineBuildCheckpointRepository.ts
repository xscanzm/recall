import type { DB } from "../Database";

export class TimelineBuildCheckpointRepository {
  constructor(private db: DB) {}

  get(dateKey: string): string | null {
    const row = this.db.prepare(
      "SELECT processed_through FROM timeline_build_checkpoints WHERE date_key = ?"
    ).get(dateKey) as { processed_through: string } | undefined;
    return row?.processed_through ?? null;
  }

  set(dateKey: string, processedThrough: string): void {
    this.db.prepare(`INSERT INTO timeline_build_checkpoints (date_key, processed_through, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(date_key) DO UPDATE SET
      processed_through = excluded.processed_through, updated_at = excluded.updated_at`
    ).run(dateKey, processedThrough, new Date().toISOString());
  }
}
