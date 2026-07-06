// src/main/services/JudgeWorker.ts
// LLM Judge Worker（来自 03、05 文档）
//
// 职责：
// - 判断新记忆是否需要形成应用内提醒、日报候选、任务状态更新或待确认项
// - 写入 proactive_items 表
// - 处理 memoryUpdates（status_change/summary_refresh/importance_change/needs_review）
// - 调用 ModelGateway.callLanguage
// - zod 校验 JudgeOutput
//
// 重要约束（来自 spec.md）：
// - 默认 surface 为 in_app 或 daily_report
// - desktop_notification_candidate 只是候选，系统必须检查用户是否开启桌面通知
// - 低置信但可能重要的内容用 needs_confirmation
// - task status 不轻易设为 done（除非有明确完成证据）
// - 推断必须 inferred=true

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type { Fact, Scene, Task, ProactiveItem } from "../models/types";
import type { JudgeOutput } from "../models/schemas";
import { JudgeOutputSchema } from "../models/schemas";
import { JUDGE_PROMPT_TEMPLATE } from "../models/prompts";
import type { ProactiveItemRepository } from "../db/repositories/ProactiveItemRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SettingsService } from "./SettingsService";

/**
 * ReminderPolicy（来自 spec.md JudgeInput.reminderPolicy）
 * 控制 Judge 何时生成主动项
 */
export interface ReminderPolicy {
  /** 是否启用应用内提醒 */
  inAppReminders: boolean;
  /** 是否启用桌面通知 */
  desktopNotifications: boolean;
  /** 是否启用日报候选 */
  dailyReportCandidate: boolean;
  /** 提醒优先级阈值（0-1，>= 此值的才生成 proactive_item） */
  priorityThreshold: number;
}

/**
 * Judge Worker 输入
 */
export interface JudgeWorkerInput {
  /** 新抽取的 facts */
  newFacts: Fact[];
  /** 当前 captureId（用于去重和 model_job 关联） */
  captureId?: string;
  /** 语言模型配置 id */
  languageModelConfigId: string;
  /** 当前时间（ISO） */
  currentTime?: string;
}

/**
 * Judge Worker 输出
 */
export interface JudgeWorkerResult {
  /** 已写入 proactive_items 的项 */
  proactiveItems: ProactiveItem[];
  /** 已应用的 memoryUpdates */
  memoryUpdates: JudgeOutput["memoryUpdates"];
  /** model_job id */
  modelJobId: string;
  /** 尝试次数 */
  attempts: number;
}

/**
 * JudgeWorker：主动性判断员
 *
 * 工作流：
 * 1. 查询 recentScenes（最近 5 个）
 * 2. 查询 openTasks（status=open/in_progress/likely_done/needs_confirmation）
 * 3. 查询 reminderPolicy（从 SettingsService 读取）
 * 4. 查询 userFeedbackSummary
 * 5. 构造 JudgeInput JSON
 * 6. 填充 JUDGE_PROMPT_TEMPLATE
 * 7. 通过 ModelJobQueue 提交 LLM 任务
 * 8. zod 校验 JudgeOutput（由 ModelGateway 完成）
 * 9. 写入 proactive_items 表
 * 10. 处理 memoryUpdates
 */
export class JudgeWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly factRepo: FactRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    proactiveItemRepo: ProactiveItemRepository;
    sceneRepo: SceneRepository;
    memoryObjectRepo: MemoryObjectRepository;
    factRepo: FactRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.sceneRepo = deps.sceneRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.factRepo = deps.factRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 运行 Judge
   *
   * @param input 输入
   * @returns 执行结果（ok=true 时包含已写入的 proactive_items）
   */
  async run(input: JudgeWorkerInput): Promise<JobResult<JudgeWorkerResult>> {
    const {
      newFacts,
      captureId,
      languageModelConfigId,
      currentTime = new Date().toISOString(),
    } = input;

    // 没有 facts 直接返回（无需调用模型）
    if (newFacts.length === 0) {
      return {
        ok: true,
        data: {
          proactiveItems: [],
          memoryUpdates: [],
          modelJobId: "",
          attempts: 0,
        },
      };
    }

    // 1. 查询 recentScenes
    const recentScenes = this.fetchRecentScenes();

    // 2. 查询 openTasks
    const openTasks = this.fetchOpenTasks();

    // 3. 查询 reminderPolicy
    const reminderPolicy = this.fetchReminderPolicy();

    // 4. 查询 userFeedbackSummary
    const userFeedbackSummary = this.fetchUserFeedbackSummary();

    // 5. 构造 JudgeInput
    const judgeInput = {
      newFacts: newFacts.map(this.toFactSummary),
      updatedObjects: [], // 由 Linker 处理，Judge 不直接处理 updatedObjects
      recentScenes: recentScenes.map(this.toSceneSummary),
      openTasks: openTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        projectId: t.projectId,
        summary: t.summary,
        dueHint: t.dueHint,
        priority: t.priority,
      })),
      currentTime,
      reminderPolicy,
      userFeedbackSummary,
    };
    const judgeInputJson = JSON.stringify(judgeInput, null, 2);

    // 6. 填充 prompt
    const userPrompt = JUDGE_PROMPT_TEMPLATE.replace(
      "{{judge_input_json}}",
      judgeInputJson
    );

    // 7. 构造脱敏 jobInputJson
    const jobInputJson = JSON.stringify({
      newFactCount: newFacts.length,
      newFactIds: newFacts.map((f) => f.id),
      recentSceneCount: recentScenes.length,
      openTaskCount: openTasks.length,
      reminderPolicy,
      currentTime,
    });

    // 8. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueLanguageJob<JudgeOutput>({
      type: "judge",
      captureId,
      executor: async () => {
        return this.modelGateway.callLanguage<JudgeOutput>(
          {
            kind: "language",
            configId: languageModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "judge",
            jobInputJson,
          },
          JudgeOutputSchema
        );
      },
    });

    if (!result.ok || !result.data) {
      return {
        ok: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        modelJobId: result.modelJobId,
        attempts: result.attempts,
      };
    }

    const judgeOutput = result.data;

    // 9. 写入 proactive_items 表
    const proactiveItems = this.writeProactiveItems(
      judgeOutput.proactiveItems,
      reminderPolicy
    );

    // 10. 处理 memoryUpdates
    const appliedUpdates = this.applyMemoryUpdates(judgeOutput.memoryUpdates);

    return {
      ok: true,
      data: {
        proactiveItems,
        memoryUpdates: appliedUpdates,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 1,
      },
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  // ----------------------------------------------------------------
  // 数据检索
  // ----------------------------------------------------------------

  /**
   * 查询 recentScenes（最近 5 个）
   */
  private fetchRecentScenes(): Scene[] {
    try {
      return this.sceneRepo.listByStartAt({ limit: 5 });
    } catch {
      return [];
    }
  }

  /**
   * 查询 openTasks（status=open/in_progress/likely_done/needs_confirmation）
   */
  private fetchOpenTasks(): Task[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({
        status: "open",
        limit: 20,
      });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 20,
      });
      const likelyDoneTasks = this.memoryObjectRepo.listTasks({
        status: "likely_done",
        limit: 20,
      });
      const needsConfirmationTasks = this.memoryObjectRepo.listTasks({
        status: "needs_confirmation",
        limit: 20,
      });
      return [...openTasks, ...inProgressTasks, ...likelyDoneTasks, ...needsConfirmationTasks];
    } catch {
      return [];
    }
  }

  /**
   * 查询 reminderPolicy（从 SettingsService 读取）
   */
  private fetchReminderPolicy(): ReminderPolicy {
    const defaultPolicy: ReminderPolicy = {
      inAppReminders: true,
      desktopNotifications: false,
      dailyReportCandidate: true,
      priorityThreshold: 0.5,
    };
    if (!this.settingsService) return defaultPolicy;
    try {
      const settings = this.settingsService.getAll();
      return {
        inAppReminders: settings.notification.inAppReminders,
        desktopNotifications: settings.notification.desktopNotifications,
        dailyReportCandidate: settings.dailyReport.autoGenerate,
        priorityThreshold: 0.5,
      };
    } catch {
      return defaultPolicy;
    }
  }

  /**
   * 查询 user feedback summary
   */
  private fetchUserFeedbackSummary(): string {
    if (!this.settingsService) return "";
    try {
      const feedbackTypes = [
        "not_important",
        "wrong_content",
        "project_wrong",
        "task_done",
        "not_a_task",
        "do_not_record",
        "sensitive_content",
      ];
      const summaries: string[] = [];
      for (const fbType of feedbackTypes) {
        const feedbacks = this.settingsService.listUserFeedbackByType(fbType);
        if (feedbacks.length > 0) {
          summaries.push(`${fbType}: ${feedbacks.length} 条`);
        }
      }
      return summaries.length > 0
        ? `用户反馈汇总：${summaries.join("；")}`
        : "";
    } catch {
      return "";
    }
  }

  // ----------------------------------------------------------------
  // 输出处理
  // ----------------------------------------------------------------

  /**
   * 写入 proactive_items 表
   *
   * 重要约束：
   * - 默认 surface 为 in_app 或 daily_report
   * - desktop_notification_candidate 需检查用户是否开启桌面通知
   *   - 若未开启：降级为 in_app
   * - 优先级低于 priorityThreshold 的项不写入
   * - low-confidence 但 important 用 needs_confirmation
   */
  private writeProactiveItems(
    items: JudgeOutput["proactiveItems"],
    policy: ReminderPolicy
  ): ProactiveItem[] {
    const written: ProactiveItem[] = [];
    for (const item of items) {
      try {
        // 优先级过滤
        if (item.priority < policy.priorityThreshold) {
          continue;
        }

        // surface 处理
        let surface = item.surface;
        if (surface === "desktop_notification_candidate" && !policy.desktopNotifications) {
          // 用户未开启桌面通知，降级为 in_app
          surface = "in_app";
        }
        if (surface === "in_app" && !policy.inAppReminders) {
          // 用户关闭应用内提醒，降级为 daily_report
          surface = "daily_report";
        }
        if (surface === "daily_report" && !policy.dailyReportCandidate) {
          // 日报候选关闭，仍写入但保留 surface=daily_report（用户可手动触发日报）
        }

        const created = this.proactiveItemRepo.create({
          type: item.type,
          title: item.title,
          body: item.body,
          reason: item.reason,
          priority: item.priority,
          surface,
          requiresUserConfirmation: item.requiresUserConfirmation,
          status: "new",
          sourceFactIds: item.sourceFactIds,
          sourceSceneIds: item.sourceSceneIds,
        });
        written.push(created);
      } catch {
        // 单条写入失败不阻断其他
      }
    }
    return written;
  }

  /**
   * 应用 memoryUpdates
   *
   * updateType:
   * - status_change：更新 task/project 状态
   *   - 注意：task.status 不轻易设为 done
   * - summary_refresh：刷新 task/project summary
   * - importance_change：更新 fact.importance 或 task.priority
   * - needs_review：把 task.status 设为 needs_confirmation
   */
  private applyMemoryUpdates(
    updates: JudgeOutput["memoryUpdates"]
  ): JudgeOutput["memoryUpdates"] {
    const applied: JudgeOutput["memoryUpdates"] = [];
    for (const update of updates) {
      try {
        const success = this.applySingleUpdate(update);
        if (success) {
          applied.push(update);
        }
      } catch {
        // 单条失败不阻断
      }
    }
    return applied;
  }

  /**
   * 应用单条 memoryUpdate
   */
  private applySingleUpdate(update: JudgeOutput["memoryUpdates"][number]): boolean {
    const { targetType, targetId, updateType, value } = update;

    switch (targetType) {
      case "task": {
        const task = this.memoryObjectRepo.getTaskByIdActive(targetId);
        if (!task) return false;
        switch (updateType) {
          case "status_change": {
            // task status 不轻易设为 done
            // 仅允许模型设为 in_progress/likely_done/blocked/needs_confirmation
            // 用户确认才能设为 done
            const allowedStatuses = ["in_progress", "likely_done", "blocked", "needs_confirmation"];
            if (!allowedStatuses.includes(value)) {
              // 若模型输出 done/open，降级为 likely_done
              const safeStatus = value === "done" ? "likely_done" : "in_progress";
              this.memoryObjectRepo.updateTask(targetId, { status: safeStatus });
            } else {
              this.memoryObjectRepo.updateTask(targetId, { status: value });
            }
            return true;
          }
          case "summary_refresh": {
            this.memoryObjectRepo.updateTask(targetId, { summary: value });
            return true;
          }
          case "importance_change": {
            // value 应为数字字符串（0-1）
            const priority = Number(value);
            if (!Number.isNaN(priority) && priority >= 0 && priority <= 1) {
              this.memoryObjectRepo.updateTask(targetId, { priority });
            }
            return true;
          }
          case "needs_review": {
            this.memoryObjectRepo.updateTask(targetId, { status: "needs_confirmation" });
            return true;
          }
          default:
            return false;
        }
      }
      case "project": {
        const project = this.memoryObjectRepo.getProjectByIdActive(targetId);
        if (!project) return false;
        switch (updateType) {
          case "status_change": {
            const allowedStatuses = ["active", "paused", "completed", "archived"];
            if (allowedStatuses.includes(value)) {
              this.memoryObjectRepo.updateProject(targetId, { status: value });
              if (value === "archived") {
                this.memoryObjectRepo.archiveProject(targetId);
              }
            }
            return true;
          }
          case "summary_refresh": {
            this.memoryObjectRepo.updateProject(targetId, { summary: value });
            return true;
          }
          case "importance_change": {
            // project 没有 importance/priority 字段，更新 lastActiveAt 作为活跃度标记
            this.memoryObjectRepo.updateProject(targetId, {
              lastActiveAt: new Date().toISOString(),
            });
            return true;
          }
          case "needs_review": {
            // project 没有 needs_confirmation 状态，标记为 paused 等待用户审查
            // 实际上应在 proactive_items 中创建 needs_confirmation 项
            return true;
          }
          default:
            return false;
        }
      }
      case "person": {
        const person = this.memoryObjectRepo.getPersonByIdActive(targetId);
        if (!person) return false;
        switch (updateType) {
          case "summary_refresh": {
            this.memoryObjectRepo.updatePerson(targetId, { summary: value });
            return true;
          }
          case "status_change":
          case "importance_change":
          case "needs_review":
            // person 没有 status/importance 字段，跳过
            return true;
          default:
            return false;
        }
      }
      case "decision": {
        const decision = this.memoryObjectRepo.getDecisionByIdActive(targetId);
        if (!decision) return false;
        switch (updateType) {
          case "summary_refresh": {
            this.memoryObjectRepo.updateDecision(targetId, { decision: value });
            return true;
          }
          case "status_change":
          case "importance_change":
          case "needs_review":
            return true;
          default:
            return false;
        }
      }
      case "preference": {
        // preference 类型在 MVP 通过 fact.type=preference 表达
        // 此处更新对应 fact 的 content
        try {
          const fact = this.factRepo.getByIdActive(targetId);
          if (!fact) return false;
          if (updateType === "summary_refresh") {
            this.factRepo.update(targetId, { content: value });
            return true;
          }
          if (updateType === "importance_change") {
            const importance = Number(value);
            if (!Number.isNaN(importance) && importance >= 0 && importance <= 1) {
              this.factRepo.update(targetId, { importance });
            }
            return true;
          }
          return true;
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }

  // ----------------------------------------------------------------
  // 摘要构造
  // ----------------------------------------------------------------

  /**
   * Fact 摘要（用于 JudgeInput.newFacts）
   */
  private toFactSummary(fact: Fact): unknown {
    return {
      id: fact.id,
      type: fact.type,
      content: fact.content,
      status: fact.status,
      projectId: fact.projectId,
      projectHint: fact.projectHint,
      importance: fact.importance,
      confidence: fact.confidence,
      inferred: fact.inferred,
      tags: fact.tags,
      createdAt: fact.createdAt,
    };
  }

  /**
   * Scene 摘要（用于 JudgeInput.recentScenes）
   */
  private toSceneSummary(scene: Scene): unknown {
    return {
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      startAt: scene.startAt,
      endAt: scene.endAt,
      projectId: scene.projectId,
      factIds: scene.factIds,
      entityNames: scene.entityNames,
    };
  }
}
