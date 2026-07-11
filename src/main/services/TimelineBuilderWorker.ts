// src/main/services/TimelineBuilderWorker.ts
// LLM Timeline Builder Worker（Phase 2 / doc 20 第 5 节 / spec.md 行 637-787）
//
// 职责：
// - 把当天 observations / facts / scenes 聚合为用户可读的 TimelineBlock
// - 不要机械按半小时切分；相近主题、项目、连续工作合并成自然工作片段
// - 标题清楚务实，不诗化；休息/空白用"短暂休息"/"离开电脑"，不羞辱用户
// - 每个 block 必须保留 source ids（scene/fact/observation）
// - 判断 block 是否适合进入工作日报（reportable）及隐私风险（privateRisk）
// - 调用 ModelGateway.callMultimodal（多模态模型，超时由 ModelGateway 默认 120s 控制）
// - zod 校验 TimelineBuilderOutput（由 ModelGateway 完成）
// - 持久化到 timeline_blocks 表（同 date_key 替换：upsertMany 先删后插）
//
// 触发时机（来自 spec.md 行 641-646）：
// 1. 今日页加载时当天 facts/scenes 更新
// 2. 每隔一段时间批处理
// 3. 用户手动刷新今日时间轴
// 4. 生成报告前确保 timeline blocks 最新
//
// 本文件只实现 Worker 本身，触发由 Task 2.8 的 IPC handler 和 app.ts 调度处理。
//
// 重要约束：
// - block 必须有 title/summary/startAt/endAt/category/reportable/privateRisk
// - reportable=false 的 block 不进入工作日报
// - privateRisk=high 的 block 需要用户确认才能展示
// - 同 date_key 重复生成时替换全部 blocks

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue } from "./ModelJobQueue";
import type {
  Observation,
  Fact,
  Scene,
  TimelineBuilderInput,
  TimelineBuilderOutput,
  TimelineBlockOutputItem,
} from "../models/types";
import type { TimelineBlock } from "../../shared/types";
import { TimelineBuilderOutputSchema } from "../models/schemas";
import { TIMELINE_BUILDER_PROMPT_TEMPLATE } from "../models/prompts";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { TimelineBuildCheckpointRepository } from "../db/repositories/TimelineBuildCheckpointRepository";
import type { SettingsService } from "./SettingsService";
import { getSystemTimezone, getSystemTimezoneOffset } from "../utils/timezone";
import { localDateKeyUtcRange } from "../utils/dateKey";

export type TimelineBuildMode = "normal" | "forceFinalizeTail" | "reorganizeDay";
const MATURITY_MS = 10 * 60 * 1000;
const MUTABLE_TAIL_MS = 30 * 60 * 1000;

/**
 * TimelineBuilderWorker 运行结果
 *
 * ok=true 时 blocks/dayStartSummary/dayMainThread 有值；
 * ok=false 时 errorCode/errorMessage 描述失败原因，blocks 为空数组。
 */
export interface TimelineBuilderResult {
  ok: boolean;
  /** 已写入数据库的 timeline blocks（失败时为空数组） */
  blocks: TimelineBlock[];
  /** 一天开始时的简短说明（失败时为空字符串） */
  dayStartSummary: string;
  /** 今天的主线工作一句话总结（失败时为空字符串） */
  dayMainThread: string;
  /** model_job id（用于追踪） */
  modelJobId?: string;
  /** 尝试次数 */
  attempts?: number;
  /** 失败错误码 */
  errorCode?: string;
  /** 失败错误信息（不含 API Key） */
  errorMessage?: string;
}

/**
 * TimelineBuilderWorker：今日时间轴整理员
 *
 * 工作流：
 * 1. 获取启用的多模态模型配置
 * 2. 查询当天 observations / facts / scenes
 * 3. 构造 TimelineBuilderInput JSON（精简字段，只传必要信息给 LLM）
 * 4. 填充 TIMELINE_BUILDER_PROMPT_TEMPLATE
 * 5. 通过 ModelJobQueue 提交 LLM 任务（多模态模型）
 * 6. zod 校验 TimelineBuilderOutput（由 ModelGateway 完成）
 * 7. 映射 blocks 到 TimelineBlock 并持久化到 timeline_blocks 表（同 date_key 替换）
 */
export class TimelineBuilderWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly observationRepo: ObservationRepository;
  private readonly factRepo: FactRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly timelineBlockRepo: TimelineBlockRepository;
  private readonly timelineBuildCheckpointRepo: TimelineBuildCheckpointRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    observationRepo: ObservationRepository;
    factRepo: FactRepository;
    sceneRepo: SceneRepository;
    timelineBlockRepo: TimelineBlockRepository;
    timelineBuildCheckpointRepo: TimelineBuildCheckpointRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.observationRepo = deps.observationRepo;
    this.factRepo = deps.factRepo;
    this.sceneRepo = deps.sceneRepo;
    this.timelineBlockRepo = deps.timelineBlockRepo;
    this.timelineBuildCheckpointRepo = deps.timelineBuildCheckpointRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 构建今日时间轴
   *
   * @param dateKey 日期 YYYY-MM-DD
   * @returns 构建结果（ok=true 时包含已写入的 blocks 和日总结）
   */
  async buildTimeline(dateKey: string, mode: TimelineBuildMode = "normal"): Promise<TimelineBuilderResult> {
    return this.runBuild(dateKey, mode);
  }

  async reorganizeDay(dateKey: string): Promise<TimelineBuilderResult> {
    return this.runBuild(dateKey, "reorganizeDay");
  }

  private async runBuild(dateKey: string, mode: TimelineBuildMode): Promise<TimelineBuilderResult> {
    // 1. 获取启用的多模态模型配置
    const multimodalModelConfigId = this.getActiveMultimodalModelConfigId();
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        blocks: [],
        dayStartSummary: "",
        dayMainThread: "",
        errorCode: "no_language_model",
        errorMessage: "未配置启用的多模态模型，无法生成时间轴",
      };
    }

    // 2. 增量窗口：查询已落盘 blocks 的最大 endAt
    // - 如果有 lastEndAt，只处理 (lastEndAt, now] 的新数据
    // - 如果没有（当天首次），从当天 00:00 开始处理到 now
    // - 历史已落盘的 blocks 永不改动（增量落盘策略，2026-07-07）
    const checkpoint = this.timelineBuildCheckpointRepo.get(dateKey);
    const isInitialBuild = checkpoint === null;
    const day = localDateKeyUtcRange(dateKey);
    const nowMs = Date.now();
    const todayEndMs = Math.min(nowMs, Date.parse(day.end));
    const matureEndMs = mode === "normal" ? todayEndMs - MATURITY_MS : todayEndMs;
    const processedMs = checkpoint ? Date.parse(checkpoint) : Date.parse(day.start);
    if (mode !== "reorganizeDay" && matureEndMs <= processedMs) return noop("insufficient_mature_window", "尚未形成 10 分钟成熟窗口。");
    const windowStart = mode === "reorganizeDay"
      ? day.start
      : new Date(Math.max(Date.parse(day.start), processedMs - MUTABLE_TAIL_MS)).toISOString();
    const windowEnd = new Date(Math.max(Date.parse(day.start), matureEndMs)).toISOString();
    const existingBlocks = this.timelineBlockRepo.findOverlapping(dateKey, windowStart, windowEnd);

    // 3. 查询增量窗口内的数据
    const observations = this.fetchObservationsByDateRange(windowStart, windowEnd);
    const facts = this.fetchFactsByDateRange(windowStart, windowEnd);
    const scenes = this.fetchScenesByDateRange(windowStart, windowEnd);

    // 数据量过少时给出明确提示，不浪费模型调用
    if (observations.length === 0 && facts.length === 0 && scenes.length === 0) {
      this.timelineBlockRepo.replaceWindowAndCheckpoint({ dateKey, windowStart, windowEnd, blocks: existingBlocks, processedThrough: windowEnd });
      return { ok: true, blocks: [], dayStartSummary: "", dayMainThread: "" };
    }

    // 4. 构造 TimelineBuilderInput
    // - 顶层加 systemTimezone + systemTimezoneOffset + systemNow + windowStart + windowEnd
    // - windowStart/windowEnd 明确告知 LLM 本次只处理这个时间范围
    const baseInput: TimelineBuilderInput = {
      dateKey,
      existingBlocks,
      observations: observations.map(this.toObservationSummary),
      facts: facts.map(this.toFactSummary),
      scenes: scenes.map(this.toSceneSummary),
    };
    const input = {
      systemTimezone: getSystemTimezone(),
      systemTimezoneOffset: getSystemTimezoneOffset(),
      systemNow: windowEnd,
      windowStart,
      windowEnd,
      ...baseInput,
    } as TimelineBuilderInput & {
      systemTimezone: string;
      systemTimezoneOffset: string;
      systemNow: string;
      windowStart: string;
      windowEnd: string;
    };
    const inputJson = JSON.stringify(input, null, 2);

    // 5. 填充 prompt（替换占位符）
    const userPrompt = TIMELINE_BUILDER_PROMPT_TEMPLATE.replace(
      "{{timeline_builder_input_json}}",
      inputJson
    );

    // 6. 构造脱敏 jobInputJson
    const jobInputJson = JSON.stringify({
      dateKey,
      windowStart,
      windowEnd,
      observationCount: observations.length,
      factCount: facts.length,
      sceneCount: scenes.length,
      isIncremental: checkpoint !== null,
      mode,
      existingBlockCount: existingBlocks.length,
    });

    // 7. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueMultimodalJob<TimelineBuilderOutput>({
      type: "timeline_builder",
      // 首次生成直接影响今日页是否有内容；增量刷新让位给普通采集链路。
      priority: isInitialBuild ? 1 : 3,
      dedupeKey: `timeline_builder:${dateKey}`,
      executor: async () => {
        return this.modelGateway.callMultimodal<TimelineBuilderOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "timeline_builder",
            jobInputJson,
          },
          TimelineBuilderOutputSchema
        );
      },
    });

    if (!result.ok || !result.data) {
      return {
        ok: false,
        blocks: [],
        dayStartSummary: "",
        dayMainThread: "",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        modelJobId: result.modelJobId,
        attempts: result.attempts,
      };
    }

    const output = result.data;

    // 8. 映射 blocks 到 TimelineBlock 并增量持久化（只追加，不删除旧的）
    if (output.blocks.length === 0) return noop("empty_model_output", "模型未返回可用时间轴片段。", result);
    const blocks = this.mapBlocks(dateKey, output, observations, facts, scenes);
    if (blocks.length === 0) return noop("invalid_model_output", "模型输出没有可验证来源。", result);
    const persisted = this.timelineBlockRepo.replaceWindowAndCheckpoint({ dateKey, windowStart, windowEnd, blocks, processedThrough: windowEnd });

    return {
      ok: true,
      blocks: persisted,
      dayStartSummary: output.dayStartSummary,
      dayMainThread: output.dayMainThread,
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  // ----------------------------------------------------------------
  // 数据检索
  // ----------------------------------------------------------------

  /**
   * 获取启用的多模态模型配置 id
   */
  private getActiveMultimodalModelConfigId(): string | null {
    if (!this.settingsService) return null;
    try {
      const configs = this.settingsService.listMultimodalModelConfigs();
      const enabled = configs.find((c) => c.enabled);
      return enabled?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 查询指定日期范围的 observations
   * - 按 captured_at 升序（便于模型理解时间线）
   */
  private fetchObservationsByDateRange(startIso: string, endIso: string): Observation[] {
    try {
      const list = this.observationRepo.listByCapturedAt({
        from: startIso,
        to: endIso,
        limit: 200,
      });
      // listByCapturedAt 默认 DESC，这里反转为升序便于模型理解时间线
      return list.reverse();
    } catch {
      return [];
    }
  }

  /**
   * 查询指定日期范围的 facts
   * 注：FactRepository 暂未提供按 createdAt 范围查询的方法，
   * 这里使用 list() 后在代码中过滤（与 ReporterWorker 一致）。
   */
  private fetchFactsByDateRange(startIso: string, endIso: string): Fact[] {
    try {
      const all = this.factRepo.list({ includeDeleted: false, limit: 500 });
      return all
        .filter((f) => f.createdAt >= startIso && f.createdAt <= endIso)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * 查询指定日期范围的 scenes
   * - 按 start_at 升序（便于模型理解时间线）
   */
  private fetchScenesByDateRange(startIso: string, endIso: string): Scene[] {
    try {
      const list = this.sceneRepo.listByStartAt({
        from: startIso,
        to: endIso,
        limit: 100,
      });
      // listByStartAt 默认 DESC，这里反转为升序便于模型理解时间线
      return list.reverse();
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------------
  // 摘要构造（去除数据库内部字段，仅保留模型需要的语义字段）
  // ----------------------------------------------------------------

  /**
   * Observation 摘要（用于 TimelineBuilderInput.observations）
   *
   * 记忆系统重构后，Observation 已持久化用户可读摘要、工作目的、隐私风险、
   * 报告信号等 V2 字段。TimelineBuilder 应优先消费这些面向用户的字段，
   * 而不是只看底层 sceneSummary。
   */
  private toObservationSummary(obs: Observation): TimelineBuilderInput["observations"][number] {
    return {
      id: obs.id,
      capturedAt: obs.capturedAt,
      appName: obs.appName,
      windowTitle: obs.windowTitle,
      sceneSummary: obs.sceneSummary,
      userFacingSummary: obs.userFacingSummary ?? undefined,
      likelyWorkPurpose: obs.likelyWorkPurpose ?? undefined,
      privacyRisk: obs.privacyRisk ?? undefined,
      reportableSignal: obs.reportableSignal ?? undefined,
    };
  }

  /**
   * Fact 摘要（用于 TimelineBuilderInput.facts）
   *
   * Fact 的 V2 使用意图、可报告性、隐私风险已经可落库。
   * 在 L2/L3 仍在重构时，这些字段有助于时间轴更稳地判断 block 的用途和风险。
   */
  private toFactSummary(fact: Fact): TimelineBuilderInput["facts"][number] {
    return {
      id: fact.id,
      type: fact.type,
      content: fact.content,
      projectId: fact.projectId ?? undefined,
      projectHint: fact.projectHint ?? undefined,
      confidence: fact.confidence,
      importance: fact.importance,
      displayUse: fact.displayUse ?? undefined,
      reportable: fact.reportable ?? undefined,
      privateRisk: fact.privateRisk ?? undefined,
      sourceObservationIds: fact.sourceObservationIds,
    };
  }

  /**
   * Scene 摘要（用于 TimelineBuilderInput.scenes）
   *
   * 当前 scenes 在重构期承担 L1 Episode 落库面，可能没有 factIds，
   * 但 observationIds / entityNames 仍然足以帮助时间轴组织自然片段。
   */
  private toSceneSummary(scene: Scene): TimelineBuilderInput["scenes"][number] {
    return {
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      startAt: scene.startAt,
      endAt: scene.endAt,
      projectId: scene.projectId ?? undefined,
      factIds: scene.factIds,
      observationIds: scene.observationIds,
      entityNames: scene.entityNames,
      confidence: scene.confidence,
    };
  }

  // ----------------------------------------------------------------
  // 持久化
  // ----------------------------------------------------------------

  /**
   * 映射 LLM 输出的 blocks 到 TimelineBlock 并增量持久化
   *
   * 时间只来自本次输入中可验证的 Moment.capturedAt。模型返回的时间、
   * 模型执行时间和数据库写入时间都不能成为用户活动时间。
   *
   * block.id 若 LLM 未提供则自动生成
   * createdAt/updatedAt 由 Repository 统一填充
   */
  private mapBlocks(
    dateKey: string,
    output: TimelineBuilderOutput,
    observations: Observation[],
    facts: Fact[],
    scenes: Scene[]
  ): TimelineBlock[] {
    const observationsById = new Map(observations.map((value) => [value.id, value]));
    const factsById = new Map(facts.map((value) => [value.id, value]));
    const scenesById = new Map(scenes.map((value) => [value.id, value]));
    const blocks: TimelineBlock[] = output.blocks
      .map((item) => this.toTimelineBlock(dateKey, item, observationsById, factsById, scenesById))
      .filter((block): block is TimelineBlock => block !== null);

    return blocks;
  }

  /**
   * 把 LLM 输出的 block 项映射为持久化的 TimelineBlock
   *
   * - id：LLM 可能不生成，由应用层补
   * - dateKey：由调用方传入（LLM 输出的 dateKey 仅用于校验，持久化以传入的 dateKey 为准）
   * - privateRiskReason / confidence：LLM 输出有，持久化时保留为可选字段
   *   （timeline_blocks 表未单独建列，但 TimelineBlock 类型支持可选）
   */
  private toTimelineBlock(
    dateKey: string,
    item: TimelineBlockOutputItem,
    observationsById: Map<string, Observation>,
    factsById: Map<string, Fact>,
    scenesById: Map<string, Scene>
  ): TimelineBlock | null {
    const sourceObservationIds = new Set<string>();
    for (const id of item.sourceObservationIds) {
      if (observationsById.has(id)) sourceObservationIds.add(id);
    }
    const sourceSceneIds = item.sourceSceneIds.filter((id) => scenesById.has(id));
    for (const id of sourceSceneIds) {
      for (const observationId of scenesById.get(id)!.observationIds) {
        if (observationsById.has(observationId)) sourceObservationIds.add(observationId);
      }
    }
    const sourceFactIds = item.sourceFactIds.filter((id) => factsById.has(id));
    for (const id of sourceFactIds) {
      const fact = factsById.get(id)!;
      for (const observationId of fact.sourceObservationIds) {
        if (observationsById.has(observationId)) sourceObservationIds.add(observationId);
      }
      for (const episodeId of fact.sourceEpisodeIds) {
        const scene = scenesById.get(episodeId);
        if (!scene) continue;
        for (const observationId of scene.observationIds) {
          if (observationsById.has(observationId)) sourceObservationIds.add(observationId);
        }
      }
    }
    const sourceObservations = [...sourceObservationIds].map((id) => observationsById.get(id)!);
    if (sourceObservations.length === 0) return null;
    const capturedTimes = sourceObservations.map((observation) => observation.capturedAt);
    const startAt = capturedTimes.reduce((min, value) => Date.parse(value) < Date.parse(min) ? value : min);
    const endAt = capturedTimes.reduce((max, value) => Date.parse(value) > Date.parse(max) ? value : max);
    return {
      id: "",
      dateKey,
      startAt,
      endAt,
      title: item.title,
      summary: item.summary,
      category: item.category,
      projectIds: item.projectIds,
      projectNames: item.projectNames,
      highlights: item.highlights,
      generatedTasks: item.generatedTasks,
      generatedDecisions: item.generatedDecisions,
      reportable: item.reportable,
      privateRisk: item.privateRisk,
      privateRiskReason: item.privateRiskReason,
      sourceSceneIds,
      sourceFactIds,
      sourceObservationIds: [...sourceObservationIds],
      confidence: item.confidence,
    };
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算某天的本地时区起止 ISO 时间
 * - 修复：之前用 UTC 范围（YYYY-MM-DDT00:00:00Z）查"今天"，导致 UTC+8 时区下
 *   凌晨 0:00-8:00 的 observation（capturedAt 是 UTC ISO 字符串）无法被检索
 * - 现在复用 _helpers.getLocalTodayStartIso 的本地时区逻辑
 * - 端点用 endOfDay 包含全天本地时间到 23:59:59.999
 */
function noop(errorCode: string, errorMessage: string, job?: { modelJobId?: string; attempts?: number }): TimelineBuilderResult {
  return { ok: true, blocks: [], dayStartSummary: "", dayMainThread: "", errorCode, errorMessage, modelJobId: job?.modelJobId, attempts: job?.attempts };
}
