// src/main/db/repositories/ModelJobRepository.ts
// model_jobs 表数据访问
//
// 用途（来自 03/06 文档）：
// - 所有模型调用（成功/失败）都写入 model_jobs
// - 失败状态码：timeout/network_error/auth_error/rate_limited/invalid_json/schema_invalid/safety_blocked/unknown_error
// - 错误不写入正式表（observations/facts/scenes 等），只写入 model_jobs
//
// 重要约束：
// - API Key 不进 input_json / output_json / error_message
// - 完整模型输入输出不进日志（除非用户开启开发调试）
// - input_json 由调用方负责脱敏后再传入

import type { DB } from "../Database";
import type { DebugEvent } from "../../models/types";
import { generateId } from "../../utils/id";

/**
 * model_job 状态
 */
export type ModelJobStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

/**
 * model_job 失败错误码（来自 03 文档）
 */
export type ModelJobErrorCode =
  | "timeout"
  | "network_error"
  | "upstream_timeout"
  | "async_poll_timeout"
  | "auth_error"
  | "rate_limited"
  | "invalid_json"
  | "schema_invalid"
  | "input_too_large"
  | "output_truncated"
  | "response_invalid"
  | "safety_blocked"
  | "unknown_error";

export interface ModelJobMetrics {
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedPromptTokens?: number | null;
  requestCount?: number | null;
  latencyMs?: number | null;
}

interface ModelJobRow {
  id: string;
  type: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  raw_input_json: string | null;
  debug_events_json: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_prompt_tokens?: number | null;
  request_count?: number | null;
  latency_ms?: number | null;
}

/**
 * ModelJob 领域模型
 */
export interface ModelJob {
  id: string;
  type: string;
  status: ModelJobStatus;
  inputJson: string;
  outputJson: string | null;
  errorCode: ModelJobErrorCode | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** 调试模式：完整 prompt 文本上下文（仅 verboseModelIO=true 时写入） */
  rawInputJson: string | null;
  /** 调试模式：各层丢弃/跳过事件 JSON 数组（仅 debug.enabled=true 时写入） */
  debugEventsJson: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedPromptTokens?: number | null;
  requestCount?: number | null;
  latencyMs?: number | null;
}

/**
 * 创建 model_job 输入
 */
export interface CreateModelJobInput {
  id?: string;
  type: string;
  inputJson: string;
}

/**
 * 更新 model_job 输入
 */
export interface UpdateModelJobInput {
  status?: ModelJobStatus;
  outputJson?: string | null;
  errorCode?: ModelJobErrorCode | null;
  errorMessage?: string | null;
  attempts?: number;
}

export class ModelJobRepository {
  constructor(private db: DB) {}

  /**
   * 创建 model_job（status 默认 pending）
   */
  create(input: CreateModelJobInput): ModelJob {
    const id = input.id ?? generateId("job");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO model_jobs (id, type, status, input_json, output_json, error_code, error_message, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)`
      )
      .run(id, input.type, "pending", input.inputJson, now, now);
    return this.getById(id)!;
  }

  /**
   * 按 id 查询
   */
  getById(id: string): ModelJob | null {
    const row = this.db.prepare("SELECT * FROM model_jobs WHERE id = ?").get(id) as
      | ModelJobRow
      | undefined;
    return row ? mapModelJobRow(row) : null;
  }

  /**
   * 标记为 running（开始执行）
   */
  markRunning(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE model_jobs SET status = 'running', updated_at = ? WHERE id = ?`
      )
      .run(now, id);
  }

  /**
   * 标记为 succeeded
   */
  markSucceeded(
    id: string,
    outputJson: string,
    attempts: number,
    rawInputJson?: string,
    debugEventsJson?: string,
    metrics?: ModelJobMetrics
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE model_jobs
         SET status = 'succeeded', output_json = ?, error_code = NULL, error_message = NULL, attempts = ?, updated_at = ?,
             raw_input_json = COALESCE(?, raw_input_json), debug_events_json = COALESCE(?, debug_events_json),
             prompt_tokens = ?, completion_tokens = ?, cached_prompt_tokens = ?, request_count = ?, latency_ms = ?
         WHERE id = ?`
      )
      .run(
        outputJson,
        attempts,
        now,
        rawInputJson ?? null,
        debugEventsJson ?? null,
        metrics?.promptTokens ?? null,
        metrics?.completionTokens ?? null,
        metrics?.cachedPromptTokens ?? null,
        metrics?.requestCount ?? null,
        metrics?.latencyMs ?? null,
        id
      );
  }

  /**
   * 标记为 failed
   */
  markFailed(
    id: string,
    errorCode: ModelJobErrorCode,
    errorMessage: string,
    attempts: number,
    outputJson: string | null = null,
    rawInputJson?: string,
    debugEventsJson?: string,
    metrics?: ModelJobMetrics
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE model_jobs
         SET status = 'failed', error_code = ?, error_message = ?, output_json = ?, attempts = ?, updated_at = ?,
             raw_input_json = COALESCE(?, raw_input_json), debug_events_json = COALESCE(?, debug_events_json),
             prompt_tokens = ?, completion_tokens = ?, cached_prompt_tokens = ?, request_count = ?, latency_ms = ?
         WHERE id = ?`
      )
      .run(
        errorCode,
        errorMessage,
        outputJson,
        attempts,
        now,
        rawInputJson ?? null,
        debugEventsJson ?? null,
        metrics?.promptTokens ?? null,
        metrics?.completionTokens ?? null,
        metrics?.cachedPromptTokens ?? null,
        metrics?.requestCount ?? null,
        metrics?.latencyMs ?? null,
        id
      );
  }

  /**
   * 按时间范围倒序查询（DebugPage 列表用）
   */
  listByTimeRange(startAt: string, endAt: string, limit: number = 200): ModelJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM model_jobs WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(startAt, endAt, limit) as ModelJobRow[];
    return rows.map(mapModelJobRow);
  }

  /** Append structured debug events without discarding events already stored for the job. */
  appendDebugEvents(jobId: string, events: DebugEvent[]): void {
    if (events.length === 0) return;
    const existing = this.getById(jobId);
    const existingEvents = existing?.debugEventsJson
      ? safeParseDebugEvents(existing.debugEventsJson)
      : [];
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE model_jobs SET debug_events_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify([...existingEvents, ...events]), now, jobId);
  }

  update(id: string, patch: UpdateModelJobInput): ModelJob | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.status !== undefined) { sets.push("status = ?"); params.push(patch.status); }
    if (patch.outputJson !== undefined) { sets.push("output_json = ?"); params.push(patch.outputJson); }
    if (patch.errorCode !== undefined) { sets.push("error_code = ?"); params.push(patch.errorCode); }
    if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); params.push(patch.errorMessage); }
    if (patch.attempts !== undefined) { sets.push("attempts = ?"); params.push(patch.attempts); }
    if (sets.length === 0) return this.getById(id);
    sets.push("updated_at = ?");
    params.push(new Date().toISOString(), id);
    this.db.prepare(`UPDATE model_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM model_jobs WHERE id = ?").run(id).changes > 0;
  }

  /**
   * 启动时清理：把所有 status='running' 的卡死任务标记为 failed
   */
  markStaleRunningJobs(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE model_jobs
         SET status = 'failed',
             error_code = 'unknown_error',
             error_message = '应用重启时清理未完成任务（status=running 的卡死任务）',
             updated_at = ?
         WHERE status = 'running'`
      )
      .run(now);
    return result.changes;
  }
}

export function createModelJobRepository(db: DB): ModelJobRepository {
  return new ModelJobRepository(db);
}

function mapModelJobRow(row: ModelJobRow): ModelJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status as ModelJobStatus,
    inputJson: row.input_json,
    outputJson: row.output_json,
    errorCode: row.error_code as ModelJobErrorCode | null,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rawInputJson: row.raw_input_json,
    debugEventsJson: row.debug_events_json,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
    cachedPromptTokens: row.cached_prompt_tokens ?? null,
    requestCount: row.request_count ?? null,
    latencyMs: row.latency_ms ?? null,
  };
}

function safeParseDebugEvents(json: string): DebugEvent[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as DebugEvent[]) : [];
  } catch {
    return [];
  }
}

