// src/main/db/repositories/SceneRepository.ts
// Scene（L2）数据访问
//
// 表结构：scenes
// 索引：idx_scenes_start_at
//
// JSON 字段：fact_ids_json, observation_ids_json, entity_names_json
// soft delete：deleted_at 字段

import type { DB } from "../Database";
import type { Scene, CreateSceneInput } from "../../models/types";
import { getLocalTodayStartIso } from "./_helpers";

interface SceneRow {
  id: string;
  title: string;
  summary: string;
  start_at: string;
  end_at: string;
  project_id: string | null;
  confidence: number;
  activity_category: Scene["activityCategory"];
  activity_confidence: number;
  fact_ids_json: string;
  observation_ids_json: string;
  entity_names_json: string;
  task_ids_json: string;
  decision_ids_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  derivation_key: string | null;
  derivation_version: number;
}

export interface MinimalScene {
  id: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  activityCategory: Scene["activityCategory"];
  activityConfidence: number;
  factIds: string[];
  observationIds: string[];
}

export class SceneRepository {
  constructor(private db: DB) {}

  /**
   * 创建 scene
   */
  create(input: CreateSceneInput): Scene {
    if (input.derivationKey) {
      const existing = this.getByDerivationKey(input.derivationKey);
      if (existing) return existing;
    }
    const id = input.id ?? generateId("scene");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO scenes (
          id, title, summary, start_at, end_at, project_id,
          confidence, activity_category, activity_confidence,
          fact_ids_json, observation_ids_json, entity_names_json,
          task_ids_json, decision_ids_json,
          created_at, updated_at, derivation_key, derivation_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.summary,
        input.startAt,
        input.endAt,
        input.projectId,
        input.confidence,
        input.activityCategory ?? "unknown",
        input.activityConfidence ?? 0,
        JSON.stringify(input.factIds),
        JSON.stringify(input.observationIds),
        JSON.stringify(input.entityNames),
        JSON.stringify(input.taskIds ?? []),
        JSON.stringify(input.decisionIds ?? []),
        now,
        now,
        input.derivationKey ?? null,
        input.derivationVersion ?? 1
      );

    return this.getById(id)!;
  }

  getByDerivationKey(key: string): Scene | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE derivation_key = ?").get(key) as SceneRow | undefined;
    return row ? mapRow(row) : null;
  }

  listByIds(ids: string[]): Scene[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM scenes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as SceneRow[];
    const byId = new Map(rows.map((row) => [row.id, mapRow(row)]));
    return ids.map((id) => byId.get(id)).filter((scene): scene is Scene => !!scene);
  }

  listByFactId(factId: string): Scene[] {
    const rows = this.db.prepare(`SELECT * FROM scenes WHERE EXISTS (
      SELECT 1 FROM json_each(scenes.fact_ids_json) WHERE json_each.value = ?
    ) ORDER BY start_at ASC`).all(factId) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 id 查询（含已删除）
   */
  getById(id: string): Scene | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as
      | SceneRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 id 查询（仅未删除）
   */
  getByIdActive(id: string): Scene | null {
    const row = this.db
      .prepare("SELECT * FROM scenes WHERE id = ? AND deleted_at IS NULL")
      .get(id) as SceneRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按时间范围查询（含未删除过滤）
   */
  listByStartAt(opts: {
    from?: string;
    to?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  } = {}): Scene[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      conditions.push("start_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push("start_at < ?");
      params.push(opts.to);
    }
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(`SELECT * FROM scenes ${where} ORDER BY start_at ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 按时间范围查询轻量字段（专供 Today 概览使用，无 1000 限制）
   */
  listByStartAtMinimal(opts: {
    from?: string;
    to?: string;
    includeDeleted?: boolean;
    limit?: number;
    order?: "asc" | "desc";
  } = {}): MinimalScene[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      conditions.push("start_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push("start_at <= ?");
      params.push(opts.to);
    }
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const limitClause = typeof opts.limit === "number" && opts.limit > 0 ? `LIMIT ${opts.limit}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, title, summary, start_at, end_at, project_id, activity_category, activity_confidence, fact_ids_json, observation_ids_json FROM scenes ${where} ORDER BY start_at ${order} ${limitClause}`
      )
      .all(...params) as Array<{
        id: string;
        title: string;
        summary: string;
        start_at: string;
        end_at: string;
        project_id: string | null;
        activity_category: Scene["activityCategory"];
        activity_confidence: number;
        fact_ids_json: string;
        observation_ids_json: string;
      }>;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      startAt: row.start_at,
      endAt: row.end_at,
      projectId: row.project_id,
      activityCategory: row.activity_category ?? "unknown",
      activityConfidence: row.activity_confidence ?? 0,
      factIds: safeParseArray<string>(row.fact_ids_json),
      observationIds: safeParseArray<string>(row.observation_ids_json),
    }));
  }

  /**
   * 按时间范围查询（debug 页用，含已删除记录，不分页）
   * - 时间字段：start_at
   * - 不做软删除过滤（debug 查询需要看到所有记录包括已删除的）
   */
  listByTimeRange(startAt: string, endAt: string): Scene[] {
    const stmt = this.db.prepare(
      "SELECT * FROM scenes WHERE start_at >= ? AND start_at <= ? ORDER BY start_at DESC"
    );
    const rows = stmt.all(startAt, endAt) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 按 project_id 查询
   */
  listByProjectId(
    projectId: string,
    opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
  ): Scene[] {
    const conditions = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM scenes WHERE ${conditions.join(" AND ")} ORDER BY start_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 012 新增：按 entity_name 精确查询（存在于 entity_names_json 数组中）
   * - 用于 mergeObjects 改写：找出 entityNames 包含 from.name 的 scenes
   * - 仅未删除
   */
  listByEntityNameExact(
    entityName: string,
    opts: { includeDeleted?: boolean; limit?: number } = {}
  ): Scene[] {
    const conditions: string[] = [
      `EXISTS (SELECT 1 FROM json_each(scenes.entity_names_json) WHERE json_each.value = ?)`,
    ];
    const params: unknown[] = [entityName];
    if (!opts.includeDeleted) {
      conditions.push("deleted_at IS NULL");
    }
    const limit = opts.limit ?? 1000;
    const rows = this.db
      .prepare(
        `SELECT * FROM scenes WHERE ${conditions.join(" AND ")} ORDER BY start_at DESC LIMIT ?`
      )
      .all(...params, limit) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 012 新增：批量改写 scene.entityNames 中的某个名字
   * - 遍历 entity_names_json 数组，把 fromName 替换为 toName（去重 + 不重复 toName）
   * - 仅当 fromName 真正存在数组中时才更新
   * @returns 实际改写的 scene 数量
   */
  rewriteEntityNameBatch(fromName: string, toName: string): number {
    if (fromName === toName) return 0;
    const candidates = this.listByEntityNameExact(fromName, { limit: 1000 });
    if (candidates.length === 0) return 0;
    const updateStmt = this.db.prepare(
      `UPDATE scenes SET entity_names_json = ?, updated_at = ? WHERE id = ?`
    );
    const txn = this.db.transaction(() => {
      for (const scene of candidates) {
        const newNames: string[] = [];
        const seen = new Set<string>();
        for (const name of scene.entityNames) {
          let newName = name;
          if (name === fromName) newName = toName;
          if (!seen.has(newName)) {
            seen.add(newName);
            newNames.push(newName);
          }
        }
        updateStmt.run(JSON.stringify(newNames), new Date().toISOString(), scene.id);
      }
    });
    txn();
    return candidates.length;
  }

  /**
   * 查询今日 scene
   */
  listToday(): Scene[] {
    const from = getLocalTodayStartIso();
    return this.listByStartAt({ from });
  }

  /**
   * 关键词搜索（SQL LIKE）
   */
  searchByKeyword(keyword: string, limit: number = 100): Scene[] {
    const likePattern = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM scenes WHERE (title LIKE ? OR summary LIKE ?) AND deleted_at IS NULL ORDER BY start_at DESC LIMIT ?`
      )
      .all(likePattern, likePattern, limit) as SceneRow[];
    return rows.map(mapRow);
  }

  /**
   * 更新 scene
   */
  update(
    id: string,
    patch: Partial<Omit<Scene, "id" | "createdAt" | "updatedAt" | "deletedAt">>
  ): Scene | null {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title);
    }
    if (patch.summary !== undefined) {
      sets.push("summary = ?");
      params.push(patch.summary);
    }
    if (patch.startAt !== undefined) {
      sets.push("start_at = ?");
      params.push(patch.startAt);
    }
    if (patch.endAt !== undefined) {
      sets.push("end_at = ?");
      params.push(patch.endAt);
    }
    if (patch.projectId !== undefined) {
      sets.push("project_id = ?");
      params.push(patch.projectId);
    }
    if (patch.confidence !== undefined) {
      sets.push("confidence = ?");
      params.push(patch.confidence);
    }
    if (patch.activityCategory !== undefined) {
      sets.push("activity_category = ?");
      params.push(patch.activityCategory);
    }
    if (patch.activityConfidence !== undefined) {
      sets.push("activity_confidence = ?");
      params.push(patch.activityConfidence);
    }
    if (patch.factIds !== undefined) {
      sets.push("fact_ids_json = ?");
      params.push(JSON.stringify(patch.factIds));
    }
    if (patch.observationIds !== undefined) {
      sets.push("observation_ids_json = ?");
      params.push(JSON.stringify(patch.observationIds));
    }
    if (patch.entityNames !== undefined) {
      sets.push("entity_names_json = ?");
      params.push(JSON.stringify(patch.entityNames));
    }
    if (patch.taskIds !== undefined) {
      sets.push("task_ids_json = ?");
      params.push(JSON.stringify(patch.taskIds));
    }
    if (patch.decisionIds !== undefined) {
      sets.push("decision_ids_json = ?");
      params.push(JSON.stringify(patch.decisionIds));
    }

    if (sets.length === 0) {
      return this.getById(id);
    }

    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    this.db
      .prepare(`UPDATE scenes SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  }

  /**
   * soft delete
   */
  softDelete(id: string): boolean {
    const result = this.db
      .prepare("UPDATE scenes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  softDeleteByObservationIds(observationIds: string[]): Scene[] {
    if (observationIds.length === 0) return [];
    const now = new Date().toISOString();
    const selectStmt = this.db.prepare(
      `SELECT * FROM scenes WHERE deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM json_each(scenes.observation_ids_json)
        WHERE json_each.value IN (${observationIds.map(() => "?").join(", ")})
      )`
    );
    const rows = selectStmt.all(...observationIds) as SceneRow[];
    const toDelete = rows.map(mapRow);
    if (toDelete.length === 0) return [];

    const updateStmt = this.db.prepare(
      `UPDATE scenes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
    );
    const txn = this.db.transaction(() => {
      for (const scene of toDelete) {
        updateStmt.run(now, now, scene.id);
      }
    });
    txn();
    return toDelete;
  }

  restore(id: string): boolean {
    const result = this.db
      .prepare("UPDATE scenes SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return result.changes > 0;
  }

  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM scenes WHERE id = ?").run(id);
    return result.changes > 0;
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM scenes WHERE deleted_at IS NULL")
      .get() as { cnt: number };
    return row.cnt;
  }
}

export function createSceneRepository(db: DB): SceneRepository {
  return new SceneRepository(db);
}

function mapRow(row: SceneRow): Scene {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    startAt: row.start_at,
    endAt: row.end_at,
    projectId: row.project_id,
    confidence: row.confidence,
    activityCategory: row.activity_category ?? "unknown",
    activityConfidence: row.activity_confidence ?? 0,
    factIds: safeParseArray(row.fact_ids_json),
    observationIds: safeParseArray(row.observation_ids_json),
    entityNames: safeParseArray(row.entity_names_json),
    taskIds: safeParseArray(row.task_ids_json),
    decisionIds: safeParseArray(row.decision_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    derivationKey: row.derivation_key,
    derivationVersion: row.derivation_version,
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
