// src/main/db/repositories/TimelineBlockRepository.ts
// TimelineBlock 数据访问
//
// 表结构：timeline_blocks（003 迁移）
// 索引：idx_timeline_blocks_date_key
//
// JSON 字段：project_ids_json, project_names_json, highlights_json,
//           generated_tasks_json, generated_decisions_json,
//           source_scene_ids_json, source_fact_ids_json, source_observation_ids_json
// reportable 字段：INTEGER 0/1（映射到 boolean）
// private_risk 字段：TEXT 'low' | 'medium' | 'high'
//
// 2026-07-07 重大设计变更：
// - 之前 upsertMany 采用"先 DELETE 当天全部，再 INSERT 新的"全量替换策略
// - 问题：部分数据覆盖全部历史，且 LLM 每次重建会丢失之前已落盘的内容
// - 新策略：增量落盘，历史不可变
//   - insertMany：只追加新 blocks，不删除旧的
//   - getLastEndAt：查询当天已落盘 blocks 的最大 endAt，用于确定增量窗口起点
//   - upsertMany 保留但标记 @deprecated，仅供存量清理使用
//
// 009 迁移补全字段：private_risk_reason（TEXT）/ confidence（REAL），
// 与 TimelineBlock 类型对齐（spec.md 行 1170-1175 原注释已废弃）。

import type { DB } from "../Database";
import type { TimelineBlock } from "../../../shared/types";

export interface TimelineWindowReplacement {
  dateKey: string;
  windowStart: string;
  windowEnd: string;
  blocks: TimelineBlock[];
  processedThrough: string;
}

interface TimelineBlockRow {
  id: string;
  date_key: string;
  start_at: string;
  end_at: string;
  title: string;
  summary: string;
  category: string;
  project_ids_json: string;
  project_names_json: string;
  highlights_json: string;
  generated_tasks_json: string;
  generated_decisions_json: string;
  reportable: number;
  private_risk: string;
  // 009 迁移补全字段
  private_risk_reason: string | null;
  confidence: number | null;
  source_scene_ids_json: string;
  source_fact_ids_json: string;
  source_observation_ids_json: string;
  created_at: string;
  updated_at: string;
}

export class TimelineBlockRepository {
  constructor(private db: DB) {}

  list(opts: { limit?: number; offset?: number } = {}): TimelineBlock[] {
    const limit = opts.limit ?? 2000;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM timeline_blocks ORDER BY date_key DESC, start_at ASC LIMIT ? OFFSET ?"
      )
      .all(limit, offset) as TimelineBlockRow[];
    return rows.map((row) => this.rowToTimelineBlock(row));
  }

  /**
   * 查询某 dateKey 已落盘 blocks 的最大 endAt
   *
   * 用于增量落盘逻辑：下次 buildTimeline 只处理 (lastEndAt, now] 范围的新数据。
   * 如果当天没有任何 block，返回 null（表示需要从当天 00:00 开始）。
   */
  getLastEndAt(dateKey: string): string | null {
    const row = this.db
      .prepare(
        "SELECT MAX(end_at) as max_end FROM timeline_blocks WHERE date_key = ?"
      )
      .get(dateKey) as { max_end: string | null } | undefined;
    return row?.max_end ?? null;
  }

  /**
   * 批量追加 blocks（只 INSERT，不 DELETE）
   *
   * 2026-07-07 新增：增量落盘策略，历史不可变。
   * 与 upsertMany 的区别：不删除任何旧数据，只追加新 blocks。
   * block.id 若未提供则自动生成；createdAt/updatedAt 由本方法统一填充。
   */
  insertMany(dateKey: string, blocks: TimelineBlock[]): void {
    if (blocks.length === 0) return;
    const now = new Date().toISOString();
    const insertStmt = this.db.prepare(
      `INSERT INTO timeline_blocks (
        id, date_key, start_at, end_at, title, summary, category,
        project_ids_json, project_names_json, highlights_json,
        generated_tasks_json, generated_decisions_json,
        reportable, private_risk, private_risk_reason, confidence,
        source_scene_ids_json, source_fact_ids_json, source_observation_ids_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const txn = this.db.transaction(() => {
      for (const block of blocks) {
        const id = block.id ?? generateId("tb");
        insertStmt.run(
          id,
          dateKey,
          block.startAt,
          block.endAt,
          block.title,
          block.summary,
          block.category,
          JSON.stringify(block.projectIds ?? []),
          JSON.stringify(block.projectNames ?? []),
          JSON.stringify(block.highlights ?? []),
          JSON.stringify(block.generatedTasks ?? []),
          JSON.stringify(block.generatedDecisions ?? []),
          block.reportable ? 1 : 0,
          block.privateRisk,
          block.privateRiskReason ?? null,
          block.confidence ?? null,
          JSON.stringify(block.sourceSceneIds ?? []),
          JSON.stringify(block.sourceFactIds ?? []),
          JSON.stringify(block.sourceObservationIds ?? []),
          now,
          now
        );
      }
    });
    txn();
  }

  /**
   * 批量 upsert（同 date_key 替换：先删除当天所有，再插入新的）
   *
   * @deprecated 2026-07-07：全量替换策略已废弃，改为增量落盘（insertMany）。
   * 仅保留用于存量数据清理场景（手动清空某天重建）。
   *
   * 实现策略：事务内
   *   1. DELETE FROM timeline_blocks WHERE date_key = ?
   *   2. INSERT 全部新 blocks
   *
   * 说明：timeline_blocks 表不设唯一约束，便于按 date_key 批量替换。
   * block.id 若未提供则自动生成；createdAt/updatedAt 由本方法统一填充。
   */
  upsertMany(dateKey: string, blocks: TimelineBlock[]): void {
    const now = new Date().toISOString();
    const deleteStmt = this.db.prepare(
      "DELETE FROM timeline_blocks WHERE date_key = ?"
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO timeline_blocks (
        id, date_key, start_at, end_at, title, summary, category,
        project_ids_json, project_names_json, highlights_json,
        generated_tasks_json, generated_decisions_json,
        reportable, private_risk, private_risk_reason, confidence,
        source_scene_ids_json, source_fact_ids_json, source_observation_ids_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const txn = this.db.transaction(() => {
      deleteStmt.run(dateKey);
      for (const block of blocks) {
        const id = block.id ?? generateId("tb");
        insertStmt.run(
          id,
          dateKey,
          block.startAt,
          block.endAt,
          block.title,
          block.summary,
          block.category,
          JSON.stringify(block.projectIds ?? []),
          JSON.stringify(block.projectNames ?? []),
          JSON.stringify(block.highlights ?? []),
          JSON.stringify(block.generatedTasks ?? []),
          JSON.stringify(block.generatedDecisions ?? []),
          block.reportable ? 1 : 0,
          block.privateRisk,
          block.privateRiskReason ?? null,
          block.confidence ?? null,
          JSON.stringify(block.sourceSceneIds ?? []),
          JSON.stringify(block.sourceFactIds ?? []),
          JSON.stringify(block.sourceObservationIds ?? []),
          now,
          now
        );
      }
    });
    txn();
  }

  /**
   * 查询某天的所有 timeline blocks，按 start_at 升序
   */
  findByDateKey(dateKey: string): TimelineBlock[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM timeline_blocks WHERE date_key = ? ORDER BY start_at ASC"
      )
      .all(dateKey) as TimelineBlockRow[];
    return rows.map((row) => this.rowToTimelineBlock(row));
  }

  findOverlapping(dateKey: string, start: string, end: string): TimelineBlock[] {
    const rows = this.db.prepare(
      "SELECT * FROM timeline_blocks WHERE date_key = ? AND end_at >= ? AND start_at < ? ORDER BY start_at ASC"
    ).all(dateKey, start, end) as TimelineBlockRow[];
    return rows.map((row) => this.rowToTimelineBlock(row));
  }

  getProtectedIds(dateKey: string): Set<string> {
    const ids = new Set<string>();
    const collect = (sql: string, ...args: unknown[]) => {
      for (const row of this.db.prepare(sql).all(...args) as Array<{ id: string }>) ids.add(row.id);
    };
    collect(`SELECT DISTINCT value AS id FROM report_selections, json_each(selected_timeline_block_ids_json)
      WHERE date_key = ? UNION SELECT DISTINCT value AS id FROM report_selections, json_each(excluded_timeline_block_ids_json) WHERE date_key = ?`, dateKey, dateKey);
    collect(`SELECT DISTINCT value AS id FROM reports,
      json_each(CASE WHEN json_valid(content_json) THEN json_extract(content_json, '$.sourceTimelineBlockIds') ELSE '[]' END)
      WHERE date_key = ?`, dateKey);
    collect(`SELECT DISTINCT value AS id FROM unfinished_threads, json_each(source_timeline_block_ids_json) WHERE date_key = ?`, dateKey);
    return ids;
  }

  /** Replace mutable overlapping blocks and advance the checkpoint atomically. */
  replaceWindowAndCheckpoint(input: TimelineWindowReplacement): TimelineBlock[] {
    const result: TimelineBlock[] = [];
    this.db.transaction(() => {
      const existing = this.findOverlapping(input.dateKey, input.windowStart, input.windowEnd);
      const protectedIds = this.getProtectedIds(input.dateKey);
      const mutable = existing.filter((block) => !protectedIds.has(block.id));
      const protectedBlocks = existing.filter((block) => protectedIds.has(block.id));
      const usedIds = new Set<string>();
      const inherited = input.blocks.filter((block) =>
        !protectedBlocks.some((protectedBlock) => sourceOverlap(block, protectedBlock) > 0)
      ).map((block) => {
        let best: TimelineBlock | undefined;
        let bestOverlap = 0;
        for (const old of mutable) {
          if (usedIds.has(old.id)) continue;
          const overlap = sourceOverlap(block, old);
          if (overlap > bestOverlap) { best = old; bestOverlap = overlap; }
        }
        const id = best ? best.id : generateId("tb");
        if (best) usedIds.add(best.id);
        return { ...block, id };
      });
      if (mutable.length > 0) {
        const placeholders = mutable.map(() => "?").join(",");
        this.db.prepare(`DELETE FROM timeline_blocks WHERE id IN (${placeholders})`).run(...mutable.map((block) => block.id));
      }
      this.insertMany(input.dateKey, inherited);
      this.db.prepare(`INSERT INTO timeline_build_checkpoints (date_key, processed_through, updated_at)
        VALUES (?, ?, ?) ON CONFLICT(date_key) DO UPDATE SET processed_through=excluded.processed_through, updated_at=excluded.updated_at`)
        .run(input.dateKey, input.processedThrough, new Date().toISOString());
      result.push(...protectedBlocks, ...inherited);
    })();
    return result.sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  /**
   * 删除某天的所有 timeline blocks
   */
  deleteByDateKey(dateKey: string): void {
    this.db
      .prepare("DELETE FROM timeline_blocks WHERE date_key = ?")
      .run(dateKey);
  }

  /**
   * 查询单个 timeline block by id
   */
  findById(id: string): TimelineBlock | null {
    const row = this.db
      .prepare("SELECT * FROM timeline_blocks WHERE id = ?")
      .get(id) as TimelineBlockRow | undefined;
    return row ? this.rowToTimelineBlock(row) : null;
  }

  // ============================================================================
  // 内部辅助
  // ============================================================================

  /**
   * row 映射到 TimelineBlock
   *
   * 009 迁移已补全 private_risk_reason / confidence 字段持久化，
   * 映射时按 null-safe 读取（旧数据可能为 NULL）。
   */
  private rowToTimelineBlock(row: TimelineBlockRow): TimelineBlock {
    return {
      id: row.id,
      dateKey: row.date_key,
      startAt: row.start_at,
      endAt: row.end_at,
      title: row.title,
      summary: row.summary,
      category: row.category as TimelineBlock["category"],
      projectIds: safeParseArray(row.project_ids_json),
      projectNames: safeParseArray(row.project_names_json),
      highlights: safeParseArray(row.highlights_json),
      generatedTasks: safeParseArray(row.generated_tasks_json),
      generatedDecisions: safeParseArray(row.generated_decisions_json),
      reportable: row.reportable === 1,
      privateRisk: row.private_risk as TimelineBlock["privateRisk"],
      privateRiskReason: row.private_risk_reason ?? undefined,
      confidence: row.confidence ?? undefined,
      sourceSceneIds: safeParseArray(row.source_scene_ids_json),
      sourceFactIds: safeParseArray(row.source_fact_ids_json),
      sourceObservationIds: safeParseArray(row.source_observation_ids_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

export function createTimelineBlockRepository(db: DB): TimelineBlockRepository {
  return new TimelineBlockRepository(db);
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

function sourceOverlap(a: TimelineBlock, b: TimelineBlock): number {
  return intersectionSize(a.sourceObservationIds, b.sourceObservationIds)
    + intersectionSize(a.sourceSceneIds, b.sourceSceneIds)
    + intersectionSize(a.sourceFactIds, b.sourceFactIds);
}

function intersectionSize(a: string[], b: string[]): number {
  const values = new Set(a);
  return b.reduce((count, value) => count + (values.has(value) ? 1 : 0), 0);
}
