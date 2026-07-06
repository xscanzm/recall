// src/main/services/ModelJobQueue.ts
// 并发和队列（来自 03 文档）
//
// 职责：
// - 视觉任务可并发 1-2 个
// - LLM 任务按 observation/fact 顺序处理（FIFO）
// - 同一 capture 不重复提交
// - 失败任务可重试，最多 2 次（总尝试 3 次）
// - 用户暂停后，正在进行的任务可完成，但不再新增采集任务
// - model_jobs 表状态持久化
//
// 设计：
// - 视觉任务池：最多 2 个并发
// - LLM 任务队列：串行处理，避免对模型 endpoint 造成并发压力
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
 * 任务类型（来自 spec.md）
 */
export type ModelJobType =
  | "observer"
  | "extractor"
  | "linker"
  | "scene_builder"
  | "judge"
  | "reporter"
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
 * 视觉任务并发上限
 * spec.md 要求"视觉任务可并发 1-2 个"
 */
const VISION_CONCURRENCY = 2;

/**
 * 内部任务条目
 */
interface QueueEntry<T = unknown> {
  /** 唯一任务 id（非 model_job id） */
  id: string;
  /** 任务类型 */
  type: ModelJobType;
  /** 关联的 captureId（用于去重；LLM 任务可能没有） */
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
}

/**
 * 队列状态
 */
export interface QueueStatus {
  /** 待执行的视觉任务数 */
  pendingVision: number;
  /** 执行中的视觉任务数 */
  runningVision: number;
  /** 待执行的 LLM 任务数 */
  pendingLlm: number;
  /** 执行中的 LLM 任务数（0 或 1） */
  runningLlm: number;
  /** 是否已暂停 */
  paused: boolean;
}

/**
 * ModelJobQueue：模型任务队列调度器
 *
 * 设计要点：
 * 1. 视觉任务池：使用 Promise 池实现并发 1-2 个
 * 2. LLM 任务队列：串行处理，按 FIFO 顺序
 * 3. 同一 captureId 去重：避免重复提交同一捕获
 * 4. 暂停后：不再接受新任务，正在执行的可完成
 * 5. 失败重试：仅对可重试错误码重试，最多 2 次（总 3 次）
 * 6. model_jobs 持久化：由 ModelGateway 完成，本队列仅做调度
 */
export class ModelJobQueue {
  private readonly modelJobRepo: ModelJobRepository | null;
  private readonly visionQueue: QueueEntry[] = [];
  private readonly llmQueue: QueueEntry[] = [];
  private runningVisionCount = 0;
  private runningLlmCount = 0;
  private isPaused = false;
  /** 已提交的 captureId 集合（用于去重） */
  private readonly submittedCaptureIds = new Set<string>();
  /** LLM 队列处理中标志 */
  private isLlmProcessing = false;

  constructor(deps: { modelJobRepo?: ModelJobRepository } = {}) {
    this.modelJobRepo = deps.modelJobRepo ?? null;
  }

  /**
   * 提交视觉任务
   *
   * @param input 任务输入
   * @returns 任务执行结果
   *
   * 去重逻辑：
   * - 如果同一 captureId 已提交且未完成，返回 ok=false, errorCode=duplicate
   * - 暂停状态：返回 ok=false, errorCode=paused
   */
  async enqueueVisionJob<T = unknown>(input: {
    type: "observer";
    captureId: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    // 暂停状态检查
    if (this.isPaused) {
      return {
        ok: false,
        errorCode: "paused",
        errorMessage: "队列已暂停，不再接受新视觉任务",
      };
    }

    // 同一 capture 去重
    if (this.submittedCaptureIds.has(input.captureId)) {
      return {
        ok: false,
        errorCode: "duplicate",
        errorMessage: `captureId ${input.captureId} 已提交，不重复处理`,
      };
    }
    this.submittedCaptureIds.add(input.captureId);

    return this.enqueueEntry<T>({
      type: input.type,
      captureId: input.captureId,
      executor: input.executor,
      kind: "vision",
    });
  }

  /**
   * 提交 LLM 任务
   *
   * @param input 任务输入
   * @returns 任务执行结果
   *
   * 暂停状态：仍接受 LLM 任务（因为可能由已采集的 observation 触发的后续处理）
   * 但 pause 后不再接受新的 observer 任务（由 enqueueVisionJob 检查）
   *
   * 注意：spec.md "用户暂停后，正在进行的任务可完成，但不再新增采集任务"
   * - "采集任务" = observer 视觉任务
   * - LLM 后续处理（extractor/linker/judge）属于"正在进行的任务"的延续
   */
  async enqueueLanguageJob<T = unknown>(input: {
    type: "extractor" | "linker" | "scene_builder" | "judge" | "reporter";
    captureId?: string;
    executor: () => Promise<JobResult<T>>;
  }): Promise<JobResult<T>> {
    // captureId 去重（仅当提供 captureId 时）
    if (input.captureId && this.submittedCaptureIds.has(`llm:${input.captureId}:${input.type}`)) {
      return {
        ok: false,
        errorCode: "duplicate",
        errorMessage: `captureId ${input.captureId} 的 ${input.type} 任务已提交`,
      };
    }
    if (input.captureId) {
      this.submittedCaptureIds.add(`llm:${input.captureId}:${input.type}`);
    }

    return this.enqueueEntry<T>({
      type: input.type,
      captureId: input.captureId,
      executor: input.executor,
      kind: "llm",
    });
  }

  /**
   * 暂停队列
   * - 不再接受新的视觉任务（采集任务）
   * - 正在执行的任务可完成
   * - LLM 队列中的任务继续处理（属于"正在进行的任务"的延续）
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
    this.scheduleVision();
    this.scheduleLlm();
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
      pendingVision: this.visionQueue.length,
      runningVision: this.runningVisionCount,
      pendingLlm: this.llmQueue.length,
      runningLlm: this.runningLlmCount,
      paused: this.isPaused,
    };
  }

  /**
   * 清理已完成的 captureId 记录
   * - 在任务完成后调用，避免 set 无限增长
   * - 保留最近完成的 captureId 一段时间，避免同一 capture 短时间内重复提交
   *
   * 简化实现：任务完成后立即从 set 中移除（允许同一 captureId 重新提交）
   * - 实际上 observer 不会对同一 captureId 重复触发
   * - LLM 任务的 captureId 去重也只在 captureBundle 处理期间有效
   */
  forgetCaptureId(captureId: string): void {
    this.submittedCaptureIds.delete(captureId);
    this.submittedCaptureIds.delete(`llm:${captureId}:extractor`);
    this.submittedCaptureIds.delete(`llm:${captureId}:linker`);
    this.submittedCaptureIds.delete(`llm:${captureId}:scene_builder`);
    this.submittedCaptureIds.delete(`llm:${captureId}:judge`);
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
    executor: () => Promise<JobResult<T>>;
    kind: "vision" | "llm";
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
      };

      if (entry.kind === "vision") {
        this.visionQueue.push(queueEntry as QueueEntry<unknown>);
        this.scheduleVision();
      } else {
        this.llmQueue.push(queueEntry as QueueEntry<unknown>);
        this.scheduleLlm();
      }
    });
  }

  /**
   * 调度视觉任务
   * - 检查并发数是否未达上限
   * - 暂停时不调度新任务（但正在执行的可完成）
   */
  private scheduleVision(): void {
    // 暂停时不调度新任务
    if (this.isPaused) return;
    while (this.runningVisionCount < VISION_CONCURRENCY && this.visionQueue.length > 0) {
      const entry = this.visionQueue.shift()!;
      this.runningVisionCount++;
      void this.runEntry(entry, "vision");
    }
  }

  /**
   * 调度 LLM 任务（串行）
   * - 同一时刻只处理 1 个 LLM 任务
   * - 不受 pause 影响（pause 只阻断新视觉任务）
   */
  private scheduleLlm(): void {
    if (this.isLlmProcessing) return;
    if (this.llmQueue.length === 0) return;
    const entry = this.llmQueue.shift()!;
    this.isLlmProcessing = true;
    this.runningLlmCount = 1;
    void this.runEntry(entry, "llm");
  }

  /**
   * 执行单个任务条目（含重试逻辑）
   */
  private async runEntry(entry: QueueEntry, kind: "vision" | "llm"): Promise<void> {
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

          // 等待重试退避（指数退避：1s, 2s, 4s）
          const backoffMs = Math.min(1000 * Math.pow(2, entry.attempts - 1), 4000);
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

          // 异常也走重试
          const backoffMs = Math.min(1000 * Math.pow(2, entry.attempts - 1), 4000);
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
      if (kind === "vision") {
        this.runningVisionCount--;
        // 清理 captureId 记录（允许同一 capture 重新提交）
        if (entry.captureId) {
          this.forgetCaptureId(entry.captureId);
        }
        // 触发下一次调度
        this.scheduleVision();
      } else {
        this.isLlmProcessing = false;
        this.runningLlmCount = 0;
        if (entry.captureId) {
          this.forgetCaptureId(entry.captureId);
        }
        this.scheduleLlm();
      }
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
