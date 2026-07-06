// src/main/db/repositories/ProactiveItemRepository.ts
// proactive_items 表数据访问
//
// 表结构（来自 spec.md）：
// - id TEXT PRIMARY KEY
// - type TEXT NOT NULL
// - title TEXT NOT NULL
// - body TEXT NOT NULL
// - reason TEXT NOT NULL
// - priority REAL NOT NULL DEFAULT 0
// - surface TEXT NOT NULL
// - requires_user_confirmation INTEGER NOT NULL DEFAULT 0
// - status TEXT NOT NULL DEFAULT 'new'
// - source_fact_ids_json TEXT NOT NULL DEFAULT '[]'
// - source_scene_ids_json TEXT NOT NULL DEFAULT '[]'
// - created_at TEXT NOT NULL
// - updated_at TEXT NOT NULL
//
// 索引：idx_proactive_status
//
// 用途（来自 03 文档）：
// - Judge worker 输出的 proactive_items 写入此表
// - Linker 发现的 mergeSuggestions 作为 needs_confirmation 写入此表
// - 用户可通过 reminders:list / reminders:updateStatus 操作
//
// 重要约束：
// - 默认 surface 为 in_app 或 daily_report
// - desktop_notification_candidate 需用户开启后才生效（由 Judge 调用方决定是否转换为桌面通知）
// - requires_user_confirmation=true 的项必须经用户确认后才视为已处理

import type { DB } from "../Database";
import type { ProactiveItem } from "../../models/types";
import { getLocalTodayStartIso } from "./_helpers";

/**
 * DB 行类型（JSON 字段为 string）
 */
interface ProactiveItemRow {
  id: string;
  type: string;
  title: string;
  body: string;
  reason: string;
  priority: number;
  surface: string;
  requires_user_confirmation: number;
  status: string;
  source_fact_ids_json: string;
  source_scene_ids_json: string;
  created_at: string;
  updated_at: string;
}

/**
 * 创建 proactive_item 输入
 */
export type CreateProactiveItemInput = Omit<
  ProactiveItem,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
};

/**
 * 更新 proactive_item 输入
 */
export type UpdateProactiveItemInput = Partial<
  Omit<ProactiveItem, "id" | "createdAt" | "updatedAt">
>;

/**
 * ProactiveItem 状态
 */
export type ProactiveItemStatus =
  | "new"
  | "confirmed"
  | "ignored"
  | "snoozed"
  | "done"
  | "do_not_remind_again";

export class ProactiveItemRepository {
  constructor(private db: DB) {}

  /**
   * 创建 proactive_item
   */
  create(input: CreateProactiveItemInput): ProactiveItem {
    const id = input.id ?? generateId("pi");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO proactive_items (
          id, type, title, body, reason, priority,
          surface, requires_user_confirmation, status,
          source_fact_ids_json, source_scene_ids_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.title,
        input.body,
        input.reason,
        input.priority,
        input.surface,
        input.requiresUserConfirmation ? 1 : 0,
        input.status,
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
  getById(id: string): ProactiveItem | null {
    const row = this.db
      .prepare("SELECT * FROM proactive_items WHERE id = ?")
      .get(id) as ProactiveItemRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * 按 status 查询
   */
  listByStatus(status: string, opts: { limit?: number; offset?: number } = {}): ProactiveItem[] {
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM proactive_items WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`
      )
      .all(status, limit, offset) as ProactiveItemRow[];
    return rows.map(mapRow);
  }

  /**
   * 查询全部（可按 surface 过滤）
   */
  list(opts: {
    status?: string;
    surface?: string;
    limit?: number;
    offset?: number;
  } = {}): ProactiveItem[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts.surface) {
      conditions.push("surface = ?");
      params.push(opts.surface);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM proactive_items ${where} ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as ProactiveItemRow[];
    return rows.map(mapRow);
  }

  /**
   * 查询今日新增的 proactive_items
   *
   * 注意：使用本地日期与时区偏移构造起始时间，避免 UTC 与本地时区差异
   * 导致跨日边界时（如 UTC+8 凌晨 0:00-8:00）误把今天当成昨天。
   */
  listToday(): ProactiveItem[] {
    const from = getLocalTodayStartIso();
    const rows = this.db
      .prepare(
        `SELECT * FROM proactive_items WHERE created_at >= ? ORDER BY priority DESC, created_at DESC`
      )
      .all(from) as ProactiveItemRow[];
    return rows.map(mapRow);
  }

  /**
   * 更新 proactive_item
   */
  update(id: string, patch: UpdateProactiveItemInput): ProactiveItem | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.type !== undefined) { sets.push("type = ?"); params.push(patch.type); }
    if (patch.title !== undefined) { sets.push("title = ?"); params.push(patch.title); }
    if (patch.body !== undefined) { sets.push("body = ?"); params.push(patch.body); }
    if (patch.reason !== undefined) { sets.push("reason = ?"); params.push(patch.reason); }
    if (patch.priority !== undefined) { sets.push("priority = ?"); params.push(patch.priority); }
    if (patch.surface !== undefined) { sets.push("surface = ?"); params.push(patch.surface); }
    if (patch.requiresUserConfirmation !== undefined) {
      sets.push("requires_user_confirmation = ?");
      params.push(patch.requiresUserConfirmation ? 1 : 0);
    }
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.sourceFactIds !== undefined) {
      sets.push("source_fact_ids_json = ?");
      params.push(JSON.stringify(patch.sourceFactIds));
    }
    if (patch.sourceSceneIds !== undefined) {
      sets.push("source_scene_ids_json = ?");
      params.push(JSON.stringify(patch.sourceSceneIds));
    }
    if (sets.length === 0) return this.getById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);
    this.db.prepare(`UPDATE proactive_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  /**
   * 更新状态（用于 reminders:updateStatus）
   */
  updateStatus(id: string, status: ProactiveItemStatus): ProactiveItem | null {
    return this.update(id, { status });
  }

  /**
   * 删除
   */
  deleteById(id: string): boolean {
    const result = this.db.prepare("DELETE FROM proactive_items WHERE id = ?").run(id);
    return result.changes > 0;
  }

  /**
   * 统计
   */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) as cnt FROM proactive_items").get() as {
      cnt: number;
    };
    return row.cnt;
  }

  /**
   * 按 status 统计
   */
  countByStatus(status: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM proactive_items WHERE status = ?")
      .get(status) as { cnt: number };
    return row.cnt;
  }
}

export function createProactiveItemRepository(db: DB): ProactiveItemRepository {
  return new ProactiveItemRepository(db);
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function mapRow(row: ProactiveItemRow): ProactiveItem {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    reason: row.reason,
    priority: row.priority,
    surface: row.surface,
    requiresUserConfirmation: row.requires_user_confirmation === 1,
    status: row.status,
    sourceFactIds: safeParseArray(row.source_fact_ids_json),
    sourceSceneIds: safeParseArray(row.source_scene_ids_json),
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
