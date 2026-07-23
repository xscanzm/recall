// src/main/db/repositories/ObservationRepository.ts
// Observation（L0）数据访问
//
// 表结构：observations（13 张表之一）
// 索引：idx_observations_captured_at
//
// JSON 字段在 Repository 层做 stringify/parse 转换：
// - visible_content_json
// - detected_entities_json
// - possible_tasks_json
// - possible_decisions_json
// - uncertainties_json
// - screenshot_paths_json

import type { DB } from "../Database";
import * as fs from "node:fs";
import type { Observation, CreateObservationInput } from "../../models/types";
import type { ScreenshotRetentionPolicy } from "../../models/types";
import { getLocalTodayStartIso } from "./_helpers";

/**
 * DB 行类型（JSON 字段为 string）
 *
 * V2 字段（008 迁移新增，均可空）：
 * - user_facing_summary / likely_work_purpose / privacy_risk / reportable_signal
 */
interface ObservationRow {
  id: string;
  capture_id: string;
  captured_at: string;
  app_name: string;
  window_title: string;
  url_or_domain: string | null;
  capture_reason: string;
  scene_summary: string;
  visible_content_json: string;
  detected_entities_json: string;
  possible_intent: string | null;
  possible_tasks_json: string;
  possible_decisions_json: string;
  sensitivity: string;
  confidence: number;
  uncertainties_json: string;
  screenshot_retention: string;
  screenshot_paths_json: string;
  created_at: string;
  // 008 V2 字段
  user_facing_summary: string | null;
  likely_work_purpose: string | null;
  privacy_risk: string | null;
  reportable_signal: string | null;
}

export class ObservationRepository {
  constructor(private db: DB) {}

  /**
   * 创建 observation
   *
   * V2 字段（userFacingSummary / likelyWorkPurpose / privacyRisk / reportableSignal）
   * 来自 008 迁移，均可空。V1 写入路径不传这些字段时落库为 NULL。
   */
  create(input: CreateObservationInput): Observation {
    const existing = this.getByCaptureId(input.captureId);
    if (existing) return existing;
    const id = input.id ?? generateId("obs");
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO observations (
          id, capture_id, captured_at, app_name, window_title,
          url_or_domain, capture_reason, scene_summary,
          visible_content_json, detected_entities_json,
          possible_intent, possible_tasks_json, possible_decisions_json,
          sensitivity, confidence, uncertainties_json,
          screenshot_retention, screenshot_paths_json, created_at,
          user_facing_summary, likely_work_purpose, privacy_risk, reportable_signal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.captureId,
        input.capturedAt,
        input.appName,
        input.windowTitle,
        input.urlOrDomain,
        input.captureReason,
        input.sceneSummary,
        JSON.stringify(input.visibleContent),
        JSON.stringify(input.detectedEntities),
        input.possibleIntent,
        JSON.stringify(input.possibleTasks),
        JSON.stringify(input.possibleDecisions),
        input.sensitivity,
        input.confidence,
        JSON.stringify(input.uncertainties),
        input.screenshotRetention,
        JSON.stringify(input.screenshotPaths),
        createdAt,
        input.userFacingSummary ?? null,
        input.likelyWorkPurpose ?? null,
        input.privacyRisk ?? null,
        input.reportableSignal ?? null
      );

    return this.getById(id)!;
  }

  /**
   * 按 id 查询
   */
  getById(id: string): Observation | null {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE id = ?")
      .get(id) as ObservationRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按时间范围查询（仅返回 id 和 captured_at，专供 Today 页面轻量查询）
   */
  listTimeRangeMinimal(from: string, to: string): Array<{ id: string; capturedAt: string }> {
    const rows = this.db
      .prepare(
        "SELECT id, captured_at FROM observations WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at ASC"
      )
      .all(from, to) as Array<{ id: string; captured_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      capturedAt: row.captured_at,
    }));
  }

  /**
   * 按时间范围查询（含分页）
   */
  listByCapturedAt(opts: {
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  } = {}): Observation[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      conditions.push("captured_at >= ?");
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push("captured_at < ?");
      params.push(opts.to);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const order = opts.order === "asc" ? "ASC" : "DESC";
    const rows = this.db
      .prepare(
        `SELECT * FROM observations ${where} ORDER BY captured_at ${order} LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as ObservationRow[];
    return rows.map(mapRow);
  }

  /**
   * 按时间范围查询（debug 页用，含全部记录，不分页）
   * - 时间字段：captured_at
   * - 不做软删除过滤（observations 表无 deleted_at）
   */
  listByTimeRange(startAt: string, endAt: string): Observation[] {
    const stmt = this.db.prepare(
      "SELECT * FROM observations WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at DESC"
    );
    const rows = stmt.all(startAt, endAt) as ObservationRow[];
    return rows.map(mapRow);
  }

  /**
   * 查询今日 observation
   *
   * 注意：使用本地日期与时区偏移构造起始时间，避免 UTC 与本地时区差异
   * 导致跨日边界时（如 UTC+8 凌晨 0:00-8:00）误把今天当成昨天。
   */
  listToday(): Observation[] {
    const from = getLocalTodayStartIso();
    return this.listByCapturedAt({ from });
  }

  /**
   * 按 capture_id 查询
   */
  getByCaptureId(captureId: string): Observation | null {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE capture_id = ?")
      .get(captureId) as ObservationRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 物理删除（用户 forget recent 时调用）
   */
  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM observations WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * 按时间范围物理删除
   */
  deleteByCapturedAt(from: string, to?: string): number {
    if (to) {
      const result = this.db
        .prepare("DELETE FROM observations WHERE captured_at >= ? AND captured_at < ?")
        .run(from, to);
      return result.changes;
    }
    const result = this.db
      .prepare("DELETE FROM observations WHERE captured_at >= ?")
      .run(from);
    return result.changes;
  }

  /**
   * 统计总数
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM observations").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  /**
   * 更新单条 observation 的 screenshot_retention 字段
   * 用于：
   * - 高敏内容删除截图后标记为 expired
   * - 一键清空后标记为 deleted
   * - delete_immediately 处理完后标记为 deleted
   */
  updateScreenshotRetention(
    id: string,
    retention: ScreenshotRetentionPolicy | "expired" | "deleted"
  ): boolean {
    const result = this.db
      .prepare("UPDATE observations SET screenshot_retention = ? WHERE id = ?")
      .run(retention, id);
    return result.changes > 0;
  }

  /**
   * 按 capture_id 更新 screenshot_retention
   */
  updateScreenshotRetentionByCaptureId(
    captureId: string,
    retention: ScreenshotRetentionPolicy | "expired" | "deleted"
  ): boolean {
    const result = this.db
      .prepare("UPDATE observations SET screenshot_retention = ? WHERE capture_id = ?")
      .run(retention, captureId);
    return result.changes > 0;
  }

  /**
   * 批量标记已无对应截图文件的 observation 为 expired
   * 由 ScreenshotCache.cleanupExpired 调用
   *
   * 策略：遍历所有 screenshot_retention 不为 expired/deleted 的 observation，
   * 检查 screenshot_paths_json 中的路径是否存在；若全部不存在，标记为 expired。
   *
   * 注意：此方法可能在大批量数据时较慢，仅在启动时清理后调用一次
   */
  async markExpiredScreenshots(batchSize = 200): Promise<number> {
    let updated = 0;
    const update = this.db.prepare(
      "UPDATE observations SET screenshot_retention = 'expired' WHERE id = ?"
    );
    const updateBatch = this.db.transaction((ids: string[]) => {
      for (const id of ids) update.run(id);
    });
    let cursor = "";

    while (true) {
      const rows = this.db
        .prepare(
          `SELECT id, screenshot_paths_json FROM observations
           WHERE screenshot_retention NOT IN ('expired', 'deleted') AND id > ?
           ORDER BY id ASC LIMIT ?`
        )
        .all(cursor, Math.max(1, batchSize)) as Array<{ id: string; screenshot_paths_json: string }>;
      if (rows.length === 0) break;

      const expiredIds: string[] = [];
      for (const row of rows) {
        const paths = safeParseArray<string>(row.screenshot_paths_json);
        if (paths.length > 0 && paths.every((filePath) => !fs.existsSync(filePath))) {
          expiredIds.push(row.id);
        }
      }
      if (expiredIds.length > 0) updateBatch(expiredIds);
      updated += expiredIds.length;
      cursor = rows[rows.length - 1].id;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return updated;
  }
}

export function createObservationRepository(db: DB): ObservationRepository {
  return new ObservationRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: ObservationRow): Observation {
  return {
    id: row.id,
    captureId: row.capture_id,
    capturedAt: row.captured_at,
    appName: row.app_name,
    windowTitle: row.window_title,
    urlOrDomain: row.url_or_domain,
    captureReason: row.capture_reason,
    sceneSummary: row.scene_summary,
    visibleContent: safeParseArray(row.visible_content_json),
    detectedEntities: safeParseArray(row.detected_entities_json),
    possibleIntent: row.possible_intent,
    possibleTasks: safeParseArray(row.possible_tasks_json),
    possibleDecisions: safeParseArray(row.possible_decisions_json),
    sensitivity: row.sensitivity,
    confidence: row.confidence,
    uncertainties: safeParseArray(row.uncertainties_json),
    screenshotRetention: row.screenshot_retention as ScreenshotRetentionPolicy,
    screenshotPaths: safeParseArray(row.screenshot_paths_json),
    createdAt: row.created_at,
    // 008 V2 字段（null-safe）
    userFacingSummary: row.user_facing_summary ?? null,
    likelyWorkPurpose: row.likely_work_purpose ?? null,
    privacyRisk: (row.privacy_risk as Observation["privacyRisk"]) ?? null,
    reportableSignal: (row.reportable_signal as Observation["reportableSignal"]) ?? null,
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
