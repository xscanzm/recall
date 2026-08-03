import * as fs from "node:fs";
import * as path from "node:path";
import type { DB } from "./Database";
import { CaptureInboxRepository, type TerminalCompactionResult } from "./repositories/CaptureInboxRepository";

export interface RecallDataMaintenanceOptions {
  apply: boolean;
  vacuum?: boolean;
  backupPath?: string;
}

export interface RecallDataSnapshot {
  databaseBytes: number | null;
  observations: number;
  facts: number;
  scenes: number;
  timelineBlocks: number;
  captureBatches: number;
  terminalBatches: number;
  captureBatchBytes: number;
  terminalCaptureBytes: number;
  modelJobs: number;
  terminalModelJobs: number;
  rawInputBytes: number;
  debugEventsBytes: number;
}

export interface RecallDataMaintenanceResult {
  applied: boolean;
  vacuumed: boolean;
  backupPath: string | null;
  before: RecallDataSnapshot;
  after: RecallDataSnapshot;
  compaction: TerminalCompactionResult | null;
  clearedDebugRows: number;
  clearedDebugBytes: number;
}

/**
 * Read aggregate state without materializing observation or batch payloads.
 * This is intentionally safe to run against the live database in dry-run mode.
 */
export function getRecallDataSnapshot(db: DB, databasePath?: string): RecallDataSnapshot {
  const count = (table: string, where = "") => {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`).get() as { count: number };
    return row.count;
  };
  const sum = (table: string, column: string, where = "") => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(length(${column})), 0) AS bytes FROM ${table}${where ? ` WHERE ${where}` : ""}`
    ).get() as { bytes: number };
    return row.bytes;
  };

  const terminalBatchWhere = "status IN ('succeeded', 'failed')";
  const terminalCaptureWhere = "status IN ('succeeded', 'failed') OR batch_id IN (SELECT batch_id FROM capture_batches WHERE status IN ('succeeded', 'failed'))";
  const terminalJobWhere = "status IN ('succeeded', 'failed')";
  return {
    databaseBytes: databasePath && fs.existsSync(databasePath) ? fs.statSync(databasePath).size : null,
    observations: count("observations"),
    facts: count("facts"),
    scenes: count("scenes"),
    timelineBlocks: count("timeline_blocks"),
    captureBatches: count("capture_batches"),
    terminalBatches: count("capture_batches", terminalBatchWhere),
    captureBatchBytes: sum("capture_batches", "bundle_json"),
    terminalCaptureBytes: sum("capture_inbox", "bundle_json", terminalCaptureWhere),
    modelJobs: count("model_jobs"),
    terminalModelJobs: count("model_jobs", terminalJobWhere),
    rawInputBytes: sum("model_jobs", "raw_input_json", "raw_input_json IS NOT NULL"),
    debugEventsBytes: sum("model_jobs", "debug_events_json", "debug_events_json IS NOT NULL"),
  };
}

/**
 * Create a consistent backup using SQLite itself. A filesystem copy is not
 * sufficient while WAL is enabled because it can miss committed WAL pages.
 */
export function createRecallDatabaseBackup(db: DB, databasePath: string, backupPath?: string): string {
  const resolvedBackupPath = backupPath ?? defaultBackupPath(databasePath);
  if (path.resolve(resolvedBackupPath) === path.resolve(databasePath)) {
    throw new Error("数据库备份路径不能覆盖原数据库");
  }
  if (fs.existsSync(resolvedBackupPath)) {
    throw new Error(`备份文件已存在，为避免覆盖请指定其他路径: ${resolvedBackupPath}`);
  }
  fs.mkdirSync(path.dirname(resolvedBackupPath), { recursive: true });
  const escapedPath = resolvedBackupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  return resolvedBackupPath;
}

export function runRecallDataMaintenance(
  db: DB,
  databasePath: string | undefined,
  options: RecallDataMaintenanceOptions
): RecallDataMaintenanceResult {
  const before = getRecallDataSnapshot(db, databasePath);
  if (!options.apply) {
    return {
      applied: false,
      vacuumed: false,
      backupPath: null,
      before,
      after: before,
      compaction: null,
      clearedDebugRows: 0,
      clearedDebugBytes: 0,
    };
  }

  if (!databasePath) {
    throw new Error("apply 模式必须提供数据库路径，以便先创建一致性备份");
  }
  const backupPath = createRecallDatabaseBackup(db, databasePath, options.backupPath);
  const captureRepo = new CaptureInboxRepository(db);
  const debugBefore = db.prepare(
    `SELECT
       COUNT(*) AS rows,
       COALESCE(SUM(length(raw_input_json)), 0) + COALESCE(SUM(length(debug_events_json)), 0) AS bytes
     FROM model_jobs WHERE status IN ('succeeded', 'failed')`
  ).get() as { rows: number; bytes: number };
  const compaction = captureRepo.compactTerminalPayloads();
  const clearedDebugRows = db.prepare(
    `UPDATE model_jobs
     SET raw_input_json = NULL, debug_events_json = NULL
     WHERE status IN ('succeeded', 'failed')`
  ).run().changes;
  if (options.vacuum) db.exec("VACUUM");
  const after = getRecallDataSnapshot(db, databasePath);
  return {
    applied: true,
    vacuumed: options.vacuum === true,
    backupPath,
    before,
    after,
    compaction,
    clearedDebugRows,
    clearedDebugBytes: debugBefore.bytes,
  };
}

function defaultBackupPath(databasePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${databasePath}.pre-maintenance.${stamp}.bak`;
}
