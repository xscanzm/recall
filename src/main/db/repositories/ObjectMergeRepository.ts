// src/main/db/repositories/ObjectMergeRepository.ts
// 012 新增：object_merges 审计表数据访问
//
// 用途：
// - 记录每次 mergeObjects 的 from/to/source/reason
// - 记录被改写的 fact 和 scene 数量（rewrittenFactsCount / rewrittenScenesCount）
// - 仅用于审计和追溯，不参与业务逻辑查询
//
// 重要约束：
// - 与 MemoryObjectRepository 不同，本表是 append-only（不更新 / 不删除）
// - mergeObjects 后立即写入（事务内），避免漏审计

import type { DB } from "../Database";
import type { ObjectMerge } from "../../models/types";

/**
 * DB 行类型
 */
interface ObjectMergeRow {
  id: string;
  object_type: string;
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  source: string;
  reason: string | null;
  rewritten_facts_count: number;
  rewritten_scenes_count: number;
  created_at: string;
}

/**
 * 创建 object_merge 输入
 */
export type CreateObjectMergeInput = Omit<ObjectMerge, "id" | "createdAt"> & {
  id?: string;
};

export class ObjectMergeRepository {
  constructor(private db: DB) {}

  /**
   * 写入一条合并审计
   * - append-only
   * - 失败抛错（不允许静默漏审计）
   */
  create(input: CreateObjectMergeInput): ObjectMerge {
    const id = input.id ?? generateId("merge");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO object_merges (
          id, object_type, from_id, from_name, to_id, to_name,
          source, reason, rewritten_facts_count, rewritten_scenes_count,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.objectType,
        input.fromId,
        input.fromName,
        input.toId,
        input.toName,
        input.source,
        input.reason,
        input.rewrittenFactsCount,
        input.rewrittenScenesCount,
        now
      );
    return this.getById(id)!;
  }

  /**
   * 按 id 查询
   */
  getById(id: string): ObjectMerge | null {
    const row = this.db
      .prepare("SELECT * FROM object_merges WHERE id = ?")
      .get(id) as ObjectMergeRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 toId 查询（找出所有合并到该对象的审计记录）
   */
  listByToId(toId: string, opts: { limit?: number } = {}): ObjectMerge[] {
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(
        `SELECT * FROM object_merges WHERE to_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(toId, limit) as ObjectMergeRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 objectType 列出最近的合并
   * - 用于前端"我合并过哪些"展示
   */
  listRecent(opts: {
    objectType?: "project" | "task" | "person" | "decision";
    limit?: number;
  } = {}): ObjectMerge[] {
    const limit = opts.limit ?? 100;
    if (opts.objectType) {
      const rows = this.db
        .prepare(
          `SELECT * FROM object_merges WHERE object_type = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(opts.objectType, limit) as ObjectMergeRow[];
      return rows.map(mapRow);
    }
    const rows = this.db
      .prepare(`SELECT * FROM object_merges ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ObjectMergeRow[];
    return rows.map(mapRow);
  }

  /**
   * 统计
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM object_merges")
      .get() as { cnt: number };
    return row.cnt;
  }
}

export function createObjectMergeRepository(db: DB): ObjectMergeRepository {
  return new ObjectMergeRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: ObjectMergeRow): ObjectMerge {
  return {
    id: row.id,
    objectType: row.object_type as ObjectMerge["objectType"],
    fromId: row.from_id,
    fromName: row.from_name,
    toId: row.to_id,
    toName: row.to_name,
    source: row.source as ObjectMerge["source"],
    reason: row.reason,
    rewrittenFactsCount: row.rewritten_facts_count,
    rewrittenScenesCount: row.rewritten_scenes_count,
    createdAt: row.created_at,
  };
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
