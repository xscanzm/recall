// src/main/db/repositories/FactRepository.ts
// Fact（L1）数据访问
//
// 表结构：facts
// 索引：idx_facts_type_created_at, idx_facts_project_id
//
// JSON 字段：source_observation_ids_json, tags_json
// soft delete：deleted_at 字段

import type { DB } from "../Database";
import type { Fact, CreateFactInput, UpdateFactInput } from "../../models/types";

interface FactRow {
  id: string;
  type: string;
  content: string;
  status: string | null;
  project_id: string | null;
  project_hint: string | null;
  importance: number;
  confidence: number;
  inferred: number;
  evidence_text: string | null;
  source_observation_ids_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export class FactRepository {
  constructor(private db: DB) {}

  /**
   * 创建 fact
   */
  create(input: CreateFactInput): Fact {
    const id = input.id ?? generateId("fact");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO facts (
          id, type, content, status, project_id, project_hint,
          importance, confidence, inferred, evidence_text,
          source_observation_ids_json, tags_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.content,
        input.status,
        input.projectId,
        input.projectHint,
        input.importance,
        input.confidence,
        input.inferred ? 1 : 0,
        input.evidenceText,
        JSON.stringify(input.sourceObservationIds),
        JSON.stringify(input.tags),
        now,
        now
      );

    return this.getById(id)!;
  }

  /**
   * 按 id 查询（含已删除）
   */
  getById(id: string): Fact | null {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as
      | FactRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 id 查询（仅未删除）
   */
  getByIdActive(id: string): Fact | null {
    const row = this.db
      .prepare("SELECT * FROM facts WHERE id = ? AND deleted_at IS NULL")
      .get(id) as FactRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 id 批量查询（仅未删除）
   * - 使用参数化占位符防止 SQL 注入
   * - 空数组返回空数组
   * - 保持输入顺序（通过在结果中按 ids 顺序重新排序）
   */
  listByIds(ids: string[]): Fact[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE id IN (${placeholders}) AND deleted_at IS NULL`
      )
      .all(...ids) as FactRow[];
    const facts = rows.map(mapRow);
    // 按输入 ids 顺序排序（找不到的 id 跳过）
    const byId = new Map(facts.map((f) => [f.id, f]));
    return ids
      .map((id) => byId.get(id))
      .filter((f): f is Fact => f !== undefined);
  }

  /**
   * 按 type 查询
   */
  listByType(
    type: string,
    opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
  ): Fact[] {
    const conditions = ["type = ?"];
    const params: unknown[] = [type];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 project_id 查询
   */
  listByProjectId(
    projectId: string,
    opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
  ): Fact[] {
    const conditions = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 source_observation_ids 查询
   * 使用 SQLite JSON1 扩展（json_each）
   */
  listBySourceObservationId(observationId: string): Fact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE EXISTS (
          SELECT 1 FROM json_each(facts.source_observation_ids_json)
          WHERE json_each.value = ?
        ) AND deleted_at IS NULL ORDER BY created_at DESC`
      )
      .all(observationId) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * 关键词搜索（SQL LIKE）
   * - 搜索 content 字段
   * - 仅未删除
   * - SQLite LIKE 对 ASCII 默认大小写不敏感
   * - 用于 memory:search IPC（避免全量加载后在 JS 端过滤）
   */
  searchByKeyword(keyword: string, limit: number = 100): Fact[] {
    const likePattern = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE content LIKE ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?`
      )
      .all(likePattern, limit) as FactRow[];
    return rows.map((row) => mapRow(row));
  }

  /**
   * 查询全部（含未删除过滤）
   */
  list(opts: {
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Fact[] {
    const conditions: string[] = [];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM facts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * 更新 fact
   */
  update(id: string, patch: UpdateFactInput): Fact | null {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.type !== undefined) {
      sets.push("type = ?");
      params.push(patch.type);
    }
    if (patch.content !== undefined) {
      sets.push("content = ?");
      params.push(patch.content);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.projectId !== undefined) {
      sets.push("project_id = ?");
      params.push(patch.projectId);
    }
    if (patch.projectHint !== undefined) {
      sets.push("project_hint = ?");
      params.push(patch.projectHint);
    }
    if (patch.importance !== undefined) {
      sets.push("importance = ?");
      params.push(patch.importance);
    }
    if (patch.confidence !== undefined) {
      sets.push("confidence = ?");
      params.push(patch.confidence);
    }
    if (patch.inferred !== undefined) {
      sets.push("inferred = ?");
      params.push(patch.inferred ? 1 : 0);
    }
    if (patch.evidenceText !== undefined) {
      sets.push("evidence_text = ?");
      params.push(patch.evidenceText);
    }
    if (patch.sourceObservationIds !== undefined) {
      sets.push("source_observation_ids_json = ?");
      params.push(JSON.stringify(patch.sourceObservationIds));
    }
    if (patch.tags !== undefined) {
      sets.push("tags_json = ?");
      params.push(JSON.stringify(patch.tags));
    }

    if (sets.length === 0) {
      return this.getById(id);
    }

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    this.db
      .prepare(`UPDATE facts SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  /**
   * soft delete（设置 deleted_at）
   */
  softDelete(id: string): boolean {
    const result = this.db
      .prepare("UPDATE facts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * 003 新增：按 source observation ids 批量 soft delete
   * UPDATE facts SET deleted_at=now WHERE source_observation_ids_json 包含任一 observationId
   * 仅 soft delete 未删除的 facts
   *
   * @param observationIds 关联的 observation id 列表
   * @returns 被 soft delete 的 facts 列表（用于后续标记 L3 / reports stale）
   */
  softDeleteBySourceObservationIds(observationIds: string[]): Fact[] {
    if (observationIds.length === 0) return [];
    const now = new Date().toISOString();
    // 先查出将被 soft delete 的 facts（返回前用于触发 stale 标记）
    const selectStmt = this.db.prepare(
      `SELECT * FROM facts WHERE deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM json_each(facts.source_observation_ids_json)
        WHERE json_each.value IN (${observationIds.map(() => "?").join(", ")})
      )`
    );
    const rows = selectStmt.all(...observationIds) as FactRow[];
    const toDelete = rows.map(mapRow);
    if (toDelete.length === 0) return [];

    const updateStmt = this.db.prepare(
      `UPDATE facts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
    );
    const txn = this.db.transaction(() => {
      for (const fact of toDelete) {
        updateStmt.run(now, now, fact.id);
      }
    });
    txn();
    return toDelete;
  }

  /**
   * 恢复 soft delete
   */
  restore(id: string): boolean {
    const result = this.db
      .prepare("UPDATE facts SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * 物理删除
   */
  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * 统计未删除总数
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM facts WHERE deleted_at IS NULL")
      .get() as { cnt: number };
    return row.cnt;
  }

  /**
   * 批量创建 facts（事务包装，来自 06 文档"性能原则"）
   *
   * 性能原则：
   * - SQLite 写入在 main process 串行或事务中处理
   * - 批量写入 facts 时使用 transaction 避免多次 fsync
   *
   * @param inputs 待创建的 fact 输入列表
   * @returns 已创建的 facts 列表（按输入顺序）
   */
  createMany(inputs: CreateFactInput[]): Fact[] {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO facts (
        id, type, content, status, project_id, project_hint,
        importance, confidence, inferred, evidence_text,
        source_observation_ids_json, tags_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const ids: string[] = [];
    const txn = this.db.transaction(() => {
      for (const input of inputs) {
        const id = input.id ?? generateId("fact");
        ids.push(id);
        insert.run(
          id,
          input.type,
          input.content,
          input.status,
          input.projectId,
          input.projectHint,
          input.importance,
          input.confidence,
          input.inferred ? 1 : 0,
          input.evidenceText,
          JSON.stringify(input.sourceObservationIds),
          JSON.stringify(input.tags),
          now,
          now
        );
      }
    });
    txn();
    // 返回已创建的 facts（按 id 顺序）
    return ids
      .map((id) => this.getById(id))
      .filter((f): f is Fact => f !== null);
  }

  /**
   * 在事务中执行多个写操作（来自 06 文档"性能原则"）
   *
   * 用法：
   *   factRepo.runInTransaction(() => {
   *     factRepo.create(...);
   *     factRepo.update(...);
   *   });
   *
   * 性能原则：
   * - SQLite 写入在 main process 串行或事务中处理
   * - 多个相关写入操作应包装在事务中，避免多次 fsync
   */
  runInTransaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }
}

export function createFactRepository(db: DB): FactRepository {
  return new FactRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: FactRow): Fact {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    status: row.status,
    projectId: row.project_id,
    projectHint: row.project_hint,
    importance: row.importance,
    confidence: row.confidence,
    inferred: row.inferred === 1,
    evidenceText: row.evidence_text,
    sourceObservationIds: safeParseArray(row.source_observation_ids_json),
    tags: safeParseArray(row.tags_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
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
