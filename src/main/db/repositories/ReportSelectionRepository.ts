// src/main/db/repositories/ReportSelectionRepository.ts
// ReportSelection 数据访问
//
// 表结构：report_selections（004 迁移）
// 索引：idx_report_selections_date_type ON (date_key, report_type)
//
// JSON 字段：selected_timeline_block_ids_json, excluded_timeline_block_ids_json
//
// 用途：记录每次生成工作日报/周报时，用户勾选或系统预选的 timeline_block ids。
// 工作日报必须记录 selected timeline block ids（spec 行 1193）。
//
// 注意：表未设 UNIQUE(date_key, report_type) 约束，仅有索引。
// upsert 采用"先查后改/插"策略保证幂等。

import type { DB } from "../Database";

interface ReportSelectionRowDb {
  id: string;
  date_key: string;
  report_type: string;
  selected_timeline_block_ids_json: string;
  excluded_timeline_block_ids_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * ReportSelection 领域行（JSON 字段已 parse 为数组）
 */
export interface ReportSelectionRow {
  id: string;
  dateKey: string;
  reportType: string;
  selectedTimelineBlockIds: string[];
  excludedTimelineBlockIds: string[];
  createdAt: string;
  updatedAt: string;
}

export class ReportSelectionRepository {
  constructor(private db: DB) {}

  /**
   * upsert（按 date_key + report_type 唯一）
   *
   * 实现策略：先查询是否存在，存在则 UPDATE，不存在则 INSERT。
   * 因表仅有索引而非 UNIQUE 约束，不使用 INSERT OR REPLACE。
   */
  upsert(
    dateKey: string,
    reportType: string,
    selectedIds: string[],
    excludedIds: string[]
  ): void {
    const existing = this.findByDateKeyAndType(dateKey, reportType);
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(
          `UPDATE report_selections
           SET selected_timeline_block_ids_json = ?,
               excluded_timeline_block_ids_json = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          JSON.stringify(selectedIds),
          JSON.stringify(excludedIds),
          now,
          existing.id
        );
      return;
    }

    const id = generateId("rsel");
    this.db
      .prepare(
        `INSERT INTO report_selections (
          id, date_key, report_type,
          selected_timeline_block_ids_json, excluded_timeline_block_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        dateKey,
        reportType,
        JSON.stringify(selectedIds),
        JSON.stringify(excludedIds),
        now,
        now
      );
  }

  /**
   * 查询某天某类型的选区
   */
  findByDateKeyAndType(
    dateKey: string,
    reportType: string
  ): ReportSelectionRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM report_selections WHERE date_key = ? AND report_type = ?"
      )
      .get(dateKey, reportType) as ReportSelectionRowDb | undefined;
    return row ? this.rowToReportSelection(row) : null;
  }

  /**
   * 查询某天所有类型的选区
   */
  findByDateKey(dateKey: string): ReportSelectionRow[] {
    const rows = this.db
      .prepare("SELECT * FROM report_selections WHERE date_key = ?")
      .all(dateKey) as ReportSelectionRowDb[];
    return rows.map((row) => this.rowToReportSelection(row));
  }

  // ============================================================================
  // 内部辅助
  // ============================================================================

  private rowToReportSelection(row: ReportSelectionRowDb): ReportSelectionRow {
    return {
      id: row.id,
      dateKey: row.date_key,
      reportType: row.report_type,
      selectedTimelineBlockIds: safeParseArray(row.selected_timeline_block_ids_json),
      excludedTimelineBlockIds: safeParseArray(row.excluded_timeline_block_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function createReportSelectionRepository(
  db: DB
): ReportSelectionRepository {
  return new ReportSelectionRepository(db);
}

// ============================================================================
// 模块级辅助函数
// ============================================================================

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
