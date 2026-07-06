// src/main/services/ExtractorWorker.ts
// LLM Extractor Worker（来自 03、05 文档）
//
// 职责：
// - 从 L0 Observation 中抽取 L1 Facts
// - 把"看见了什么"变成"发生了什么/用户做了什么/可能要做什么"
// - 调用 ModelGateway.callLanguage
// - zod 校验 ExtractorOutput
// - 写入 facts 表（含 type/content/confidence/importance/sourceObservationIds/inferred）
// - 推断内容 inferred=true
// - task status 不轻易设为 done（除非有明确完成证据）
//
// 规则（来自 spec.md）：
// - 不要把所有屏幕文字都变成 fact
// - 只抽取有后续价值的信息
// - 推断必须标记 inferred=true
// - task status 不要轻易设为 done，除非有明确完成证据
//
// ExtractorInput 类型（来自 spec.md）：
//   currentObservation: Observation
//   recentObservations: ObservationSummary[]
//   activeKnownProjects: ProjectSummary[]
//   activeTasks: TaskSummary[]
//   userFeedbackSummary: string

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type { Observation, Fact, Project, Task } from "../models/types";
import type { ExtractorOutput } from "../models/schemas";
import { ExtractorOutputSchema } from "../models/schemas";
import { EXTRACTOR_PROMPT_TEMPLATE } from "../models/prompts";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { SettingsService } from "./SettingsService";

/**
 * Observation 摘要（用于 ExtractorInput.recentObservations）
 * 简化版的 Observation，避免传入完整 visibleContent 等大量数据
 */
export interface ObservationSummary {
  id: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  sceneSummary: string;
  possibleIntent: string | null;
}

/**
 * Project 摘要（用于 ExtractorInput.activeKnownProjects）
 */
export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  summary: string;
}

/**
 * Task 摘要（用于 ExtractorInput.activeTasks）
 */
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  summary: string | null;
}

/**
 * Extractor Worker 输入
 */
export interface ExtractorWorkerInput {
  /** 当前要处理的 observation */
  currentObservation: Observation;
  /** 语言模型配置 id */
  languageModelConfigId: string;
  /** 最近 observations 数量（默认 5-10） */
  recentObservationsCount?: number;
}

/**
 * Extractor Worker 输出
 */
export interface ExtractorWorkerResult {
  /** 已写入数据库的 facts */
  facts: Fact[];
  /** 已丢弃的噪声（来自模型） */
  discardedNoise: ExtractorOutput["discardedNoise"];
  /** model_job id */
  modelJobId: string;
  /** 尝试次数 */
  attempts: number;
}

/**
 * ExtractorWorker：事实提取员
 *
 * 工作流：
 * 1. 查询 recentObservations（最近 5-10 条）
 * 2. 查询 activeKnownProjects（status=active 的 projects）
 * 3. 查询 activeTasks（status=open/in_progress 的 tasks）
 * 4. 查询 userFeedbackSummary（最近的 user_feedback）
 * 5. 构造 ExtractorInput JSON
 * 6. 填充 EXTRACTOR_PROMPT_TEMPLATE
 * 7. 通过 ModelJobQueue 提交 LLM 任务
 * 8. ModelGateway.callLanguage 调用语言模型
 * 9. zod 校验 ExtractorOutput（由 ModelGateway 完成）
 * 10. 写入 facts 表
 */
export class ExtractorWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly factRepo: FactRepository;
  private readonly observationRepo: ObservationRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    factRepo: FactRepository;
    observationRepo: ObservationRepository;
    memoryObjectRepo: MemoryObjectRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.factRepo = deps.factRepo;
    this.observationRepo = deps.observationRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 运行 Extractor
   *
   * @param input 输入
   * @returns 执行结果（ok=true 时包含已写入的 facts）
   */
  async run(input: ExtractorWorkerInput): Promise<JobResult<ExtractorWorkerResult>> {
    const { currentObservation, languageModelConfigId, recentObservationsCount = 8 } = input;

    // 1. 查询 recent observations
    const recentObservations = this.fetchRecentObservations(
      currentObservation.id,
      recentObservationsCount
    );

    // 2. 查询 active projects
    const activeProjects = this.fetchActiveProjects();

    // 3. 查询 active tasks
    const activeTasks = this.fetchActiveTasks();

    // 4. 查询 user feedback summary
    const userFeedbackSummary = this.fetchUserFeedbackSummary();

    // 5. 构造 ExtractorInput
    const extractorInput = {
      currentObservation: this.toObservationSummary(currentObservation),
      recentObservations,
      activeKnownProjects: activeProjects,
      activeTasks,
      userFeedbackSummary,
    };
    const extractorInputJson = JSON.stringify(extractorInput, null, 2);

    // 6. 填充 prompt
    const userPrompt = EXTRACTOR_PROMPT_TEMPLATE.replace(
      "{{extractor_input_json}}",
      extractorInputJson
    );

    // 7. 构造脱敏 jobInputJson（不含完整 visibleContent，避免存储大量数据）
    const jobInputJson = JSON.stringify({
      observationId: currentObservation.id,
      captureId: currentObservation.captureId,
      recentObservationCount: recentObservations.length,
      activeProjectCount: activeProjects.length,
      activeTaskCount: activeTasks.length,
    });

    // 8. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueLanguageJob<ExtractorOutput>({
      type: "extractor",
      captureId: currentObservation.captureId,
      executor: async () => {
        return this.modelGateway.callLanguage<ExtractorOutput>(
          {
            kind: "language",
            configId: languageModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "extractor",
            jobInputJson,
          },
          ExtractorOutputSchema
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

    // 9. 写入 facts 表
    const facts: Fact[] = [];
    for (const factInput of result.data.facts) {
      try {
        const fact = this.factRepo.create({
          type: factInput.type,
          content: factInput.content,
          status: factInput.status ?? null,
          projectId: null, // 由 Linker 后续关联
          projectHint: factInput.projectHint ?? null,
          importance: factInput.importance,
          confidence: factInput.confidence,
          inferred: factInput.inferred, // 推断内容 inferred=true
          evidenceText: factInput.evidenceText,
          sourceObservationIds: factInput.sourceObservationIds.length > 0
            ? factInput.sourceObservationIds
            : [currentObservation.id], // 兜底：使用当前 observation
          tags: factInput.tags,
        });
        facts.push(fact);
      } catch {
        // 单条 fact 写入失败不阻断其他 fact
      }
    }

    return {
      ok: true,
      data: {
        facts,
        discardedNoise: result.data.discardedNoise,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 1,
      },
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  /**
   * 查询最近的 observations（不含当前 observation）
   */
  private fetchRecentObservations(
    excludeObservationId: string,
    count: number
  ): ObservationSummary[] {
    try {
      const observations = this.observationRepo.listByCapturedAt({ limit: count + 5 });
      return observations
        .filter((o) => o.id !== excludeObservationId)
        .slice(0, count)
        .map((o) => ({
          id: o.id,
          capturedAt: o.capturedAt,
          appName: o.appName,
          windowTitle: o.windowTitle,
          sceneSummary: o.sceneSummary,
          possibleIntent: o.possibleIntent,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 查询 active projects（status=active）
   */
  private fetchActiveProjects(): ProjectSummary[] {
    try {
      const projects = this.memoryObjectRepo.listProjects({ status: "active", limit: 10 });
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        summary: p.summary,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 查询 active tasks（status=open/in_progress）
   */
  private fetchActiveTasks(): TaskSummary[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({ status: "open", limit: 10 });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 10,
      });
      const allTasks = [...openTasks, ...inProgressTasks].slice(0, 20);
      return allTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        projectId: t.projectId,
        summary: t.summary,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 查询 user feedback summary
   * - 查询最近的 user_feedback
   * - 简化为字符串摘要
   */
  private fetchUserFeedbackSummary(): string {
    if (!this.settingsService) return "";
    try {
      // 查询最近 10 条 feedback，按类型分组聚合
      const recentFeedbackTypes = [
        "not_important",
        "wrong_content",
        "project_wrong",
        "task_done",
        "not_a_task",
        "do_not_record",
        "sensitive_content",
      ];
      const summaries: string[] = [];
      for (const fbType of recentFeedbackTypes) {
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

  /**
   * 将 Observation 转为 ExtractorInput 用的简化结构
   * - 包含完整 visibleContent（模型需要看见内容来抽取 facts）
   * - 但去除 screenshotPaths 等无关字段
   */
  private toObservationSummary(obs: Observation): unknown {
    return {
      id: obs.id,
      captureId: obs.captureId,
      capturedAt: obs.capturedAt,
      appName: obs.appName,
      windowTitle: obs.windowTitle,
      urlOrDomain: obs.urlOrDomain,
      captureReason: obs.captureReason,
      sceneSummary: obs.sceneSummary,
      visibleContent: obs.visibleContent,
      detectedEntities: obs.detectedEntities,
      possibleIntent: obs.possibleIntent,
      possibleTasks: obs.possibleTasks,
      possibleDecisions: obs.possibleDecisions,
      sensitivity: obs.sensitivity,
      confidence: obs.confidence,
      uncertainties: obs.uncertainties,
    };
  }
}
