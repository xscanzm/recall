// src/main/db/repositories/ReportRepository.ts
// Report 数据访问
//
// 表结构：reports
// 索引：idx_reports_type_date
//
// JSON 字段：content_json（已是 string，直接存取）, source_fact_ids_json, source_scene_ids_json

import type { DB } from "../Database";
import type { Report, CreateReportInput } from "../../models/types";
import type { PersonalReview } from "../../../shared/types";
import type { ReportGenerationRequirementsSnapshot } from "../../../shared/reportRequirements";

interface ReportRow {
  id: string;
  type: string;
  date_key: string;
  title: string;
  content_json: string;
  source_fact_ids_json: string;
  source_scene_ids_json: string;
  created_at: string;
  updated_at: string;
  // 003 字段
  is_stale: number;
  stale_reason: string | null;
  stale_at: string | null;
  // 010 字段
  project_id: string | null;
}

export class ReportRepository {
  constructor(private db: DB) {}

  /**
   * 创建 report
   */
  create(input: CreateReportInput): Report {
    const id = input.id ?? generateId("report");
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO reports (
          id, type, date_key, title, content_json,
          source_fact_ids_json, source_scene_ids_json,
          created_at, updated_at, project_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.dateKey,
        input.title,
        input.contentJson,
        JSON.stringify(input.sourceFactIds),
        JSON.stringify(input.sourceSceneIds),
        now,
        now,
        input.projectId ?? null
      );

    return this.getById(id)!;
  }

  /**
   * 按 id 查询
   */
  getById(id: string): Report | null {
    const row = this.db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as
      | ReportRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 type + date_key 查询
   */
  getByTypeAndDate(type: string, dateKey: string): Report | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE type = ? AND date_key = ?")
      .get(type, dateKey) as ReportRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 type 查询
   */
  listByType(type: string, opts: { limit?: number; offset?: number } = {}): Report[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare("SELECT * FROM reports WHERE type = ? ORDER BY date_key DESC LIMIT ? OFFSET ?")
      .all(type, limit, offset) as ReportRow[];
    return rows.map(mapRow);
  }

  /**
   * 按时间范围查询
   */
  listByDateRange(dateFrom: string, dateTo?: string): Report[] {
    if (dateTo) {
      const rows = this.db
        .prepare("SELECT * FROM reports WHERE date_key >= ? AND date_key <= ? ORDER BY date_key DESC")
        .all(dateFrom, dateTo) as ReportRow[];
      return rows.map(mapRow);
    }
    const rows = this.db
      .prepare("SELECT * FROM reports WHERE date_key >= ? ORDER BY date_key DESC")
      .all(dateFrom) as ReportRow[];
    return rows.map(mapRow);
  }

  /**
   * 全部查询
   */
  list(opts: {
    type?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    offset?: number;
  } = {}): Report[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.type) { conditions.push("type = ?"); params.push(opts.type); }
    if (opts.dateFrom) { conditions.push("date_key >= ?"); params.push(opts.dateFrom); }
    if (opts.dateTo) { conditions.push("date_key <= ?"); params.push(opts.dateTo); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM reports ${where} ORDER BY date_key DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as ReportRow[];
    return rows.map(mapRow);
  }

  /**
   * 更新 report
   */
  update(id: string, patch: Partial<Omit<Report, "id" | "createdAt" | "updatedAt">>): Report | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.type !== undefined) { sets.push("type = ?"); params.push(patch.type); }
    if (patch.dateKey !== undefined) { sets.push("date_key = ?"); params.push(patch.dateKey); }
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.contentJson !== undefined) { sets.push("content_json = ?"); params.push(patch.contentJson); }
    if (patch.sourceFactIds !== undefined) { sets.push("source_fact_ids_json = ?"); params.push(JSON.stringify(patch.sourceFactIds)); }
    if (patch.sourceSceneIds !== undefined) { sets.push("source_scene_ids_json = ?"); params.push(JSON.stringify(patch.sourceSceneIds)); }
    if (patch.projectId !== undefined) { sets.push("project_id = ?"); params.push(patch.projectId ?? null); }
    if (sets.length === 0) return this.getById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE reports SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  /**
   * 删除 report
   */
  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM reports WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * 统计
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM reports").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  // ============================================================================
  // Phase 2 新增：PersonalReview 持久化（type=personal_daily_review）
  // ============================================================================

  /**
   * Upsert PersonalReview 到 reports 表（type=personal_daily_review）
   *
   * 同一 dateKey 重复生成时：
   * - 若已存在：更新 title / content_json / source_fact_ids_json，清除 stale 标记
   * - 若不存在：创建新记录
   *
   * content_json 存储完整的 PersonalReview JSON（含 id / overview / mainThreads 等），
   * 便于 renderer 端直接 parse 还原 PersonalReview 实体。
   * source_fact_ids_json 聚合 unfinished[] / worthRemembering[] 中的 sourceFactIds，
   * 便于 findReportsReferencingFact 反向追溯。
   *
   * @param dateKey 日期 key YYYY-MM-DD
   * @param review PersonalReview 实体
   * @returns 写入后的 Report 记录
   */
  upsertPersonalReview(
    dateKey: string,
    review: PersonalReview,
    reportRequirements?: ReportGenerationRequirementsSnapshot
  ): Report {
    const existing = this.getByTypeAndDate("personal_daily_review", dateKey);
    const sourceFactIds = collectPersonalReviewFactIds(review);
    const contentJson = JSON.stringify({
      id: review.id,
      dateKey: review.dateKey,
      title: review.title,
      overview: review.overview,
      mainThreads: review.mainThreads,
      meaningfulProgress: review.meaningfulProgress,
      unfinished: review.unfinished,
      worthRemembering: review.worthRemembering,
      tomorrowStartHere: review.tomorrowStartHere,
      ...(reportRequirements ? { reportRequirements } : {}),
    });

    if (existing) {
      const updated = this.update(existing.id, {
        title: review.title,
        contentJson,
        sourceFactIds,
        sourceSceneIds: [],
      });
      // 清除 stale 标记（重新生成成功）
      if (updated) {
        this.clearStale(updated.id);
        return updated;
      }
      return existing;
    }

    return this.create({
      id: review.id,
      type: "personal_daily_review",
      dateKey,
      title: review.title,
      contentJson,
      sourceFactIds,
      sourceSceneIds: [],
    });
  }

  // ============================================================================
  // 003 新增：标记 stale 与按来源查询
  // ============================================================================

  /**
   * 标记单个 report 为 stale（需要重新生成）
   * 设置 is_stale=1, stale_reason, stale_at=now
   */
  markStale(reportId: string, reason: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE reports
         SET is_stale = 1, stale_reason = ?, stale_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(reason, now, now, reportId);
    return result.changes > 0;
  }

  /**
   * 批量标记 stale（同一 reason）
   */
  markStaleMany(reportIds: string[], reason: string): number {
    if (reportIds.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `UPDATE reports
       SET is_stale = 1, stale_reason = ?, stale_at = ?, updated_at = ?
       WHERE id = ?`
    );
    const txn = this.db.transaction(() => {
      let changed = 0;
      for (const id of reportIds) {
        const r = stmt.run(reason, now, now, id);
        if (r.changes > 0) changed++;
      }
      return changed;
    });
    return txn();
  }

  /**
   * 清除 stale 标记（重新生成成功后调用）
   */
  clearStale(reportId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE reports
         SET is_stale = 0, stale_reason = NULL, stale_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), reportId);
    return result.changes > 0;
  }

  /**
   * 查询引用了指定 fact 的 reports（source_fact_ids_json 包含 factId）
   * 使用 SQLite json_each
   */
  findReportsReferencingFact(factId: string): Report[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reports WHERE EXISTS (
          SELECT 1 FROM json_each(reports.source_fact_ids_json)
          WHERE json_each.value = ?
        ) ORDER BY date_key DESC`
      )
      .all(factId) as ReportRow[];
    return rows.map(mapRow);
  }

  /**
   * 查询引用了指定 scene 的 reports（source_scene_ids_json 包含 sceneId）
   */
  findReportsReferencingScene(sceneId: string): Report[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM reports WHERE EXISTS (
          SELECT 1 FROM json_each(reports.source_scene_ids_json)
          WHERE json_each.value = ?
        ) ORDER BY date_key DESC`
      )
      .all(sceneId) as ReportRow[];
    return rows.map(mapRow);
  }

  // ============================================================================
  // Phase 2 新增：工作日报 upsert（type=work_daily_report）
  // ============================================================================

  /**
   * Upsert 工作日报（type=work_daily_report）
   *
   * 若同 dateKey 已存在 work_daily_report 记录，更新其内容；否则创建新记录。
   * sourceSceneIds 列复用为 sourceTimelineBlockIds（reports 表未单独建列），
   * 完整数据（含 sourceTimelineBlockIds）已在 contentJson 中保留。
   *
   * @param dateKey 日期 YYYY-MM-DD
   * @param input 报告内容（title / contentJson / sourceFactIds / sourceTimelineBlockIds）
   * @returns 持久化后的 Report 记录
   */
  upsertWorkReport(
    dateKey: string,
    input: {
      title: string;
      contentJson: string;
      sourceFactIds: string[];
      sourceTimelineBlockIds: string[];
    }
  ): Report {
    const existing = this.getByTypeAndDate("work_daily_report", dateKey);
    if (existing) {
      const updated = this.update(existing.id, {
        title: input.title,
        contentJson: input.contentJson,
        sourceFactIds: input.sourceFactIds,
        sourceSceneIds: input.sourceTimelineBlockIds,
      });
      if (updated) return updated;
      // update 返回 null 的极端情况：回退到 create（使用原 id）
      return this.create({
        id: existing.id,
        type: "work_daily_report",
        dateKey,
        title: input.title,
        contentJson: input.contentJson,
        sourceFactIds: input.sourceFactIds,
        sourceSceneIds: input.sourceTimelineBlockIds,
      });
    }
    return this.create({
      type: "work_daily_report",
      dateKey,
      title: input.title,
      contentJson: input.contentJson,
      sourceFactIds: input.sourceFactIds,
      sourceSceneIds: input.sourceTimelineBlockIds,
    });
  }
}

export function createReportRepository(db: DB): ReportRepository {
  return new ReportRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: ReportRow): Report {
  return {
    id: row.id,
    type: row.type,
    dateKey: row.date_key,
    title: row.title,
    contentJson: row.content_json,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    sourceSceneIds: safeParseArray(row.source_scene_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 003 字段
    isStale: row.is_stale,
    staleReason: row.stale_reason,
    staleAt: row.stale_at,
    // 010 字段
    projectId: row.project_id,
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

/**
 * 从 PersonalReview 中收集所有 sourceFactIds（用于 reports.source_fact_ids_json）
 *
 * 聚合 unfinished[].sourceFactIds 和 worthRemembering[].sourceFactIds，
 * 便于 findReportsReferencingFact 反向追溯 report 引用了哪些 fact。
 */
function collectPersonalReviewFactIds(review: PersonalReview): string[] {
  const ids = new Set<string>();
  for (const item of review.unfinished) {
    for (const id of item.sourceFactIds) ids.add(id);
  }
  for (const item of review.worthRemembering) {
    for (const id of item.sourceFactIds) ids.add(id);
  }
  return Array.from(ids);
}
