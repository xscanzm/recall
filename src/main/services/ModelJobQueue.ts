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
  /** 尝试次数 */
  attempts?: number;
}

/**
 * 可重试的错误码（仅这些错误会重试）
 * - timeout：网络超时，重试可能成功
 * - network_error：临时网络问题，重试可能成功
 * - rate_limited：限流，重试可能成功
 * - invalid_json：偶发性 JSON 错误，重试可能成功
 * - schema_invalid：偶发性 schema 错误，重试可能成功
 *
 * 不重试的错误码：
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
]);

/**
 * 最大尝试次数（含首次）
 * spec.md 要求"失败任务重试最多 2 次"，即总尝试 3 次
 */
const MAX_ATTEMPTS = 3;

/**
 * 计算重试退避时间（毫秒）
 *
 * - rate_limited：长退避（10s / 30s / 60s）
 *   多模态模型限流窗口通常需要 10s+ 才能恢复，1s/2s/4s 太短会再次触发 429
 * - 其他可重试错误（timeout/network_error/invalid_json/schema_invalid）：短退避（1s / 2s / 4s）
 * - unknown_error：短退避（1s / 2s / 4s）
 *
 * @param errorCode 错误码
 * @param attempts 当前尝试次数（从 1 开始）
 */
function computeBackoffMs(errorCode: string | undefined, attempts: number): number {
  if (errorCode === "rate_limited") {
    // 限流长退避：10s / 30s / 60s
    const longBackoffs = [10000, 30000, 60000];
    return longBackoffs[Math.min(attempts - 1, longBackoffs.length - 1)] ?? 60000;
  }
  // 默认短退避：1s / 2s / 4s
  return Math.min(1000 * Math.pow(2, attempts - 1), 4000);
}

/**
 * 多模态任务并发上限
 *
 * 改造前：vision=2, llm=1（串行）
 * 改造后：统一 3 并发（激进合并后单次 capture 只需 2 次调用，总调用量大幅下降，可安全提升并发）
 */
const MULTIMODAL_CONCURRENCY = 3;

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
}

/**
 * 队列状态
 */
export interface QueueStatus {
  /** 待执行的任务数 */
  pending: number;
  /** 执行中的任务数 */
  running: number;
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
  private isPaused = false;
  /** 已提交的 captureId:type 集合（用于去重） */
  private readonly submittedCaptureIds = new Set<string>();
  /** dedupe key -> 正在等待或执行的 Promise */
  private readonly pendingByDedupeKey = new Map<string, Promise<JobResult<unknown>>>();

  constructor(deps: { modelJobRepo?: ModelJobRepository } = {}) {
    this.modelJobRepo = deps.modelJobRepo ?? null;
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
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    // 暂停状态检查
    if (this.isPaused) {
      return {
        ok: false,
        errorCode: "paused",
        errorMessage: "队列已暂停，不再接受新任务",
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
    // 旧视觉任务的 captureId 去重语义：同一 captureId 不重复提交
    // 转换为新语义：observer:captureId
    const dedupeKey = `observer:${input.captureId}`;
    if (this.submittedCaptureIds.has(dedupeKey)) {
      return {
        ok: false,
        errorCode: "duplicate",
        errorMessage: `captureId ${input.captureId} 已提交，不重复处理`,
      };
    }
    // 不在这里 add，让 enqueueMultimodalJob 统一处理
    // 但 enqueueMultimodalJob 用 type:captureId 格式，这里需特殊处理
    this.submittedCaptureIds.add(dedupeKey);

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
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    return this.enqueueMultimodalJob<T>({
      type: input.type,
      captureId: input.captureId,
      priority: input.priority,
      dedupeKey: input.dedupeKey,
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
      paused: this.isPaused,
    };
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
    this.submittedCaptureIds.delete(`observer_extractor:${captureId}`);
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
      const entry = this.shiftNextEntry();
      if (!entry) break;
      this.runningCount++;
      void this.runEntry(entry);
    }
  }

  /**
   * 从队列中取下一项：优先级小的先执行，同优先级保持 FIFO。
   */
  private shiftNextEntry(): QueueEntry | null {
    if (this.multimodalQueue.length === 0) return null;
    let bestIndex = 0;
    for (let i = 1; i < this.multimodalQueue.length; i++) {
      const candidate = this.multimodalQueue[i];
      const best = this.multimodalQueue[bestIndex];
      if (
        candidate.priority < best.priority ||
        (candidate.priority === best.priority && candidate.createdAt < best.createdAt)
      ) {
        bestIndex = i;
      }
    }
    const [entry] = this.multimodalQueue.splice(bestIndex, 1);
    return entry;
  }

  /**
   * 执行单个任务条目（含重试逻辑）
   */
  private async runEntry(entry: QueueEntry): Promise<void> {
    try {
      let lastResult: JobResult | null = null;

      // 重试循环
      while (entry.attempts < MAX_ATTEMPTS) {
        entry.attempts++;
        try {
          const result = await entry.executor();
          lastResult = result;

          if (result.ok) {
            // 成功
            entry.resolve(result as JobResult<unknown>);
            return;
          }

          // 失败：检查是否可重试
          const errorCode = result.errorCode;
          if (!errorCode || !RETRYABLE_ERROR_CODES.has(errorCode)) {
            // 不可重试，直接返回失败
            entry.resolve(result as JobResult<unknown>);
            return;
          }

          // 可重试：检查是否还有重试机会
          if (entry.attempts >= MAX_ATTEMPTS) {
            // 已达最大尝试次数，返回失败
            entry.resolve(result as JobResult<unknown>);
            return;
          }

          // 等待重试退避
          // - rate_limited 单独走更长退避（10s/30s/60s），给限流窗口足够恢复时间
          // - 其他错误走短退避（1s/2s/4s）
          const backoffMs = computeBackoffMs(errorCode, entry.attempts);
          await sleep(backoffMs);
        } catch (err) {
          // executor 抛出异常
          const errorMessage = err instanceof Error ? err.message : String(err);
          lastResult = {
            ok: false,
            errorCode: "unknown_error",
            errorMessage,
            attempts: entry.attempts,
          };

          if (entry.attempts >= MAX_ATTEMPTS) {
            entry.resolve(lastResult);
            return;
          }

          // 异常也走重试（unknown_error 走短退避）
          const backoffMs = computeBackoffMs("unknown_error", entry.attempts);
          await sleep(backoffMs);
        }
      }

      // 兜底：所有尝试都失败
      if (lastResult) {
        entry.resolve(lastResult as JobResult<unknown>);
      } else {
        entry.resolve({
          ok: false,
          errorCode: "unknown_error",
          errorMessage: "任务执行失败且无结果",
          attempts: entry.attempts,
        });
      }
    } catch (err) {
      // 不应到达此处
      const errorMessage = err instanceof Error ? err.message : String(err);
      entry.reject(new Error(errorMessage));
    } finally {
      // 释放并发槽位
      this.runningCount--;
      // 清理 captureId 记录（允许同一 capture 重新提交）
      if (entry.captureId) {
        this.forgetCaptureId(entry.captureId);
      }
      // 触发下一次调度
      this.scheduleMultimodal();
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function generateJobId(): string {
  return `qj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
