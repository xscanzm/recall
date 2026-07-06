// src/main/services/LinkerWorker.ts
// LLM Linker Worker（来自 03、05 文档）
//
// 职责：
// - 把新 facts 关联到已有项目、任务、人物、决策和场景
// - 必要时建议创建新对象（project/task/person/decision/knowledge）
// - 检测重复对象时给出 mergeSuggestions（待用户确认）
// - 调用 ModelGateway.callLanguage
// - zod 校验 LinkerOutput
// - 处理 links：更新 target 对象的 source_fact_ids_json
// - 处理 newObjects：创建新 L3 MemoryObject
// - 处理 mergeSuggestions：写入 proactive_items 表作为 needs_confirmation
//
// 重要约束（来自 spec.md）：
// - 候选对象由代码先用关键词/embedding/时间窗口检索出来
// - Linker 不应该扫描全库
// - 不要强行关联
// - 推断必须标记 inferred=true
// - mergeSuggestions 必须经用户确认

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type { Fact, Scene, ProactiveItem } from "../models/types";
import type { LinkerOutput } from "../models/schemas";
import { LinkerOutputSchema } from "../models/schemas";
import { LINKER_PROMPT_TEMPLATE } from "../models/prompts";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { ProactiveItemRepository } from "../db/repositories/ProactiveItemRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SettingsService } from "./SettingsService";
import { logger } from "./Logger";

/**
 * Linker 候选 Project 摘要（简化结构，避免传入完整字段）
 */
export interface CandidateProjectSummary {
  id: string;
  name: string;
  summary: string;
  status: string;
  lastActiveAt: string | null;
}

/**
 * Linker 候选 Task 摘要
 */
export interface CandidateTaskSummary {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  summary: string | null;
}

/**
 * Linker 候选 Person 摘要
 */
export interface CandidatePersonSummary {
  id: string;
  name: string;
  role: string | null;
  organization: string | null;
  summary: string;
}

/**
 * Linker 候选 Decision 摘要
 */
export interface CandidateDecisionSummary {
  id: string;
  title: string;
  decision: string;
  projectId: string | null;
  decidedAt: string | null;
}

/**
 * Linker Worker 输入
 */
export interface LinkerWorkerInput {
  /** 新抽取的 facts（待关联） */
  newFacts: Fact[];
  /** 当前 captureId（用于去重和 model_job 关联） */
  captureId?: string;
  /** 语言模型配置 id */
  languageModelConfigId: string;
}

/**
 * Linker Worker 输出
 */
export interface LinkerWorkerResult {
  /** 已建立的关联（已写入数据库） */
  links: LinkerOutput["links"];
  /** 已创建的新对象 */
  newObjects: LinkerOutput["newObjects"];
  /** 已写入 proactive_items 的合并建议 */
  mergeSuggestions: LinkerOutput["mergeSuggestions"];
  /** model_job id */
  modelJobId: string;
  /** 尝试次数 */
  attempts: number;
}

/**
 * LinkerWorker：记忆关联员
 *
 * 工作流：
 * 1. 检索候选 projects（status=active，最近 10 个，按 last_active_at 降序）
 * 2. 检索候选 tasks（status=open/in_progress，最近 20 个，按 updated_at 降序）
 * 3. 检索候选 people（最近 10 个）
 * 4. 检索候选 decisions（最近 5 个）
 * 5. 检索 recentScenes（最近 5 个）
 * 6. 查询 userFeedbackSummary
 * 7. 构造 LinkerInput JSON
 * 8. 填充 LINKER_PROMPT_TEMPLATE
 * 9. 通过 ModelJobQueue 提交 LLM 任务
 * 10. zod 校验 LinkerOutput（由 ModelGateway 完成）
 * 11. 处理 links：更新 target 对象的 source_fact_ids_json
 * 12. 处理 newObjects：创建新 L3 MemoryObject
 * 13. 处理 mergeSuggestions：写入 proactive_items 表
 */
export class LinkerWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly factRepo: FactRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    memoryObjectRepo: MemoryObjectRepository;
    sceneRepo: SceneRepository;
    proactiveItemRepo: ProactiveItemRepository;
    factRepo: FactRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.sceneRepo = deps.sceneRepo;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.factRepo = deps.factRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 运行 Linker
   *
   * @param input 输入
   * @returns 执行结果（ok=true 时包含已写入的关联和新对象）
   */
  async run(input: LinkerWorkerInput): Promise<JobResult<LinkerWorkerResult>> {
    const { newFacts, captureId, languageModelConfigId } = input;

    // 没有 facts 直接返回（无需调用模型）
    if (newFacts.length === 0) {
      return {
        ok: true,
        data: {
          links: [],
          newObjects: [],
          mergeSuggestions: [],
          modelJobId: "",
          attempts: 0,
        },
      };
    }

    // 1-5. 检索候选对象（不扫描全库）
    const candidateProjects = this.fetchCandidateProjects();
    const candidateTasks = this.fetchCandidateTasks();
    const candidatePeople = this.fetchCandidatePeople();
    const candidateDecisions = this.fetchCandidateDecisions();
    const recentScenes = this.fetchRecentScenes();

    // 6. 查询 user feedback summary
    const userFeedbackSummary = this.fetchUserFeedbackSummary();

    // 7. 构造 LinkerInput
    const linkerInput = {
      newFacts: newFacts.map(this.toFactSummary),
      candidateProjects,
      candidateTasks,
      candidatePeople,
      candidateDecisions,
      recentScenes: recentScenes.map(this.toSceneSummary),
      userFeedbackSummary,
    };
    const linkerInputJson = JSON.stringify(linkerInput, null, 2);

    // 8. 填充 prompt
    const userPrompt = LINKER_PROMPT_TEMPLATE.replace(
      "{{linker_input_json}}",
      linkerInputJson
    );

    // 9. 构造脱敏 jobInputJson（不含完整 fact 内容，避免存储大量数据）
    const jobInputJson = JSON.stringify({
      newFactCount: newFacts.length,
      newFactIds: newFacts.map((f) => f.id),
      candidateProjectCount: candidateProjects.length,
      candidateTaskCount: candidateTasks.length,
      candidatePeopleCount: candidatePeople.length,
      candidateDecisionCount: candidateDecisions.length,
      recentSceneCount: recentScenes.length,
    });

    // 10. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueLanguageJob<LinkerOutput>({
      type: "linker",
      captureId,
      executor: async () => {
        return this.modelGateway.callLanguage<LinkerOutput>(
          {
            kind: "language",
            configId: languageModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "linker",
            jobInputJson,
          },
          LinkerOutputSchema
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

    const linkerOutput = result.data;

    // 11. 处理 links：更新 target 对象的 source_fact_ids_json
    const processedLinks = this.processLinks(linkerOutput.links);

    // 12. 处理 newObjects：创建新 L3 MemoryObject
    const processedNewObjects = this.processNewObjects(linkerOutput.newObjects, captureId);

    // 13. 处理 mergeSuggestions：写入 proactive_items 表
    const processedMergeSuggestions = this.processMergeSuggestions(
      linkerOutput.mergeSuggestions
    );

    return {
      ok: true,
      data: {
        links: processedLinks,
        newObjects: processedNewObjects,
        mergeSuggestions: processedMergeSuggestions,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 1,
      },
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  // ----------------------------------------------------------------
  // 候选对象检索（不扫描全库）
  // ----------------------------------------------------------------

  /**
   * 候选 projects：status=active 的最近 10 个（按 last_active_at 降序）
   */
  private fetchCandidateProjects(): CandidateProjectSummary[] {
    try {
      const projects = this.memoryObjectRepo.listProjects({
        status: "active",
        limit: 10,
      });
      // 按 last_active_at 降序排序（listProjects 默认按 updated_at DESC，这里再次排序）
      return projects
        .slice()
        .sort((a, b) => {
          const aTime = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
          const bTime = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
          return bTime - aTime;
        })
        .map((p) => ({
          id: p.id,
          name: p.name,
          summary: p.summary,
          status: p.status,
          lastActiveAt: p.lastActiveAt,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 候选 tasks：status=open/in_progress 的最近 20 个（按 updated_at 降序）
   */
  private fetchCandidateTasks(): CandidateTaskSummary[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({
        status: "open",
        limit: 20,
      });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 20,
      });
      const allTasks = [...openTasks, ...inProgressTasks];
      // 按 updated_at 降序排序（listTasks 已默认按 updated_at DESC，再次排序确保合并后正确）
      return allTasks
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 20)
        .map((t) => ({
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
   * 候选 people：最近 10 个
   */
  private fetchCandidatePeople(): CandidatePersonSummary[] {
    try {
      const people = this.memoryObjectRepo.listPeople({ limit: 10 });
      return people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        organization: p.organization,
        summary: p.summary,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 候选 decisions：最近 5 个
   */
  private fetchCandidateDecisions(): CandidateDecisionSummary[] {
    try {
      const decisions = this.memoryObjectRepo.listDecisions({ limit: 5 });
      return decisions.map((d) => ({
        id: d.id,
        title: d.title,
        decision: d.decision,
        projectId: d.projectId,
        decidedAt: d.decidedAt,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 最近 scenes：5 个（按 start_at 降序）
   */
  private fetchRecentScenes(): Scene[] {
    try {
      return this.sceneRepo.listByStartAt({ limit: 5 });
    } catch {
      return [];
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
   * 处理 links：关联 fact 到现有对象
   * - 更新 target 对象的 source_fact_ids_json（追加新 factId）
   * - 若是 belongs_to project：更新 fact.project_id
   */
  private processLinks(links: LinkerOutput["links"]): LinkerOutput["links"] {
    const processed: LinkerOutput["links"] = [];
    for (const link of links) {
      try {
        // 追加 sourceFactId 到 target 对象的 sourceFactIds
        const updated = this.appendFactIdToTarget(
          link.targetType,
          link.targetId,
          link.sourceFactId
        );
        if (!updated) continue;

        // 若是 belongs_to project 关系：把 fact.project_id 设置为该项目
        if (
          link.relationship === "belongs_to" &&
          link.targetType === "project"
        ) {
          try {
            this.factRepo.update(link.sourceFactId, {
              projectId: link.targetId,
            });
          } catch {
            // 单条 fact 更新失败不阻断
          }
        }

        processed.push(link);
      } catch {
        // 单条 link 处理失败不阻断其他 link
      }
    }
    return processed;
  }

  /**
   * 把 factId 追加到 target 对象的 sourceFactIds
   * 返回是否成功
   */
  private appendFactIdToTarget(
    targetType: LinkerOutput["links"][number]["targetType"],
    targetId: string,
    factId: string
  ): boolean {
    try {
      switch (targetType) {
        case "project": {
          const obj = this.memoryObjectRepo.getProjectByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateProject(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
            lastActiveAt: new Date().toISOString(),
          });
          return true;
        }
        case "task": {
          const obj = this.memoryObjectRepo.getTaskByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateTask(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "person": {
          const obj = this.memoryObjectRepo.getPersonByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updatePerson(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "decision": {
          const obj = this.memoryObjectRepo.getDecisionByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateDecision(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "scene": {
          const obj = this.sceneRepo.getByIdActive(targetId);
          if (!obj) return false;
          if (obj.factIds.includes(factId)) return true;
          this.sceneRepo.update(targetId, {
            factIds: [...obj.factIds, factId],
          });
          return true;
        }
        case "knowledge":
          // knowledge 类型在 MVP 不单独建表，仅作为 link 目标记录
          // 真正的 knowledge 对象暂不持久化（M5+ 实现）
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * 处理 newObjects：创建新 L3 MemoryObject
   */
  private processNewObjects(
    newObjects: LinkerOutput["newObjects"],
    _captureId?: string
  ): LinkerOutput["newObjects"] {
    const processed: LinkerOutput["newObjects"] = [];
    for (const newObj of newObjects) {
      // M-4: MVP 阶段不支持 knowledge 对象创建（无对应存储表），过滤掉该类型建议
      if (newObj.objectType === "knowledge") {
        logger.info({
          jobType: "linker",
          message: `[LinkerWorker] 跳过 knowledge 对象创建建议（MVP 不支持）: ${newObj.title}`,
        });
        continue;
      }
      try {
        const created = this.createNewMemoryObject(newObj);
        if (created) {
          processed.push(newObj);
        }
      } catch {
        // 单条创建失败不阻断其他
      }
    }
    return processed;
  }

  /**
   * 创建新的 L3 MemoryObject
   *
   * 硬性去重 fallback（Checkpoint 7.4）：
   * - 创建前先调用对应去重查询；命中则改为把 sourceFactIds 追加到现有对象
   * - 去重仅是 fallback，不替代 Linker prompt 的 newObjects 决策
   * - 去重查询失败时静默回退到创建新对象（不阻断流程）
   */
  private createNewMemoryObject(
    newObj: LinkerOutput["newObjects"][number]
  ): boolean {
    const sourceFactIds = newObj.sourceFactIds;
    const now = new Date().toISOString();

    switch (newObj.objectType) {
      case "project": {
        // 去重：name 重复（大小写不敏感，status=active）
        const existingId = this.dedupCheck("project", newObj.title);
        if (existingId) {
          logger.info({
            jobType: "linker",
            message: `dedup hit: project ${existingId}`,
          });
          this.linkFactIdsToExisting("project", existingId, sourceFactIds);
          return true;
        }
        this.memoryObjectRepo.createProject({
          name: newObj.title,
          summary: newObj.summary,
          status: "active",
          lastActiveAt: now,
          sourceFactIds,
          sourceSceneIds: [],
        });
        return true;
      }
      case "task": {
        // 去重：title + project 重复（status=open/in_progress）
        // 新建 task 的 projectId 为 null，故仅匹配未关联项目的 task
        const existingId = this.dedupCheck("task", newObj.title);
        if (existingId) {
          logger.info({
            jobType: "linker",
            message: `dedup hit: task ${existingId}`,
          });
          this.linkFactIdsToExisting("task", existingId, sourceFactIds);
          return true;
        }
        this.memoryObjectRepo.createTask({
          title: newObj.title,
          status: "open", // 默认 open，task status 不轻易设为 done
          projectId: null,
          summary: newObj.summary,
          dueHint: null,
          priority: newObj.confidence, // 用 confidence 作为初始 priority
          confidence: newObj.confidence,
          sourceFactIds,
        });
        return true;
      }
      case "person": {
        // 去重：name 重复
        const existingId = this.dedupCheck("person", newObj.title);
        if (existingId) {
          logger.info({
            jobType: "linker",
            message: `dedup hit: person ${existingId}`,
          });
          this.linkFactIdsToExisting("person", existingId, sourceFactIds);
          return true;
        }
        this.memoryObjectRepo.createPerson({
          name: newObj.title,
          role: null,
          organization: null,
          summary: newObj.summary,
          relatedProjectIds: [],
          sourceFactIds,
        });
        return true;
      }
      case "decision": {
        // 去重：title 重复（7 天内）
        const existingId = this.dedupCheck("decision", newObj.title);
        if (existingId) {
          logger.info({
            jobType: "linker",
            message: `dedup hit: decision ${existingId}`,
          });
          this.linkFactIdsToExisting("decision", existingId, sourceFactIds);
          return true;
        }
        this.memoryObjectRepo.createDecision({
          title: newObj.title,
          decision: newObj.summary,
          projectId: null,
          rationale: null,
          confidence: newObj.confidence,
          sourceFactIds,
          decidedAt: now,
        });
        return true;
      }
      case "knowledge":
        // knowledge 类型在 MVP 不单独建表
        // 通过 fact.type=knowledge 记录（M5+ 实现 knowledge 对象表）
        return true;
      default:
        return false;
    }
  }

  /**
   * 硬性去重查询（fallback）
   *
   * 根据 objectType + title 查询现有对象，命中返回 id，否则返回 null。
   * 查询失败时返回 null（不阻断后续创建流程）。
   *
   * - project: findActiveProjectByName（name，ignoreCase）
   * - task: findOpenTaskByTitleAndProject（title + projectId=null）
   * - person: findPersonByName（name）
   * - decision: findRecentDecisionByTitle（title，withinDays=7）
   */
  private dedupCheck(
    objectType: "project" | "task" | "person" | "decision",
    title: string
  ): string | null {
    try {
      switch (objectType) {
        case "project": {
          const existing = this.memoryObjectRepo.findActiveProjectByName(title, {
            ignoreCase: true,
          });
          return existing?.id ?? null;
        }
        case "task": {
          // 新建 task 的 projectId 恒为 null，故仅匹配未关联项目的 task
          const existing = this.memoryObjectRepo.findOpenTaskByTitleAndProject(
            title,
            null
          );
          return existing?.id ?? null;
        }
        case "person": {
          const existing = this.memoryObjectRepo.findPersonByName(title);
          return existing?.id ?? null;
        }
        case "decision": {
          const existing = this.memoryObjectRepo.findRecentDecisionByTitle(title, {
            withinDays: 7,
          });
          return existing?.id ?? null;
        }
      }
    } catch {
      // 去重查询失败不阻断创建流程
    }
    return null;
  }

  /**
   * 把多个 sourceFactIds 追加到现有对象的 sourceFactIds（去重合并）
   *
   * 用于硬性去重命中时：不创建新对象，但仍建立 link
   * （把新 fact 的 id 追加到现有对象的 sourceFactIds）。
   *
   * @returns 是否成功更新（true=已 link；false=对象未找到或更新失败）
   */
  private linkFactIdsToExisting(
    objectType: "project" | "task" | "person" | "decision",
    existingId: string,
    factIds: string[]
  ): boolean {
    if (factIds.length === 0) return true;
    try {
      switch (objectType) {
        case "project": {
          const obj = this.memoryObjectRepo.getProjectByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateProject(existingId, {
            sourceFactIds: merged,
            lastActiveAt: new Date().toISOString(),
          });
          return true;
        }
        case "task": {
          const obj = this.memoryObjectRepo.getTaskByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateTask(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
        case "person": {
          const obj = this.memoryObjectRepo.getPersonByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updatePerson(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
        case "decision": {
          const obj = this.memoryObjectRepo.getDecisionByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateDecision(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
      }
    } catch {
      // 单条 link 失败不阻断
    }
    return false;
  }

  /**
   * 处理 mergeSuggestions：写入 proactive_items 表作为 needs_confirmation
   * - requires_user_confirmation=true
   * - status="new"
   * - surface="in_app"（默认）
   * - type="needs_confirmation"
   */
  private processMergeSuggestions(
    mergeSuggestions: LinkerOutput["mergeSuggestions"]
  ): LinkerOutput["mergeSuggestions"] {
    const processed: LinkerOutput["mergeSuggestions"] = [];
    for (const suggestion of mergeSuggestions) {
      // M-4: MVP 阶段不支持 knowledge 对象合并（无对应存储表），过滤掉该类型建议
      if (suggestion.objectType === "knowledge") {
        logger.info({
          jobType: "linker",
          message: `[LinkerWorker] 跳过 knowledge 对象合并建议（MVP 不支持）: ${suggestion.fromId} -> ${suggestion.toId}`,
        });
        continue;
      }
      try {
        const item: Omit<ProactiveItem, "id" | "createdAt" | "updatedAt"> = {
          type: "needs_confirmation",
          title: `建议合并 ${suggestion.objectType}`,
          body: `建议将 ${suggestion.fromId} 合并到 ${suggestion.toId}（${suggestion.objectType}）`,
          reason: suggestion.reason,
          priority: suggestion.confidence,
          surface: "in_app",
          requiresUserConfirmation: true,
          status: "new",
          sourceFactIds: [],
          sourceSceneIds: [],
        };
        this.proactiveItemRepo.create(item);
        processed.push(suggestion);
      } catch {
        // 单条失败不阻断
      }
    }
    return processed;
  }

  // ----------------------------------------------------------------
  // 摘要构造
  // ----------------------------------------------------------------

  /**
   * Fact 摘要（用于 LinkerInput.newFacts）
   * - 保留关键字段，去除 evidenceText 等大量文本（如不需要）
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
   * Scene 摘要（用于 LinkerInput.recentScenes）
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

// ---------------------------------------------------------------------------
// 模块级辅助函数
// ---------------------------------------------------------------------------

/**
 * 合并两个 id 数组并去重（保持顺序：existing 在前，incoming 中新增的追加在后）
 * 用于硬性去重命中时把新 sourceFactIds 追加到现有对象。
 */
function mergeUnique(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const result = existing.slice();
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
