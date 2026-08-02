// src/main/services/ModelJobRetentionService.ts
// model_jobs 调试载荷自动清理调度服务（todo 8，codebase-audit P1）
//
// 职责：
// - 应用启动后每日一次，清空 model_jobs 中 terminal 状态（succeeded/failed）且
//   超过保留期（默认 30 天）的行的调试载荷（raw_input_json / debug_events_json）
// - 行与其余字段全部保留；幂等可重复（已置 NULL 的行不会再次命中）
// - 保留期可用环境变量 RECALL_MODEL_JOB_DEBUG_RETENTION_DAYS 覆盖
// - 优雅停止：shutdownRuntime 在退出前调用 stop() 清理定时器
//
// 时间口径说明（Oracle r1 修正的落地）：
// 计划要求按 COALESCE(completed_at, created_at) 兜底，但 model_jobs 表
// （001_initial_schema.sql + 014/025 迁移）只有 created_at / updated_at，
// 不存在 completed_at 列。created_at NOT NULL 且对 failed 行同样存在，
// 因此按 created_at 过滤即等价于"以完成时间优先、创建时间兜底"的意图。

import type { DB } from "../db/Database";
import { logger } from "./Logger";

/** 调试载荷默认保留天数（习惯值，可用环境变量覆盖） */
export const MODEL_JOB_DEBUG_RETENTION_DAYS = 30;

/** 覆盖默认保留天数的环境变量名 */
export const MODEL_JOB_DEBUG_RETENTION_DAYS_ENV = "RECALL_MODEL_JOB_DEBUG_RETENTION_DAYS";

/** 每日清理间隔（毫秒） */
export const MODEL_JOB_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 解析保留天数：优先读环境变量，非法/非正数回退默认值。
 * 纯函数便于单测（默认参数注入 process.env）。
 */
export function resolveModelJobDebugRetentionDays(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env[MODEL_JOB_DEBUG_RETENTION_DAYS_ENV];
  if (raw === undefined || raw.trim() === "") return MODEL_JOB_DEBUG_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MODEL_JOB_DEBUG_RETENTION_DAYS;
  return parsed;
}

interface Dependencies {
  db: DB;
}

export class ModelJobRetentionService {
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly retentionDays: number;

  constructor(
    private readonly deps: Dependencies,
    retentionDays: number = resolveModelJobDebugRetentionDays()
  ) {
    this.retentionDays = retentionDays;
  }

  /**
   * 启动调度：立即（下一事件循环）清理一次，之后每天执行一次。
   * 幂等：已启动时调用为 no-op。
   */
  start(initialDelayMs = 0): void {
    if (this.timer || this.initialTimer) return;

    const runSafely = (): void => {
      try {
        const cleared = this.runOnce();
        logger.info({
          jobType: "model_job_debug_retention",
          status: "succeeded",
          message: `cleared debug payloads on ${cleared} terminal model_jobs (retention ${this.retentionDays}d)`,
        });
      } catch (error) {
        logger.warn({
          jobType: "model_job_debug_retention",
          status: "failed",
          errorCode: "scheduled_cleanup_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      runSafely();
    }, initialDelayMs);
    this.timer = setInterval(runSafely, MODEL_JOB_RETENTION_INTERVAL_MS);

    // 防止定时器阻止进程退出
    if (typeof this.timer.unref === "function") this.timer.unref();
    if (this.initialTimer && typeof this.initialTimer.unref === "function") {
      this.initialTimer.unref();
    }
  }

  /** 停止调度并清理定时器（shutdownRuntime 优雅停止时调用） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /**
   * 执行一次清理：terminal 状态且超过保留期的行清空调试载荷。
   * 幂等可重复；返回受影响行数。
   */
  runOnce(): number {
    const cutoff = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const result = this.deps.db
      .prepare(
        `UPDATE model_jobs
         SET raw_input_json = NULL, debug_events_json = NULL
         WHERE status IN ('succeeded', 'failed')
           AND created_at < ?`
      )
      .run(cutoff);
    return result.changes;
  }
}
