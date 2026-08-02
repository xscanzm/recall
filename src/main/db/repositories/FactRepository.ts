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

/**
 * DB 行类型
 *
 * V2 字段（008 迁移新增，均可空）：
 * - display_use（JSON 数组存 TEXT）/ reportable（INTEGER 0/1）/ private_risk / user_value
 */
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
  // 008 V2 字段
  display_use: string | null;
  reportable: number | null;
  private_risk: string | null;
  user_value: string | null;
  // 011 新增
  people_hints_json: string | null;
  source_episode_ids_json: string;
  claim_status: string;
  generation_path: string | null;
  generation_version: number;
  derivation_key: string | null;
}

export class FactRepository {
  constructor(private db: DB) {}

  /**
   * 创建 fact
   *
   * V2 字段（displayUse / reportable / privateRisk / userValue）来自 008 迁移，均可空。
   * - displayUse：JSON 数组以 TEXT 存储
   * - reportable：boolean 以 INTEGER 0/1 存储
   * V1 写入路径不传这些字段时落库为 NULL。
   */
  create(input: CreateFactInput): Fact {
    if (input.derivationKey) {
      const existing = this.getByDerivationKey(input.derivationKey);
      if (existing) return existing;
    }
    const id = input.id ?? generateId("fact");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO facts (
          id, type, content, status, project_id, project_hint,
          importance, confidence, inferred, evidence_text,
          source_observation_ids_json, tags_json,
          created_at, updated_at,
          display_use, reportable, private_risk, user_value,
          people_hints_json, source_episode_ids_json, claim_status,
          generation_path, generation_version, derivation_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now,
        input.displayUse ? JSON.stringify(input.displayUse) : null,
        input.reportable === undefined ? null : input.reportable ? 1 : 0,
        input.privateRisk ?? null,
        input.userValue ?? null,
        // 011 新增：peopleHints 入库
        input.peopleHints && input.peopleHints.length > 0
          ? JSON.stringify(input.peopleHints)
          : null,
        JSON.stringify(input.sourceEpisodeIds ?? []),
        input.claimStatus ?? "active",
        input.generationPath ?? null,
        input.generationVersion ?? 1,
        input.derivationKey ?? null
      );

    return this.getById(id)!;
  }

  getByDerivationKey(key: string): Fact | null {
    const row = this.db.prepare("SELECT * FROM facts WHERE derivation_key = ?").get(key) as FactRow | undefined;
    return row ? mapRow(row) : null;
  }

  listBySourceEpisodeIds(episodeIds: string[]): Fact[] {
    return this.listByJsonSourceIds("source_episode_ids_json", episodeIds);
  }

  /**
   * Query active facts linked to any of the supplied observations.
   * Inputs are chunked to stay below SQLite's host-parameter limit.
   */
  listBySourceObservationIds(observationIds: string[]): Fact[] {
    return this.listByJsonSourceIds("source_observation_ids_json", observationIds);
  }

  listByCreatedAt(opts: {
    from?: string;
    to?: string;
    includeDeleted?: boolean;
    limit?: number;
    order?: "asc" | "desc";
  } = {}): Fact[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      conditions.push("created_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push("created_at < ?");
      params.push(opts.to);
    }
    if (!opts.includeDeleted) conditions.push("deleted_at IS NULL");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = opts.order === "desc" ? "DESC" : "ASC";
    const rows = this.db
      .prepare(`SELECT * FROM facts ${where} ORDER BY created_at ${order} LIMIT ?`)
      .all(...params, opts.limit ?? 100) as FactRow[];
    return rows.map(mapRow);
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
    const uniqueIds = [...new Set(ids)];
    const rows = chunkValues(uniqueIds).flatMap((chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.db
        .prepare(
          `SELECT * FROM facts WHERE id IN (${placeholders}) AND deleted_at IS NULL`
        )
        .all(...chunk) as FactRow[];
    });
    const facts = rows.map(mapRow);
    // 按输入 ids 顺序排序（找不到的 id 跳过）
    const byId = new Map(facts.map((f) => [f.id, f]));
    return ids
      .map((id) => byId.get(id))
      .filter((f): f is Fact => f !== undefined);
  }

  private listByJsonSourceIds(
    column: "source_episode_ids_json" | "source_observation_ids_json",
    ids: string[]
  ): Fact[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];

    const factsById = new Map<string, Fact>();
    for (const chunk of chunkValues(uniqueIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(`SELECT * FROM facts WHERE deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM json_each(facts.${column})
        WHERE json_each.value IN (${placeholders})
      ) ORDER BY created_at ASC`).all(...chunk) as FactRow[];
      for (const row of rows) {
        const fact = mapRow(row);
        factsById.set(fact.id, fact);
      }
    }
    return [...factsById.values()].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    );
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
   * 012 新增：按 project_hint 精确查询
   * - 用于 mergeObjects 改写：找出 projectHint == from.name 的 facts，把它们重写为 to.name
   * - 仅未删除
   */
  listByProjectHintExact(
    projectHint: string,
    opts: { includeDeleted?: boolean; limit?: number } = {}
  ): Fact[] {
    const conditions = ["project_hint = ?"];
    const params: unknown[] = [projectHint];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const limit = opts.limit ?? 1000;
    const rows = this.db
      .prepare(
        `SELECT * FROM facts WHERE ${conditions.join(" AND ")} LIMIT ?`
      )
      .all(...params, limit) as FactRow[];
    return rows.map(mapRow);
  }

  /**
   * 012 新增：批量改写 fact.project_hint（用于项目/人物合并）
   * - 把所有 projectHint == fromHint 的 fact 的 projectHint 改为 toHint
   * - 同时如果 fact.projectId == fromId 则改为 toId（仅 project 类型合并时调用）
   * - 不修改其他字段
   * @returns 实际改写的 fact 数量
   */
  rewriteProjectHintBatch(opts: {
    fromHint: string;
    toHint: string;
    fromId?: string; // 可选；同时改写 project_id
    toId?: string;   // 可选；同时改写 project_id
  }): number {
    if (opts.fromHint === opts.toHint && (!opts.fromId || !opts.toId)) {
      return 0;
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.fromHint !== opts.toHint) {
      conditions.push("project_hint = ?");
      params.push(opts.fromHint);
    }
    if (opts.fromId && opts.toId && opts.fromId !== opts.toId) {
      conditions.push("project_id = ?");
      params.push(opts.fromId);
    }
    if (conditions.length === 0) return 0;
    const sets: string[] = [];
    if (opts.fromHint !== opts.toHint) {
      sets.push("project_hint = ?");
    }
    if (opts.fromId && opts.toId && opts.fromId !== opts.toId) {
      sets.push("project_id = ?");
    }
    sets.push("updated_at = ?");
    // WHERE 子句占位符按 conditions 顺序收集，SET 子句占位符按 sets 顺序收集
    // SQL 拼接顺序：SET ... WHERE (cond1 OR cond2)
    // 因此实际绑定顺序为：SET params + WHERE params
    const updateParams: unknown[] = [];
    if (opts.fromHint !== opts.toHint) updateParams.push(opts.toHint);
    if (opts.fromId && opts.toId && opts.fromId !== opts.toId) updateParams.push(opts.toId);
    updateParams.push(new Date().toISOString());
    // 追加 WHERE 子句对应的参数（conditions 顺序）
    updateParams.push(...params);
    const whereAnd = conditions.length > 0 ? `(${conditions.join(" OR ")})` : "";
    const stmt = this.db.prepare(
      `UPDATE facts SET ${sets.join(", ")} WHERE ${whereAnd}`
    );
    const result = stmt.run(...updateParams);
    return result.changes;
  }

  /**
   * 012 新增：批量改写 fact.people_hints_json 中的某个名字
   * - 遍历 people_hints_json 数组，把 fromName 替换为 toName（去重 + 不重复 toName）
   * - 仅当 fromName 真正存在数组中时才更新
   * - 用于人物合并：把历史 facts 的 people_hints 中 from.name → to.name
   * @returns 实际改写的 fact 数量
   */
  rewritePeopleHintBatch(fromName: string, toName: string): number {
    if (fromName === toName) return 0;
    // 找出包含 fromName 的所有 fact（people_hints_json 中含 fromName）
    const rows = this.db
      .prepare(
        `SELECT id, people_hints_json FROM facts
         WHERE people_hints_json IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(facts.people_hints_json)
           WHERE json_each.value = ?
         )`
      )
      .all(fromName) as Array<{ id: string; people_hints_json: string }>;
    if (rows.length === 0) return 0;
    const updateStmt = this.db.prepare(
      `UPDATE facts SET people_hints_json = ?, updated_at = ? WHERE id = ?`
    );
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        let arr: string[] = [];
        try {
          const parsed = JSON.parse(row.people_hints_json);
          if (Array.isArray(parsed)) arr = parsed.map((v) => String(v));
        } catch {
          continue;
        }
        const newHints: string[] = [];
        const seen = new Set<string>();
        for (const name of arr) {
          const newName = name === fromName ? toName : name;
          if (!seen.has(newName)) {
            seen.add(newName);
            newHints.push(newName);
          }
        }
        updateStmt.run(JSON.stringify(newHints), new Date().toISOString(), row.id);
      }
    });
    txn();
    return rows.length;
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
   * 按时间范围查询（debug 页用，含已删除记录，不分页）
   * - 时间字段：created_at
   * - 不做软删除过滤（debug 查询需要看到所有记录包括已删除的）
   */
  listByTimeRange(startAt: string, endAt: string, limit: number = 200): Fact[] {
    const stmt = this.db.prepare(
      `SELECT * FROM facts WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`
    );
    const rows = stmt.all(startAt, endAt, Math.max(1, Math.floor(limit))) as FactRow[];
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
    // 008 V2 字段
    if (patch.displayUse !== undefined) {
      sets.push("display_use = ?");
      params.push(patch.displayUse ? JSON.stringify(patch.displayUse) : null);
    }
    if (patch.reportable !== undefined) {
      sets.push("reportable = ?");
      params.push(patch.reportable ? 1 : 0);
    }
    if (patch.privateRisk !== undefined) {
      sets.push("private_risk = ?");
      params.push(patch.privateRisk ?? null);
    }
    if (patch.userValue !== undefined) {
      sets.push("user_value = ?");
      params.push(patch.userValue ?? null);
    }
    // 011 新增：peopleHints 字段更新
    if (patch.peopleHints !== undefined) {
      sets.push("people_hints_json = ?");
      params.push(
        patch.peopleHints && patch.peopleHints.length > 0
          ? JSON.stringify(patch.peopleHints)
          : null
      );
    }
    if (patch.claimStatus !== undefined) {
      sets.push("claim_status = ?");
      params.push(patch.claimStatus);
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
        created_at, updated_at,
        display_use, reportable, private_risk, user_value,
        people_hints_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now,
          input.displayUse ? JSON.stringify(input.displayUse) : null,
          input.reportable === undefined ? null : input.reportable ? 1 : 0,
          input.privateRisk ?? null,
          input.userValue ?? null,
          // 011 新增
          input.peopleHints && input.peopleHints.length > 0
            ? JSON.stringify(input.peopleHints)
            : null
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
    // 008 V2 字段（null-safe）
    displayUse: row.display_use ? safeParseArray<string>(row.display_use) : null,
    reportable: row.reportable === null ? null : row.reportable === 1,
    privateRisk: (row.private_risk as Fact["privateRisk"]) ?? null,
    userValue: (row.user_value as Fact["userValue"]) ?? null,
    // 011 新增
    peopleHints: row.people_hints_json
      ? safeParseArray<string>(row.people_hints_json)
      : null,
    sourceEpisodeIds: safeParseArray<string>(row.source_episode_ids_json),
    claimStatus: row.claim_status as Fact["claimStatus"],
    generationPath: row.generation_path,
    generationVersion: row.generation_version,
    derivationKey: row.derivation_key,
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

const SQLITE_QUERY_CHUNK_SIZE = 500;

function chunkValues<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += SQLITE_QUERY_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + SQLITE_QUERY_CHUNK_SIZE));
  }
  return chunks;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
