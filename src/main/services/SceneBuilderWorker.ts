// src/main/services/SceneBuilderWorker.ts
// LLM Scene Builder Worker（来自 03、05 文档）
//
// 职责：
// - 把一段时间内相近的 facts 聚合为 L2 Scene
// - Scene 不是固定时间片，不要机械按 1、2、3 列流水账
// - Scene 应该表达一段工作的主题、目的、结果和相关事实
// - 调用 ModelGateway.callLanguage
// - zod 校验 SceneBuilderOutput
// - 写入 scenes 表
//
// 触发条件（来自 spec.md）：
// 1. 同一窗口/项目持续工作 10 分钟以上
// 2. 用户切换到另一个明显不同的项目
// 3. 长时间 idle 后恢复
// 4. 日报前批处理
//
// 重要约束：
// - task status 不轻易设为 done
// - scene 必须有 title/summary/startAt/endAt/factIds
// - scene 不是机械流水账

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type { Fact, Scene } from "../models/types";
import type { SceneBuilderOutput } from "../models/schemas";
import { SceneBuilderOutputSchema } from "../models/schemas";
import { SCENE_BUILDER_PROMPT_TEMPLATE } from "../models/prompts";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";

/**
 * Scene Builder 触发原因
 */
export type SceneBuilderTriggerReason =
  | "long_session" // 同一窗口/项目持续工作 10 分钟以上
  | "project_switch" // 用户切换到另一个明显不同的项目
  | "idle_recovery" // 长时间 idle 后恢复
  | "daily_preflight"; // 日报前批处理

/**
 * Scene Builder Worker 输入
 */
export interface SceneBuilderWorkerInput {
  /** 触发原因 */
  triggerReason: SceneBuilderTriggerReason;
  /** 时间窗口起点（ISO） */
  fromTime: string;
  /** 时间窗口终点（ISO，默认 now） */
  toTime?: string;
  /** 当前 captureId（用于去重，可选） */
  captureId?: string;
  /** 语言模型配置 id */
  languageModelConfigId: string;
  /** 限制查询的 fact 数量上限（默认 50） */
  factLimit?: number;
}

/**
 * Scene Builder Worker 输出
 */
export interface SceneBuilderWorkerResult {
  /** 已写入数据库的 scenes */
  scenes: Scene[];
  /** model_job id */
  modelJobId: string;
  /** 尝试次数 */
  attempts: number;
}

/**
 * SceneBuilderWorker：场景聚合器
 *
 * 工作流：
 * 1. 查询时间窗口内的 facts（按 created_at 升序）
 * 2. 查询时间窗口内的 active projects（用于 projectHint）
 * 3. 查询时间窗口内的相关 tasks（基于 source_fact_ids）
 * 4. 构造 SceneBuilderInput JSON
 * 5. 填充 SCENE_BUILDER_PROMPT_TEMPLATE
 * 6. 通过 ModelJobQueue 提交 LLM 任务
 * 7. zod 校验 SceneBuilderOutput（由 ModelGateway 完成）
 * 8. 写入 scenes 表
 */
export class SceneBuilderWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly sceneRepo: SceneRepository;
  private readonly factRepo: FactRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    sceneRepo: SceneRepository;
    factRepo: FactRepository;
    memoryObjectRepo: MemoryObjectRepository;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.sceneRepo = deps.sceneRepo;
    this.factRepo = deps.factRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
  }

  /**
   * 运行 Scene Builder
   *
   * @param input 输入
   * @returns 执行结果（ok=true 时包含已写入的 scenes）
   */
  async run(input: SceneBuilderWorkerInput): Promise<JobResult<SceneBuilderWorkerResult>> {
    const {
      triggerReason,
      fromTime,
      toTime = new Date().toISOString(),
      captureId,
      languageModelConfigId,
      factLimit = 50,
    } = input;

    // 1. 查询时间窗口内的 facts（按 created_at 升序，便于模型理解时间线）
    const facts = this.fetchFactsInTimeWindow(fromTime, toTime, factLimit);

    // 没有 facts 则跳过（无需调用模型）
    if (facts.length === 0) {
      return {
        ok: true,
        data: {
          scenes: [],
          modelJobId: "",
          attempts: 0,
        },
      };
    }

    // 2. 查询时间窗口内的 active projects
    const activeProjects = this.fetchActiveProjects();

    // 3. 查询相关 tasks（基于 facts.sourceObservationIds 不可行，简化为查 active tasks）
    const relatedTasks = this.fetchRelatedTasks();

    // 4. 构造 SceneBuilderInput
    const sceneBuilderInput = {
      triggerReason,
      timeWindow: { from: fromTime, to: toTime },
      facts: facts.map(this.toFactSummary),
      activeProjects: activeProjects.map((p) => ({
        id: p.id,
        name: p.name,
        summary: p.summary,
      })),
      relatedTasks: relatedTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        projectId: t.projectId,
      })),
    };
    const sceneBuilderInputJson = JSON.stringify(sceneBuilderInput, null, 2);

    // 5. 填充 prompt
    const userPrompt = SCENE_BUILDER_PROMPT_TEMPLATE.replace(
      "{{scene_builder_input_json}}",
      sceneBuilderInputJson
    );

    // 6. 构造脱敏 jobInputJson
    const jobInputJson = JSON.stringify({
      triggerReason,
      fromTime,
      toTime,
      factCount: facts.length,
      factIds: facts.map((f) => f.id),
      activeProjectCount: activeProjects.length,
      relatedTaskCount: relatedTasks.length,
    });

    // 7. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueLanguageJob<SceneBuilderOutput>({
      type: "scene_builder",
      captureId,
      executor: async () => {
        return this.modelGateway.callLanguage<SceneBuilderOutput>(
          {
            kind: "language",
            configId: languageModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "scene_builder",
            jobInputJson,
          },
          SceneBuilderOutputSchema
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

    // 8. 写入 scenes 表
    const scenes = this.writeScenes(result.data);

    return {
      ok: true,
      data: {
        scenes,
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
   * 查询时间窗口内的 facts
   * - 按 created_at 升序（便于模型理解时间线）
   * - 排除已删除
   */
  private fetchFactsInTimeWindow(from: string, to: string, limit: number): Fact[] {
    try {
      // FactRepository.list 不直接支持时间范围过滤
      // 简化：查全部未删除 facts，按 created_at 过滤
      const allFacts = this.factRepo.list({ limit: Math.max(limit * 2, 100) });
      return allFacts
        .filter((f) => f.createdAt >= from && f.createdAt <= to)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 查询 active projects
   */
  private fetchActiveProjects() {
    try {
      return this.memoryObjectRepo.listProjects({ status: "active", limit: 10 });
    } catch {
      return [];
    }
  }

  /**
   * 查询相关 tasks（status=open/in_progress/likely_done）
   * - 不查 done（已完成不需要在 scene 中聚合）
   */
  private fetchRelatedTasks() {
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
      return [...openTasks, ...inProgressTasks, ...likelyDoneTasks];
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------------
  // 写入 scenes 表
  // ----------------------------------------------------------------

  /**
   * 写入 scenes
   * - 每个 scene 写入 scenes 表
   * - 若 projectHint 匹配已有 project，设置 projectId
   * - 单条写入失败不阻断其他
   */
  private writeScenes(output: SceneBuilderOutput): Scene[] {
    const scenes: Scene[] = [];
    for (const sceneInput of output.scenes) {
      try {
        // 尝试通过 projectHint 匹配 project
        const projectId = this.resolveProjectId(sceneInput.projectHint);

        const scene = this.sceneRepo.create({
          title: sceneInput.title,
          summary: sceneInput.summary,
          startAt: sceneInput.startAt,
          endAt: sceneInput.endAt,
          projectId,
          confidence: sceneInput.confidence,
          factIds: sceneInput.factIds,
          observationIds: [], // Scene Builder 不直接关联 observation
          entityNames: sceneInput.entityNames,
          taskIds: sceneInput.taskIds,
          decisionIds: sceneInput.decisionIds,
        });
        scenes.push(scene);
      } catch {
        // 单条写入失败不阻断其他
      }
    }
    return scenes;
  }

  /**
   * 通过 projectHint 解析 projectId
   * - 在 active projects 中查找 name 匹配的 project
   * - 找不到返回 null
   */
  private resolveProjectId(projectHint?: string): string | null {
    if (!projectHint) return null;
    try {
      const projects = this.memoryObjectRepo.listProjects({
        status: "active",
        limit: 50,
      });
      // 精确匹配优先
      const exactMatch = projects.find((p) => p.name === projectHint);
      if (exactMatch) return exactMatch.id;
      // 模糊匹配（包含）
      const fuzzyMatch = projects.find(
        (p) =>
          p.name.toLowerCase().includes(projectHint.toLowerCase()) ||
          projectHint.toLowerCase().includes(p.name.toLowerCase())
      );
      return fuzzyMatch?.id ?? null;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------
  // 摘要构造
  // ----------------------------------------------------------------

  /**
   * Fact 摘要（用于 SceneBuilderInput.facts）
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
}
