// src/main/db/repositories/MemoryObjectRepository.ts
// L3 Memory Object 数据访问
//
// 涵盖表：
// - projects（项目）
// - tasks（任务）
// - people（人物）
// - decisions（决策）
//
// 索引：idx_tasks_status, idx_projects_status
// soft delete：deleted_at 字段
// JSON 字段：source_fact_ids_json, source_scene_ids_json, related_project_ids_json

import type { DB } from "../Database";
import type { Project, Task, Person, Decision } from "../../models/types";

// ============================================================================
// DB Row 类型
// ============================================================================

interface ProjectRow {
  id: string;
  name: string;
  summary: string;
  status: string;
  last_active_at: string | null;
  source_fact_ids_json: string;
  source_scene_ids_json: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  // 003 字段
  orphan_status: string | null;
  // 012 字段
  aliases_json: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  project_id: string | null;
  summary: string | null;
  due_hint: string | null;
  priority: number;
  confidence: number;
  source_fact_ids_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  // 003 字段
  orphan_status: string | null;
}

interface PersonRow {
  id: string;
  name: string;
  role: string | null;
  organization: string | null;
  summary: string;
  related_project_ids_json: string;
  source_fact_ids_json: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // 012 字段：别名列表（合并过的旧名字）
  aliases_json: string | null;
  // 022 字段：用户与该人物的关系
  relationship: string | null;
}

interface DecisionRow {
  id: string;
  title: string;
  decision: string;
  project_id: string | null;
  rationale: string | null;
  confidence: number;
  source_fact_ids_json: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // 003 字段
  orphan_status: string | null;
}

// ============================================================================
// 输入类型
// ============================================================================

export type CreateProjectInput = Omit<Project, "id" | "createdAt" | "updatedAt" | "archivedAt"> & {
  id?: string;
};

export type CreateTaskInput = Omit<Task, "id" | "createdAt" | "updatedAt" | "completedAt" | "deletedAt"> & {
  id?: string;
};

export type CreatePersonInput = Omit<Person, "id" | "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
};

export type CreateDecisionInput = Omit<Decision, "id" | "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
};

// ============================================================================
// Repository
// ============================================================================

export class MemoryObjectRepository {
  constructor(private db: DB) {}

  // ---------------------- Projects ----------------------

  createProject(input: CreateProjectInput): Project {
    const id = input.id ?? generateId("proj");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, summary, status, last_active_at,
          source_fact_ids_json, source_scene_ids_json,
          created_at, updated_at, aliases_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.summary,
        input.status,
        input.lastActiveAt,
        JSON.stringify(input.sourceFactIds),
        JSON.stringify(input.sourceSceneIds),
        now,
        now,
        input.aliases ? JSON.stringify(input.aliases) : null
      );
    return this.getProjectById(id)!;
  }

  getProjectById(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | ProjectRow
      | undefined;
    return row ? mapProjectRow(row) : null;
  }

  getProjectByIdActive(id: string): Project | null {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ? AND archived_at IS NULL")
      .get(id) as ProjectRow | undefined;
    return row ? mapProjectRow(row) : null;
  }

  /**
   * 按 name 查找 active 项目（硬性去重 fallback）
   * - status='active' 且未归档
   * - ignoreCase=true 时大小写不敏感（LOWER 比较）
   * - 返回最近更新的一个
   */
  findActiveProjectByName(
    name: string,
    opts: { ignoreCase?: boolean } = {}
  ): Project | null {
    const where = opts.ignoreCase
      ? "LOWER(name) = LOWER(?) AND status = 'active' AND archived_at IS NULL"
      : "name = ? AND status = 'active' AND archived_at IS NULL";
    const row = this.db
      .prepare(`SELECT * FROM projects WHERE ${where} ORDER BY updated_at DESC LIMIT 1`)
      .get(name) as ProjectRow | undefined;
    return row ? mapProjectRow(row) : null;
  }

  /**
   * 按名字或别名模糊查找 active 项目（增强去重）
   * 匹配顺序：精确(name) → 别名(aliases_json) → 规范化名字包含
   * - 规范化：去括号、去空格、转小写
   * - 包含匹配要求规范化后长度 >= 2，避免过短名字误匹配
   */
  findActiveProjectByFuzzyName(title: string): Project | null {
    const normalized = normalizeName(title);
    const titleLower = title.toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM projects WHERE status = 'active' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 50`
      )
      .all() as ProjectRow[];
    for (const row of rows) {
      // 1. 精确匹配（大小写不敏感）
      if (row.name.toLowerCase() === titleLower) return mapProjectRow(row);
      // 2. 别名匹配
      const aliases = row.aliases_json ? safeParseArray<string>(row.aliases_json) : [];
      if (aliases.some((a) => a.toLowerCase() === titleLower)) return mapProjectRow(row);
      // 3. 规范化包含匹配
      if (normalized.length >= 2) {
        const rowNorm = normalizeName(row.name);
        if (rowNorm.length >= 2 && (rowNorm.includes(normalized) || normalized.includes(rowNorm))) {
          return mapProjectRow(row);
        }
      }
    }
    return null;
  }

  listProjects(opts: {
    status?: string;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Project[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (!opts.includeArchived) {
      conditions.push("archived_at IS NULL");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM projects ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ProjectRow[];
    return rows.map(mapProjectRow);
  }

  updateProject(id: string, patch: Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>): Project | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.summary !== undefined) { sets.push("summary = ?"); params.push(patch.summary); }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.lastActiveAt !== undefined) { sets.push("last_active_at = ?"); params.push(patch.lastActiveAt); }
    if (patch.sourceFactIds !== undefined) { sets.push("source_fact_ids_json = ?"); params.push(JSON.stringify(patch.sourceFactIds)); }
    if (patch.sourceSceneIds !== undefined) { sets.push("source_scene_ids_json = ?"); params.push(JSON.stringify(patch.sourceSceneIds)); }
    // 012 字段：合并项目时把 from.name 写入 to.aliases
    if (patch.aliases !== undefined) {
      sets.push("aliases_json = ?");
      params.push(patch.aliases.length > 0 ? JSON.stringify(patch.aliases) : null);
    }
    if (sets.length === 0) return this.getProjectById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getProjectById(id);
  }

  archiveProject(id: string): boolean {
    const result = this.db
      .prepare("UPDATE projects SET archived_at = ?, status = 'archived', updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  deleteProject(id: string): boolean {
    const result = this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- Tasks ----------------------

  createTask(input: CreateTaskInput): Task {
    const id = input.id ?? generateId("task");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, title, status, project_id, summary, due_hint,
          priority, confidence, source_fact_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.status,
        input.projectId,
        input.summary,
        input.dueHint,
        input.priority,
        input.confidence,
        JSON.stringify(input.sourceFactIds),
        now,
        now
      );
    return this.getTaskById(id)!;
  }

  getTaskById(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRow
      | undefined;
    return row ? mapTaskRow(row) : null;
  }

  getTaskByIdActive(id: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ? AND deleted_at IS NULL")
      .get(id) as TaskRow | undefined;
    return row ? mapTaskRow(row) : null;
  }

  /**
   * 按 title + projectId 查找未关闭的 task（硬性去重 fallback）
   * - title 大小写不敏感（LOWER 比较）
   * - status IN ('open', 'in_progress') 且未软删除
   * - projectId 为 null 时匹配 project_id IS NULL（未关联项目的 task）
   *   使用 IS 进行 NULL 安全比较
   * - 返回最近更新的一个
   */
  findOpenTaskByTitleAndProject(
    title: string,
    projectId: string | null
  ): Task | null {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE LOWER(title) = LOWER(?)
           AND project_id IS ?
           AND status IN ('open', 'in_progress')
           AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(title, projectId) as TaskRow | undefined;
    return row ? mapTaskRow(row) : null;
  }

  listTasks(opts: {
    status?: string;
    projectId?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Task[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts.projectId) { conditions.push("project_id = ?"); params.push(opts.projectId); }
    if (!opts.includeDeleted) { conditions.push("deleted_at IS NULL"); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as TaskRow[];
    return rows.map(mapTaskRow);
  }

  listTasksByStatus(status: string): Task[] {
    return this.listTasks({ status, includeDeleted: false });
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "createdAt" | "updatedAt" | "deletedAt">>): Task | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.projectId !== undefined) { sets.push("project_id = ?"); params.push(patch.projectId); }
    if (patch.summary !== undefined) { sets.push("summary = ?"); params.push(patch.summary); }
    if (patch.dueHint !== undefined) { sets.push("due_hint = ?"); params.push(patch.dueHint); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
    if (patch.confidence !== undefined) { sets.push("confidence = ?"); params.push(patch.confidence); }
    if (patch.sourceFactIds !== undefined) { sets.push("source_fact_ids_json = ?"); params.push(JSON.stringify(patch.sourceFactIds)); }
    if (patch.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(patch.completedAt); }
    if (sets.length === 0) return this.getTaskById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getTaskById(id);
  }

  softDeleteTask(id: string): boolean {
    const result = this.db
      .prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- People ----------------------

  createPerson(input: CreatePersonInput): Person {
    const id = input.id ?? generateId("person");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO people (
          id, name, role, organization, summary,
          related_project_ids_json, source_fact_ids_json,
          created_at, updated_at, aliases_json, relationship
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.name,
        input.role,
        input.organization,
        input.summary,
        JSON.stringify(input.relatedProjectIds),
        JSON.stringify(input.sourceFactIds),
        now,
        now,
        input.aliases ? JSON.stringify(input.aliases) : null,
        input.relationship ?? null
      );
    return this.getPersonById(id)!;
  }

  getPersonById(id: string): Person | null {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as
      | PersonRow
      | undefined;
    return row ? mapPersonRow(row) : null;
  }

  getPersonByIdActive(id: string): Person | null {
    const row = this.db
      .prepare("SELECT * FROM people WHERE id = ? AND deleted_at IS NULL")
      .get(id) as PersonRow | undefined;
    return row ? mapPersonRow(row) : null;
  }

  /**
   * 按 name 查找人物（硬性去重 fallback）
   * - name 大小写不敏感（LOWER 比较）
   * - 未软删除
   * - 返回最近更新的一个
   */
  findPersonByName(name: string): Person | null {
    const row = this.db
      .prepare(
        `SELECT * FROM people
         WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(name) as PersonRow | undefined;
    return row ? mapPersonRow(row) : null;
  }

  /**
   * 按名字或别名模糊查找人物（增强去重）
   * 匹配顺序：精确(name) → 别名(aliases_json) → 规范化名字包含
   * - 规范化：去括号、去空格、转小写
   * - 包含匹配要求规范化后长度 >= 2，避免过短名字误匹配
   */
  findPersonByFuzzyName(title: string): Person | null {
    const normalized = normalizeName(title);
    const titleLower = title.toLowerCase();
    const rows = this.db
      .prepare(
        `SELECT * FROM people WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 50`
      )
      .all() as PersonRow[];
    for (const row of rows) {
      // 1. 精确匹配（大小写不敏感）
      if (row.name.toLowerCase() === titleLower) return mapPersonRow(row);
      // 2. 别名匹配
      const aliases = row.aliases_json ? safeParseArray<string>(row.aliases_json) : [];
      if (aliases.some((a) => a.toLowerCase() === titleLower)) return mapPersonRow(row);
      // 3. 规范化包含匹配
      if (normalized.length >= 2) {
        const rowNorm = normalizeName(row.name);
        if (rowNorm.length >= 2 && (rowNorm.includes(normalized) || normalized.includes(rowNorm))) {
          return mapPersonRow(row);
        }
      }
    }
    return null;
  }

  listPeople(opts: { includeDeleted?: boolean; limit?: number; offset?: number } = {}): Person[] {
    const conditions: string[] = [];
    if (!opts.includeDeleted) { conditions.push("deleted_at IS NULL"); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM people ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as PersonRow[];
    return rows.map(mapPersonRow);
  }

  updatePerson(id: string, patch: Partial<Omit<Person, "id" | "createdAt" | "updatedAt" | "deletedAt">>): Person | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) { sets.push("name = ?"); params.push(patch.name); }
    if (patch.role !== undefined) { sets.push("role = ?"); params.push(patch.role); }
    if (patch.organization !== undefined) { sets.push("organization = ?"); params.push(patch.organization); }
    if (patch.summary !== undefined) { sets.push("summary = ?"); params.push(patch.summary); }
    if (patch.relatedProjectIds !== undefined) { sets.push("related_project_ids_json = ?"); params.push(JSON.stringify(patch.relatedProjectIds)); }
    if (patch.sourceFactIds !== undefined) { sets.push("source_fact_ids_json = ?"); params.push(JSON.stringify(patch.sourceFactIds)); }
    if (patch.relationship !== undefined) { sets.push("relationship = ?"); params.push(patch.relationship); }
    if (patch.aliases !== undefined) {
      sets.push("aliases_json = ?");
      params.push(patch.aliases.length > 0 ? JSON.stringify(patch.aliases) : null);
    }
    if (sets.length === 0) return this.getPersonById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE people SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getPersonById(id);
  }

  /**
   * 012 新增：把别名合并进 to 人物的 aliases_json（去重 + 不重复 to.name）
   * - 用于 mergeObjects：把 from.name 追加到 to.aliases
   */
  setPersonAliases(id: string, aliases: string[]): Person | null {
    return this.updatePerson(id, { aliases });
  }

  softDeletePerson(id: string): boolean {
    const result = this.db
      .prepare("UPDATE people SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  deletePerson(id: string): boolean {
    const result = this.db.prepare("DELETE FROM people WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- Decisions ----------------------

  createDecision(input: CreateDecisionInput): Decision {
    const id = input.id ?? generateId("decision");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO decisions (
          id, title, decision, project_id, rationale,
          confidence, source_fact_ids_json, decided_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.title,
        input.decision,
        input.projectId,
        input.rationale,
        input.confidence,
        JSON.stringify(input.sourceFactIds),
        input.decidedAt,
        now,
        now
      );
    return this.getDecisionById(id)!;
  }

  getDecisionById(id: string): Decision | null {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
      | DecisionRow
      | undefined;
    return row ? mapDecisionRow(row) : null;
  }

  getDecisionByIdActive(id: string): Decision | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE id = ? AND deleted_at IS NULL")
      .get(id) as DecisionRow | undefined;
    return row ? mapDecisionRow(row) : null;
  }

  /**
   * 按 title 查找最近的 decision（硬性去重 fallback）
   * - title 大小写不敏感（LOWER 比较）
   * - 未软删除
   * - withinDays > 0 时仅匹配 decided_at >= (now - withinDays) 或 decided_at IS NULL
   * - 按 decided_at DESC 排序（SQLite 中 NULL 默认排末尾）
   * - 返回最近一个
   */
  findRecentDecisionByTitle(
    title: string,
    opts: { withinDays?: number } = {}
  ): Decision | null {
    const withinDays = opts.withinDays;
    if (withinDays !== undefined && withinDays > 0) {
      const cutoff = new Date(
        Date.now() - withinDays * 24 * 60 * 60 * 1000
      ).toISOString();
      const row = this.db
        .prepare(
          `SELECT * FROM decisions
           WHERE LOWER(title) = LOWER(?)
             AND deleted_at IS NULL
             AND (decided_at IS NULL OR decided_at >= ?)
           ORDER BY decided_at DESC
           LIMIT 1`
        )
        .get(title, cutoff) as DecisionRow | undefined;
      return row ? mapDecisionRow(row) : null;
    }
    const row = this.db
      .prepare(
        `SELECT * FROM decisions
         WHERE LOWER(title) = LOWER(?) AND deleted_at IS NULL
         ORDER BY decided_at DESC
         LIMIT 1`
      )
      .get(title) as DecisionRow | undefined;
    return row ? mapDecisionRow(row) : null;
  }

  listDecisions(opts: {
    projectId?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  } = {}): Decision[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId) { conditions.push("project_id = ?"); params.push(opts.projectId); }
    if (!opts.includeDeleted) { conditions.push("deleted_at IS NULL"); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where} ORDER BY decided_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as DecisionRow[];
    return rows.map(mapDecisionRow);
  }

  updateDecision(id: string, patch: Partial<Omit<Decision, "id" | "createdAt" | "updatedAt" | "deletedAt">>): Decision | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.decision !== undefined) { sets.push("decision = ?"); params.push(patch.decision); }
    if (patch.projectId !== undefined) { sets.push("project_id = ?"); params.push(patch.projectId); }
    if (patch.rationale !== undefined) { sets.push("rationale = ?"); params.push(patch.rationale); }
    if (patch.confidence !== undefined) { sets.push("confidence = ?"); params.push(patch.confidence); }
    if (patch.sourceFactIds !== undefined) { sets.push("source_fact_ids_json = ?"); params.push(JSON.stringify(patch.sourceFactIds)); }
    if (patch.decidedAt !== undefined) { sets.push("decided_at = ?"); params.push(patch.decidedAt); }
    if (sets.length === 0) return this.getDecisionById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE decisions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getDecisionById(id);
  }

  softDeleteDecision(id: string): boolean {
    const result = this.db
      .prepare("UPDATE decisions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  deleteDecision(id: string): boolean {
    const result = this.db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  // ---------------------- 关键词搜索（SQL LIKE） ----------------------
  // 用于 memory:search IPC，避免全量加载后在 JS 端过滤
  // SQLite LIKE 对 ASCII 默认大小写不敏感

  /**
   * 搜索 projects（name 或 summary LIKE keyword）
   * - 仅未归档
   */
  searchProjectsByKeyword(keyword: string, limit: number = 100): Project[] {
    const likePattern = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM projects WHERE (name LIKE ? OR summary LIKE ?) AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ?`
      )
      .all(likePattern, likePattern, limit) as ProjectRow[];
    return rows.map(mapProjectRow);
  }

  /**
   * 搜索 tasks（title 或 summary LIKE keyword）
   * - 仅未删除
   */
  searchTasksByKeyword(keyword: string, limit: number = 100): Task[] {
    const likePattern = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE (title LIKE ? OR summary LIKE ?) AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`
      )
      .all(likePattern, likePattern, limit) as TaskRow[];
    return rows.map(mapTaskRow);
  }

  /**
   * 搜索 decisions（title 或 decision 或 rationale LIKE keyword）
   * - 仅未删除
   */
  searchDecisionsByKeyword(keyword: string, limit: number = 100): Decision[] {
    const likePattern = `%${keyword}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM decisions WHERE (title LIKE ? OR decision LIKE ? OR rationale LIKE ?) AND deleted_at IS NULL ORDER BY decided_at DESC LIMIT ?`
      )
      .all(likePattern, likePattern, likePattern, limit) as DecisionRow[];
    return rows.map(mapDecisionRow);
  }

  // ============================================================================
  // 003 新增：L3 反向影响 - 标记 orphan 与查找仅由该 fact 支撑的对象
  // ============================================================================

  /**
   * 标记单个 L3 对象的 orphan_status
   * reason: 'source_deleted' / 'needs_review' / 'ok'
   */
  markOrphaned(type: "project" | "task" | "decision", id: string, reason: string): boolean {
    const table = type === "project" ? "projects" : type === "task" ? "tasks" : "decisions";
    const result = this.db
      .prepare(`UPDATE ${table} SET orphan_status = ?, updated_at = ? WHERE id = ?`)
      .run(reason, new Date().toISOString(), id);
    return result.changes > 0;
  }

  /**
   * 查找仅由该 fact 支撑的对象（sourceFactIds 数组只含该 fact）
   * 用于：当 fact 被 soft delete 时，发现 L3 对象失去唯一来源 -> markOrphaned('source_deleted')
   * 多来源对象由调用方判断后从数组中移除被删 fact id（不调用 markOrphaned）
   *
   * @returns 数组：{ type, id, sourceFactIds }
   */
  findOrphansByFactId(factId: string): Array<{
    type: "project" | "task" | "person" | "decision";
    id: string;
    sourceFactIds: string[];
  }> {
    const result: Array<{
      type: "project" | "task" | "person" | "decision";
      id: string;
      sourceFactIds: string[];
    }> = [];

    // projects（仅未归档）
    const projectRows = this.db
      .prepare(
        `SELECT id, source_fact_ids_json FROM projects WHERE archived_at IS NULL`
      )
      .all() as Array<{ id: string; source_fact_ids_json: string }>;
    for (const row of projectRows) {
      const ids = safeParseArray<string>(row.source_fact_ids_json);
      if (ids.length === 1 && ids[0] === factId) {
        result.push({ type: "project", id: row.id, sourceFactIds: ids });
      }
    }

    // tasks（仅未删除）
    const taskRows = this.db
      .prepare(`SELECT id, source_fact_ids_json FROM tasks WHERE deleted_at IS NULL`)
      .all() as Array<{ id: string; source_fact_ids_json: string }>;
    for (const row of taskRows) {
      const ids = safeParseArray<string>(row.source_fact_ids_json);
      if (ids.length === 1 && ids[0] === factId) {
        result.push({ type: "task", id: row.id, sourceFactIds: ids });
      }
    }

    const personRows = this.db
      .prepare(`SELECT id, source_fact_ids_json FROM people WHERE deleted_at IS NULL`)
      .all() as Array<{ id: string; source_fact_ids_json: string }>;
    for (const row of personRows) {
      const ids = safeParseArray<string>(row.source_fact_ids_json);
      if (ids.length === 1 && ids[0] === factId) {
        result.push({ type: "person", id: row.id, sourceFactIds: ids });
      }
    }

    // decisions（仅未删除）
    const decisionRows = this.db
      .prepare(`SELECT id, source_fact_ids_json FROM decisions WHERE deleted_at IS NULL`)
      .all() as Array<{ id: string; source_fact_ids_json: string }>;
    for (const row of decisionRows) {
      const ids = safeParseArray<string>(row.source_fact_ids_json);
      if (ids.length === 1 && ids[0] === factId) {
        result.push({ type: "decision", id: row.id, sourceFactIds: ids });
      }
    }

    return result;
  }

  /**
   * 003 新增：从 L3 对象的 source_fact_ids_json 中移除指定 factId
   * 用于多来源场景：对象不进入 orphan，但需移除被删 fact 的引用
   * @returns 是否成功更新
   */
  removeFactFromSourceLinks(
    type: "project" | "task" | "person" | "decision",
    id: string,
    factId: string
  ): boolean {
    const table = type === "project" ? "projects" : type === "task" ? "tasks" : type === "person" ? "people" : "decisions";
    const row = this.db
      .prepare(`SELECT source_fact_ids_json FROM ${table} WHERE id = ?`)
      .get(id) as { source_fact_ids_json: string } | undefined;
    if (!row) return false;
    const ids = safeParseArray<string>(row.source_fact_ids_json);
    if (!ids.includes(factId)) return false;
    const newIds = ids.filter((v) => v !== factId);
    if (newIds.length === ids.length) return false;
    const result = this.db
      .prepare(`UPDATE ${table} SET source_fact_ids_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(newIds), new Date().toISOString(), id);
    return result.changes > 0;
  }

  // ============================================================================
  // 012 新增：别名（aliases）相关方法
  // 用于 mergeObjects 和 prompt 注入
  // ============================================================================

  /**
   * 列出所有 active 项目的 (id, name, aliases) 三元组
   * - 仅未归档
   * - aliases 字段为 aliases_json 解析后的字符串数组
   * - 用于 Linker / Extractor prompt 注入"已知项目名 + 别名"段
   */
  listProjectAliases(): Array<{ id: string; name: string; aliases: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT id, name, aliases_json FROM projects WHERE archived_at IS NULL AND status = 'active' ORDER BY updated_at DESC`
      )
      .all() as Array<{ id: string; name: string; aliases_json: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      aliases: r.aliases_json ? safeParseArray<string>(r.aliases_json) : [],
    }));
  }

  /**
   * 列出所有未删除人物的 (id, name, aliases) 三元组
   * - aliases 字段为 aliases_json 解析后的字符串数组
   * - 用于 Linker / Extractor prompt 注入"已知人物名 + 别名"段
   */
  listPersonAliases(): Array<{ id: string; name: string; aliases: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT id, name, aliases_json FROM people WHERE deleted_at IS NULL ORDER BY updated_at DESC`
      )
      .all() as Array<{ id: string; name: string; aliases_json: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      aliases: r.aliases_json ? safeParseArray<string>(r.aliases_json) : [],
    }));
  }
}

export function createMemoryObjectRepository(db: DB): MemoryObjectRepository {
  return new MemoryObjectRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapProjectRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    summary: row.summary,
    status: row.status,
    lastActiveAt: row.last_active_at,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    sourceSceneIds: safeParseArray(row.source_scene_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    // 003 字段
    orphanStatus: row.orphan_status,
    // 012 字段
    aliases: row.aliases_json ? safeParseArray<string>(row.aliases_json) : [],
  };
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    projectId: row.project_id,
    summary: row.summary,
    dueHint: row.due_hint,
    priority: row.priority,
    confidence: row.confidence,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    deletedAt: row.deleted_at,
    // 003 字段
    orphanStatus: row.orphan_status,
  };
}

function mapPersonRow(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    organization: row.organization,
    summary: row.summary,
    relatedProjectIds: safeParseArray(row.related_project_ids_json),
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    // 012 字段
    aliases: row.aliases_json ? safeParseArray<string>(row.aliases_json) : [],
    // 022 字段
    relationship: row.relationship,
  };
}

function mapDecisionRow(row: DecisionRow): Decision {
  return {
    id: row.id,
    title: row.title,
    decision: row.decision,
    projectId: row.project_id,
    rationale: row.rationale,
    confidence: row.confidence,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    // 003 字段
    orphanStatus: row.orphan_status,
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

/**
 * 名字规范化（用于模糊去重）
 * - 转小写
 * - 去除括号及括号内内容（中文括号（）和英文括号 ()）
 * - 去除首尾空格
 * 例："陈章（耀石锂电hr）" → "陈章"
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "") // 去除中文/英文括号及内容
    .trim();
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
