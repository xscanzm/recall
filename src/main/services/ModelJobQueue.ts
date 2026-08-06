// src/main/services/ModelJobQueue.ts
// 并发和队列（来自 03 文档 + 多模态统一架构改造）
//
// 职责：
// - 统一多模态任务队列（原视觉 + LLM 双队列已合并）
// - 并发上限 3（可配置），支持多 capture 并行处理
// - 同一 capture 不重复提交
// - 失败任务可重试，最多 2 次（总尝试 3 次）
// - 用户暂停后，正在进行的任务可完成，但不再接受新任务
// - model_jobs 表状态持久化
//
// 设计：
// - 统一 multimodalQueue：所有模型任务（observer_extractor/linker_scene_judge/timeline_builder 等）共用
// - 并发池：最多 3 个并发（MULTIMODAL_CONCURRENCY）
// - 同一 captureId 去重：避免重复提交
// - 暂停后：不再接受新任务，正在执行的可完成
//
// 重要约束：
// - 不持有 API Key
// - 不在队列层做模型调用（由 Worker 调用 ModelGateway）
// - 队列只负责任务调度和状态管理
// - 实际的 model_job 持久化由 ModelGateway 完成（创建/标记成功/标记失败）
//   本队列只负责调度和重试控制

import type { ModelJobRepository } from "../db/repositories/ModelJobRepository";
import { generateId } from "../utils/id";

/**
 * 任务类型（来自 spec.md + 多模态统一架构改造）
 *
 * 合并后的类型：
 * - observer_extractor：原 observer + extractor 合并
 * - linker_scene_judge：原 linker + scene_builder + judge 合并
 *
 * 保留的类型（仅切换到 callMultimodal）：
 * - reporter / timeline_builder / personal_review
 *
 * 兼容类型（旧 Worker 迁移期间使用）：
 * - observer / extractor / linker / scene_builder / judge / json_repair
 */
export type ModelJobType =
  // 新合并类型
  | "observer_extractor"
  | "observer_extractor_batch"
  | "observer_batch"
  | "episode_fact_extractor"
  | "linker_scene_judge"
  | "personal_review"
  // 兼容旧类型（迁移完成后可删除）
  | "observer"
  | "extractor"
  | "linker"
  | "scene_builder"
  | "judge"
  | "reporter"
  | "timeline_builder"
  | "json_repair";

/**
 * 任务执行函数
 * 由 Worker 提供，实际调用 ModelGateway
 *
 * 返回值：
 * - ok=true：执行成功
 * - ok=false：执行失败，errorCode 用于决定是否重试
 */
export interface JobExecutor<T = unknown> {
  /** 实际执行函数 */
  execute: () => Promise<JobResult<T>>;
}

/**
 * 任务执行结果
 */
export interface JobResult<T = unknown> {
  ok: boolean;
  data?: T;
  errorCode?: string;
  errorMessage?: string;
  /** model_job id（由 ModelGateway 创建） */
  modelJobId?: string;
  /** ModelGateway 的原始字段，队列会归一化为 modelJobId */
  jobId?: string;
  /** 队列逻辑任务的总尝试次数 */
  attempts?: number;
  /** Actual HTTP calls consumed by this executor invocation. */
  requestCount?: number;
  retryAfterMs?: number | null;
  rateLimitKey?: string;
  latencyMs?: number;
}

/**
 * 可重试的错误码（仅这些错误会重试）
 * - timeout：网络超时，重试可能成功
 * - network_error：临时网络问题，重试可能成功
 * - rate_limited：限流，重试可能成功
 * - invalid_json：偶发性 JSON 错误，重试可能成功
 * - schema_invalid：偶发性 schema 错误，重试可能成功
 * - async_poll_timeout：本地轮询超时，可重试——幂等键已持有远端 jobId，
 *   重提不会重复生成；区别于 upstream_timeout（520/524）的未知状态风险
 *
 * 不重试的错误码：
 * - upstream_timeout：520/524 或远端状态未知，重试可能重复生成
 * - auth_error：鉴权失败，重试无用
 * - safety_blocked：安全阻断，不重试
 * - unknown_error：未知错误，不重试避免循环
 */
const RETRYABLE_ERROR_CODES = new Set([
  "timeout",
  "network_error",
  "rate_limited",
  "invalid_json",
  "schema_invalid",
  "async_poll_timeout",
]);

/**
 * 最大尝试次数（含首次）
 * spec.md 要求"失败任务重试最多 2 次"，即总尝试 3 次
 */
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function parseRetryAfterMs(headerValue?: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.round(diff)) : 0;
  }
  return null;
}

/**
 * 带有 Full Jitter 的指数退避时间计算（毫秒）
 */
export function computeBackoffWithJitter(
  errorCode: string | undefined,
  attempts: number,
  retryAfterMs?: number | null
): number {
  if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
    return retryAfterMs;
  }
  let baseMs = 1000;
  let maxMs = 4000;
  if (errorCode === "rate_limited") {
    baseMs = 10000;
    maxMs = 60000;
  } else if (errorCode === "network_error") {
    baseMs = 5000;
    maxMs = 30000;
  }
  const calculatedMax = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempts - 1)));
  // Full Jitter 随机在 [0, calculatedMax] 之间选择
  return Math.floor(Math.random() * calculatedMax);
}

/** 单任务最大累计 HTTP 请求次数预算上限 */
export const MAX_TOTAL_REQUEST_BUDGET = 6;

/**
 * 多模态任务并发上限
 *
 * 统一模型任务最多 3 个并发，给 OCR、批处理和渲染线程留出 CPU 余量。
 */
export const MULTIMODAL_CONCURRENCY = 3;

/**
 * 内部任务条目
 */
interface QueueEntry<T = unknown> {
  /** 唯一任务 id（非 model_job id） */
  id: string;
  /** 任务类型 */
  type: ModelJobType;
  /** 关联的 captureId（用于去重；部分任务可能没有） */
  captureId?: string;
  /** 执行函数 */
  executor: () => Promise<JobResult<T>>;
  /** resolve 回调（外部 await 此任务时） */
  resolve: (result: JobResult<T>) => void;
  /** reject 回调（执行异常时） */
  reject: (err: Error) => void;
  /** 当前尝试次数 */
  attempts: number;
  /** 创建时间（用于排序） */
  createdAt: number;
  /** 优先级：数字越小越先执行 */
  priority: number;
  /** 去重键：相同 key 的 pending/running 任务复用同一个 Promise */
  dedupeKey?: string;
  rateLimitKey?: string;
  notBefore: number;
  requestCount: number;
  lastResult?: JobResult<T>;
}

/**
 * 队列状态
 */
export interface QueueStatus {
  /** 待执行的任务数 */
  pending: number;
  /** 执行中的任务数 */
  running: number;
  retries: number;
  /** 是否已暂停 */
  paused: boolean;
}

/**
 * ModelJobQueue：模型任务队列调度器（多模态统一架构）
 *
 * 设计要点：
 * 1. 统一 multimodalQueue：所有模型任务共用一个队列
 * 2. 并发池：最多 3 个并发（MULTIMODAL_CONCURRENCY）
 * 3. 同一 captureId 去重：避免重复提交同一捕获
 * 4. 暂停后：不再接受新任务，正在执行的可完成
 * 5. 失败重试：仅对可重试错误码重试，最多 2 次（总 3 次）
 * 6. model_jobs 持久化：由 ModelGateway 完成，本队列仅做调度
 */
export class ModelJobQueue {
  private readonly modelJobRepo: ModelJobRepository | null;
  private readonly multimodalQueue: QueueEntry[] = [];
  private runningCount = 0;
  private retryCount = 0;
  private isPaused = false;
  private isStopping = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly drainWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** 已提交的 captureId:type 集合（用于去重） */
  private readonly submittedCaptureIds = new Set<string>();
  /** dedupe key -> 正在等待或执行的 Promise */
  private readonly pendingByDedupeKey = new Map<string, Promise<JobResult<unknown>>>();
  /** endpoint/configId -> cooldown 到期时间戳 */
  private readonly endpointCooldownUntil = new Map<string, number>();

  constructor(deps: { modelJobRepo?: ModelJobRepository } = {}) {
    this.modelJobRepo = deps.modelJobRepo ?? null;
  }

  setEndpointCooldown(endpointOrConfigId: string, durationMs: number): void {
    if (!endpointOrConfigId) return;
    const until = Date.now() + Math.max(0, Math.min(MAX_RETRY_AFTER_MS, durationMs));
    this.endpointCooldownUntil.set(endpointOrConfigId, until);
    this.scheduleWakeup();
  }

  isEndpointInCooldown(endpointOrConfigId: string): boolean {
    if (!endpointOrConfigId) return false;
    const until = this.endpointCooldownUntil.get(endpointOrConfigId);
    if (!until) return false;
    if (Date.now() >= until) {
      this.endpointCooldownUntil.delete(endpointOrConfigId);
      return false;
    }
    return true;
  }

  /**
   * 提交多模态任务（统一入口）
   *
   * @param input 任务输入
   * @returns 任务执行结果
   *
   * 去重逻辑：
   * - 如果同一 dedupeKey 已提交且未完成，复用同一个 Promise
   * - 如果同一 captureId:type 已提交且未完成，返回 ok=false, errorCode=duplicate
   * - 暂停状态：返回 ok=false, errorCode=paused
   */
  async enqueueMultimodalJob<T = unknown>(input: {
    type: ModelJobType;
    captureId?: string;
    priority?: number;
    dedupeKey?: string;
    rateLimitKey?: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    // 暂停状态检查
    if (this.isStopping || this.isPaused) {
      return {
        ok: false,
        errorCode: this.isStopping ? "stopped" : "paused",
        errorMessage: this.isStopping ? "队列正在停止，不再接受新任务" : "队列已暂停，不再接受新任务",
        requestCount: 0,
      };
    }

    // dedupeKey 复用
    if (input.dedupeKey) {
      const existing = this.pendingByDedupeKey.get(input.dedupeKey);
      if (existing) {
        return existing as Promise<JobResult<T>>;
      }
    }

    // captureId:type 去重（仅当提供 captureId 时）
    const dedupeKey = input.captureId ? `${input.type}:${input.captureId}` : null;
    if (dedupeKey && this.submittedCaptureIds.has(dedupeKey)) {
      return {
        ok: false,
        errorCode: "duplicate",
        errorMessage: `captureId ${input.captureId} 的 ${input.type} 任务已提交`,
      };
    }
    if (dedupeKey) {
      this.submittedCaptureIds.add(dedupeKey);
    }

    const promise = this.enqueueEntry<T>({
      type: input.type,
      captureId: input.captureId,
      priority: input.priority,
      dedupeKey: input.dedupeKey,
      rateLimitKey: input.rateLimitKey,
      executor: input.executor,
    });

    if (input.dedupeKey) {
      this.pendingByDedupeKey.set(input.dedupeKey, promise as Promise<JobResult<unknown>>);
      void promise.then(
        () => this.pendingByDedupeKey.delete(input.dedupeKey!),
        () => this.pendingByDedupeKey.delete(input.dedupeKey!)
      );
    }

    return promise;
  }

  /**
   * 提交视觉任务（兼容旧 Worker，内部转为 enqueueMultimodalJob）
   *
   * @deprecated 新代码请使用 enqueueMultimodalJob
   */
  async enqueueVisionJob<T = unknown>(input: {
    type: "observer";
    captureId: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    return this.enqueueMultimodalJob<T>({
      type: input.type,
      captureId: input.captureId,
      executor: input.executor,
    });
  }

  /**
   * 提交 LLM 任务（兼容旧 Worker，内部转为 enqueueMultimodalJob）
   *
   * @deprecated 新代码请使用 enqueueMultimodalJob
   */
  async enqueueLanguageJob<T = unknown>(input: {
    type:
      | "extractor"
      | "linker"
      | "scene_builder"
      | "judge"
      | "reporter"
      | "timeline_builder";
    captureId?: string;
    priority?: number;
    dedupeKey?: string;
    rateLimitKey?: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    return this.enqueueMultimodalJob<T>({
      type: input.type,
      captureId: input.captureId,
      priority: input.priority,
      dedupeKey: input.dedupeKey,
      rateLimitKey: input.rateLimitKey,
      executor: input.executor,
    });
  }

  /**
   * 暂停队列
   * - 不再接受新任务
   * - 正在执行的任务可完成
   */
  pause(): void {
    this.isPaused = true;
  }

  /**
   * 恢复队列
   */
  resume(): void {
    if (this.isStopping) return;
    this.isPaused = false;
    // 恢复后触发调度
    this.scheduleMultimodal();
  }

  /**
   * 是否已暂停
   */
  isQueuePaused(): boolean {
    return this.isPaused;
  }

  /**
   * 获取队列状态
   */
  getStatus(): QueueStatus {
    return {
      pending: this.multimodalQueue.length,
      running: this.runningCount,
      retries: this.retryCount,
      paused: this.isPaused,
    };
  }

  /** Stop accepting work, cancel queued retries, and wait for active executors to finish. */
  async stopAndDrainActive(timeoutMs: number = 30_000): Promise<void> {
    this.isStopping = true;
    this.isPaused = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    while (this.multimodalQueue.length > 0) {
      const entry = this.multimodalQueue.shift()!;
      entry.resolve(withQueueMetadata({
        ...(entry.lastResult ?? {}),
        ok: false,
        errorCode: "stopped",
        errorMessage: "应用退出，尚未执行的模型任务已取消",
      }, entry.attempts, entry.requestCount));
      this.cleanupEntry(entry);
    }

    if (this.runningCount === 0) return;
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drainWaiters.delete(waiter);
          reject(new Error(`ModelJobQueue drain timed out after ${timeoutMs}ms (${this.runningCount} active)`));
        }, Math.max(1, timeoutMs)),
      };
      this.drainWaiters.add(waiter);
    });
  }

  /**
   * 清理已完成的 captureId 记录
   * - 在任务完成后调用，避免 set 无限增长
   * - 保留最近完成的 captureId 一段时间，避免同一 capture 短时间内重复提交
   *
   * 简化实现：任务完成后立即从 set 中移除（允许同一 captureId 重新提交）
   */
  forgetCaptureId(captureId: string): void {
    this.submittedCaptureIds.delete(`observer:${captureId}`);
    this.submittedCaptureIds.delete(`observer_batch:${captureId}`);
    this.submittedCaptureIds.delete(`observer_extractor:${captureId}`);
    this.submittedCaptureIds.delete(`observer_extractor_batch:${captureId}`);
    this.submittedCaptureIds.delete(`linker_scene_judge:${captureId}`);
    // 兼容旧类型
    this.submittedCaptureIds.delete(`extractor:${captureId}`);
    this.submittedCaptureIds.delete(`linker:${captureId}`);
    this.submittedCaptureIds.delete(`scene_builder:${captureId}`);
    this.submittedCaptureIds.delete(`judge:${captureId}`);
  }

  // ----------------------------------------------------------------
  // 内部实现
  // ----------------------------------------------------------------

  /**
   * 入队条目
   */
  private enqueueEntry<T>(entry: {
    type: ModelJobType;
    captureId?: string;
    priority?: number;
    dedupeKey?: string;
    rateLimitKey?: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    return new Promise<JobResult<T>>((resolve, reject) => {
      const queueEntry: QueueEntry<T> = {
        id: generateJobId(),
        type: entry.type,
        captureId: entry.captureId,
        executor: entry.executor,
        resolve,
        reject,
        attempts: 0,
        createdAt: Date.now(),
        priority: entry.priority ?? 2,
        dedupeKey: entry.dedupeKey,
        rateLimitKey: entry.rateLimitKey,
        notBefore: 0,
        requestCount: 0,
      };

      this.multimodalQueue.push(queueEntry as QueueEntry<unknown>);
      this.scheduleMultimodal();
    });
  }

  /**
   * 调度多模态任务
   * - 检查并发数是否未达上限
   * - 暂停时不调度新任务（但正在执行的可完成）
   */
  private scheduleMultimodal(): void {
    // 暂停时不调度新任务
    if (this.isPaused) return;
    while (this.runningCount < MULTIMODAL_CONCURRENCY && this.multimodalQueue.length > 0) {
      const entry = this.shiftNextReadyEntry();
      if (!entry) break;
      this.runningCount++;
      void this.runEntryAttempt(entry);
    }
    if (this.multimodalQueue.length > 0) this.scheduleWakeup();
  }

  /**
   * 从队列中取下一项：优先级小的先执行，同优先级保持 FIFO。
   */
  private shiftNextReadyEntry(): QueueEntry | null {
    if (this.multimodalQueue.length === 0) return null;
    const now = Date.now();
    let bestIndex = -1;
    for (let i = 0; i < this.multimodalQueue.length; i++) {
      const candidate = this.multimodalQueue[i];
      if (this.getEligibleAt(candidate) > now) continue;
      if (bestIndex < 0) {
        bestIndex = i;
        continue;
      }
      const best = this.multimodalQueue[bestIndex];
      if (
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.createdAt < best.createdAt)
      ) {
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return null;
    const [entry] = this.multimodalQueue.splice(bestIndex, 1);
    return entry;
  }

  /**
   * 执行单个任务条目（含重试逻辑）
   */
  private async runEntryAttempt(entry: QueueEntry): Promise<void> {
    let requeued = false;
    try {
      entry.attempts++;
      let result: JobResult;
      try {
        result = await entry.executor();
      } catch (err) {
        result = {
          ok: false,
          errorCode: "unknown_error",
          errorMessage: err instanceof Error ? err.message : String(err),
          requestCount: 0,
        };
      }

      entry.requestCount += normalizeRequestCount(result.requestCount);
      entry.rateLimitKey = result.rateLimitKey ?? entry.rateLimitKey;
      entry.lastResult = result;

      const retryable = Boolean(result.errorCode && RETRYABLE_ERROR_CODES.has(result.errorCode));
      const budgetExhausted = entry.requestCount >= MAX_TOTAL_REQUEST_BUDGET;
      if (result.ok || !retryable || entry.attempts >= MAX_ATTEMPTS || budgetExhausted || this.isStopping) {
        const finalResult = budgetExhausted && !result.ok
          ? {
              ...result,
              errorMessage: `${result.errorMessage ?? "模型请求失败"}；已达到单任务 HTTP 请求预算 ${MAX_TOTAL_REQUEST_BUDGET}`,
            }
          : result;
        entry.resolve(withQueueMetadata(finalResult, entry.attempts, entry.requestCount));
        return;
      }

      const backoffMs = computeBackoffWithJitter(
        result.errorCode,
        entry.attempts,
        result.retryAfterMs
      );
      entry.notBefore = Date.now() + backoffMs;
      if (result.errorCode === "rate_limited" && entry.rateLimitKey) {
        this.setEndpointCooldown(entry.rateLimitKey, backoffMs);
      }
      this.multimodalQueue.push(entry);
      this.retryCount += 1;
      requeued = true;
    } catch (err) {
      // 不应到达此处
      const errorMessage = err instanceof Error ? err.message : String(err);
      entry.reject(new Error(errorMessage));
    } finally {
      this.runningCount--;
      if (!requeued) this.cleanupEntry(entry);
      this.notifyDrainIfIdle();
      this.scheduleMultimodal();
    }
  }

  private getEligibleAt(entry: QueueEntry): number {
    if (!entry.rateLimitKey) return entry.notBefore;
    const cooldownUntil = this.endpointCooldownUntil.get(entry.rateLimitKey) ?? 0;
    if (cooldownUntil <= Date.now()) {
      this.endpointCooldownUntil.delete(entry.rateLimitKey);
      return entry.notBefore;
    }
    return Math.max(entry.notBefore, cooldownUntil);
  }

  private scheduleWakeup(): void {
    if (this.isPaused || this.isStopping || this.multimodalQueue.length === 0) return;
    const earliest = Math.min(...this.multimodalQueue.map((entry) => this.getEligibleAt(entry)));
    const delay = Math.max(0, earliest - Date.now());
    if (delay === 0) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleMultimodal();
    }, delay);
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.captureId) this.forgetCaptureId(entry.captureId);
  }

  private notifyDrainIfIdle(): void {
    if (this.runningCount !== 0 || this.multimodalQueue.length !== 0) return;
    for (const waiter of this.drainWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.drainWaiters.clear();
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function generateJobId(): string {
  return generateId("qj_");
}

function withQueueMetadata<T>(result: JobResult<T>, attempts: number, requestCount: number): JobResult<T> {
  return {
    ...result,
    modelJobId: result.modelJobId ?? result.jobId,
    attempts,
    requestCount,
  };
}

function normalizeRequestCount(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 单例
 *
 * 注意：必须在 app.whenReady() 之后使用
 * modelJobRepo 可选（仅用于持久化状态查询）
 */
let _instance: ModelJobQueue | null = null;

export function getModelJobQueue(modelJobRepo?: ModelJobRepository): ModelJobQueue {
  if (!_instance) {
    _instance = new ModelJobQueue({ modelJobRepo });
  }
  return _instance;
}
