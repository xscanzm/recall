// src/main/db/repositories/UnfinishedThreadRepository.ts
// unfinished_threads 表数据访问（Phase 2 Task 2.7）
//
// 表结构（006 迁移）：
// - id TEXT PRIMARY KEY
// - title TEXT NOT NULL
// - reason TEXT NOT NULL
// - suggested_next_action TEXT NOT NULL
// - priority TEXT NOT NULL DEFAULT 'medium'（枚举：high/medium/low）
// - project_name TEXT（可空）
// - last_seen_at TEXT（可空）
// - source_fact_ids_json TEXT NOT NULL DEFAULT '[]'
// - source_timeline_block_ids_json TEXT NOT NULL DEFAULT '[]'
// - confidence REAL NOT NULL DEFAULT 0.5
// - status TEXT NOT NULL DEFAULT 'open'（open/done/snoozed/ignored）
// - date_key TEXT NOT NULL
// - created_at TEXT NOT NULL
// - updated_at TEXT NOT NULL
//
// 索引：idx_unfinished_threads_date_key / idx_unfinished_threads_status
//
// 用途（doc 20 第 6 节）：
// - Judge worker V2 输出的 unfinishedThreads 持久化到此表
// - 同一 date_key 重复生成时先删除旧 threads 再写入新 threads（upsertMany）
// - 今日页 / 复盘页可通过 findByDateKey 查询当天待收尾
// - 用户可通过 updateStatus 标记为 done / snoozed / ignored

import type { DB } from "../Database";
import type { UnfinishedThread } from "../../../shared/types";

/**
 * DB 行类型（JSON 字段为 string，boolean 用 number）
 */
interface UnfinishedThreadRow {
  id: string;
  title: string;
  reason: string;
  suggested_next_action: string;
  priority: string;
  project_name: string | null;
  last_seen_at: string | null;
  source_fact_ids_json: string;
  source_timeline_block_ids_json: string;
  confidence: number;
  status: string;
  date_key: string;
  created_at: string;
  updated_at: string;
}

/**
 * 创建 unfinished_thread 输入
 *
 * 与 UnfinishedThread 区别：
 * - id 可选（未提供时自动生成）
 * - createdAt / updatedAt 由 Repository 填充
 * - dateKey 是 DB 级字段，不在 UnfinishedThread 类型中
 */
export type CreateUnfinishedThreadInput = Omit<
  UnfinishedThread,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
};

/**
 * UnfinishedThread 状态
 */
export type UnfinishedThreadStatus = "open" | "done" | "snoozed" | "ignored";

/**
 * priority 排序映射（high > medium > low）
 *
 * SQLite ORDER BY 时用 CASE 把枚举映射为数值。
 */
const PRIORITY_ORDER_CASE =
  "CASE priority " +
  "WHEN 'high' THEN 0 " +
  "WHEN 'medium' THEN 1 " +
  "WHEN 'low' THEN 2 " +
  "ELSE 3 END";

export class UnfinishedThreadRepository {
  constructor(private db: DB) {}

  list(opts: { limit?: number; offset?: number } = {}): UnfinishedThread[] {
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM unfinished_threads ORDER BY date_key DESC, ${PRIORITY_ORDER_CASE}, created_at ASC LIMIT ? OFFSET ?`
      )
      .all(limit, offset) as UnfinishedThreadRow[];
    return rows.map(mapRow);
  }

  /**
   * 批量 upsert（同 date_key 替换：先删除当天所有，再插入新的）
   *
   * 实现策略：事务内
   *   1. DELETE FROM unfinished_threads WHERE date_key = ?
   *   2. INSERT 全部新 threads
   *
   * 与 TimelineBlockRepository.upsertMany 一致。
   * thread.id 若未提供则自动生成；createdAt/updatedAt 由本方法统一填充。
   *
   * @returns 已写入的 UnfinishedThread 数组（含生成的 id 和时间戳）
   */
  upsertMany(dateKey: string, threads: CreateUnfinishedThreadInput[]): UnfinishedThread[] {
    const now = new Date().toISOString();
    const deleteStmt = this.db.prepare(
      "DELETE FROM unfinished_threads WHERE date_key = ?"
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO unfinished_threads (
        id, title, reason, suggested_next_action, priority,
        project_name, last_seen_at,
        source_fact_ids_json, source_timeline_block_ids_json,
        confidence, status, date_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const written: UnfinishedThread[] = [];

    const txn = this.db.transaction(() => {
      deleteStmt.run(dateKey);
      for (const thread of threads) {
        const id = thread.id ?? generateId("ut");
        insertStmt.run(
          id,
          thread.title,
          thread.reason,
          thread.suggestedNextAction,
          thread.priority,
          thread.projectName ?? null,
          thread.lastSeenAt ?? now,
          JSON.stringify(thread.sourceFactIds),
          JSON.stringify(thread.sourceTimelineBlockIds),
          thread.confidence,
          thread.status,
          dateKey,
          now,
          now
        );
        written.push({
          id,
          title: thread.title,
          reason: thread.reason,
          suggestedNextAction: thread.suggestedNextAction,
          priority: thread.priority,
          projectName: thread.projectName,
          lastSeenAt: thread.lastSeenAt ?? now,
          sourceFactIds: thread.sourceFactIds,
          sourceTimelineBlockIds: thread.sourceTimelineBlockIds,
          confidence: thread.confidence,
          status: thread.status,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

    txn();
    return written;
  }

  /**
   * 按 date_key 查询，按 priority 排序（high > medium > low）
   */
  findByDateKey(dateKey: string): UnfinishedThread[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unfinished_threads WHERE date_key = ? ORDER BY ${PRIORITY_ORDER_CASE}, created_at ASC`
      )
      .all(dateKey) as UnfinishedThreadRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 status 查询，按 priority 排序
   */
  findByStatus(status: string): UnfinishedThread[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unfinished_threads WHERE status = ? ORDER BY ${PRIORITY_ORDER_CASE}, created_at ASC`
      )
      .all(status) as UnfinishedThreadRow[];
    return rows.map(mapRow);
  }

  findByDateKeyAndStatus(dateKey: string, status: string): UnfinishedThread[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM unfinished_threads WHERE date_key = ? AND status = ? ORDER BY ${PRIORITY_ORDER_CASE}, created_at ASC`
      )
      .all(dateKey, status) as UnfinishedThreadRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 id 查询
   */
  findById(id: string): UnfinishedThread | null {
    const row = this.db
      .prepare("SELECT * FROM unfinished_threads WHERE id = ?")
      .get(id) as UnfinishedThreadRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 更新状态
   */
  updateStatus(id: string, status: UnfinishedThreadStatus): UnfinishedThread | null {
    this.db
      .prepare(
        "UPDATE unfinished_threads SET status = ?, updated_at = ? WHERE id = ?"
      )
      .run(status, new Date().toISOString(), id);
    return this.findById(id);
  }

  /**
   * 统计
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM unfinished_threads")
      .get() as { cnt: number };
    return row.cnt;
  }
}

export function createUnfinishedThreadRepository(db: DB): UnfinishedThreadRepository {
  return new UnfinishedThreadRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: UnfinishedThreadRow): UnfinishedThread {
  return {
    id: row.id,
    title: row.title,
    reason: row.reason,
    suggestedNextAction: row.suggested_next_action,
    priority: row.priority as "high" | "medium" | "low",
    projectName: row.project_name ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    sourceTimelineBlockIds: safeParseArray(row.source_timeline_block_ids_json),
    confidence: row.confidence,
    status: row.status as UnfinishedThread["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseArray<T = unknown>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
