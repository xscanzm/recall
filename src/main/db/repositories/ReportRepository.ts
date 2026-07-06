// src/main/db/repositories/ReportRepository.ts
// Report 数据访问
//
// 表结构：reports
// 索引：idx_reports_type_date
//
// JSON 字段：content_json（已是 string，直接存取）, source_fact_ids_json, source_scene_ids_json

import type { DB } from "../Database";
import type { Report, CreateReportInput } from "../../models/types";

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
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now
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
