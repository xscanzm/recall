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
const MAX_WINDOW_MS = 90 * 60 * 1000;
const MAX_OBSERVATIONS = 120;
const MAX_TAIL_OBSERVATIONS = 30;
const MAX_FORWARD_OBSERVATIONS = MAX_OBSERVATIONS - MAX_TAIL_OBSERVATIONS;
const MAX_FACTS = 120;
const MAX_SCENES = 60;
const MODEL_CONTEXT_TOKENS = 500_000;
const TIMELINE_MAX_TOKENS = 65_536;
const CONTEXT_OVERHEAD_TOKENS = 14_464;
const MAX_PROMPT_INPUT_TOKENS = MODEL_CONTEXT_TOKENS - TIMELINE_MAX_TOKENS - CONTEXT_OVERHEAD_TOKENS;

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
    const first = await this.runBuild(dateKey, "reorganizeDay");
    if (!first.ok) return first;

    const blocks = [...first.blocks];
    let attempts = first.attempts ?? 0;
    let modelJobId = first.modelJobId;
    const targetEnd = Math.min(Date.now(), Date.parse(localDateKeyUtcRange(dateKey).end));
    for (let chunk = 1; chunk < 24; chunk++) {
      const checkpoint = this.timelineBuildCheckpointRepo.get(dateKey);
      if (!checkpoint || Date.parse(checkpoint) >= targetEnd) break;
      const next = await this.runBuild(dateKey, "forceFinalizeTail");
      if (!next.ok) return next;
      blocks.push(...next.blocks);
      attempts += next.attempts ?? 0;
      modelJobId = next.modelJobId ?? modelJobId;
    }
    return {
      ok: true,
      blocks,
      dayStartSummary: first.dayStartSummary,
      dayMainThread: first.dayMainThread,
      modelJobId,
      attempts,
    };
  }

  private async runBuild(dateKey: string, mode: TimelineBuildMode): Promise<TimelineBuilderResult> {
    const multimodalModelConfigId = this.getActiveMultimodalModelConfigId();
    if (!multimodalModelConfigId) {
      return failure("no_language_model", "未配置启用的多模态模型，无法生成时间轴");
    }

    let checkpoint: string | null;
    try {
      checkpoint = this.timelineBuildCheckpointRepo.get(dateKey);
    } catch (error) {
      return failure("timeline_data_error", `读取时间轴 checkpoint 失败: ${errorMessage(error)}`);
    }

    const isInitialBuild = checkpoint === null;
    const day = localDateKeyUtcRange(dateKey);
    const nowMs = Date.now();
    const todayEndMs = Math.min(nowMs, Date.parse(day.end));
    const matureEndMs = mode === "normal" ? todayEndMs - MATURITY_MS : todayEndMs;
    const dayStartMs = Date.parse(day.start);
    const processedMs = checkpoint ? Date.parse(checkpoint) : dayStartMs;
    if (mode !== "reorganizeDay" && matureEndMs <= processedMs) {
      return noop("insufficient_mature_window", "尚未形成 10 分钟成熟窗口。");
    }

    const cursorMs = mode === "reorganizeDay" ? dayStartMs : processedMs;
    const windowStartMs = mode === "reorganizeDay"
      ? dayStartMs
      : Math.max(dayStartMs, cursorMs - MUTABLE_TAIL_MS);
    const targetEndMs = Math.min(matureEndMs, cursorMs + MAX_WINDOW_MS);
    let windowEnd = new Date(Math.max(dayStartMs, targetEndMs)).toISOString();
    const windowStart = new Date(windowStartMs).toISOString();

    let observations: Observation[];
    try {
      observations = this.fetchObservationsByDateRange(
        windowStart,
        windowEnd,
        mode === "reorganizeDay" ? null : checkpoint
      );
    } catch (error) {
      return failure("timeline_data_error", `读取时间轴 observation 失败: ${errorMessage(error)}`);
    }

    if (observations.length >= MAX_OBSERVATIONS) {
      const lastCapturedAt = observations[observations.length - 1]?.capturedAt;
      if (lastCapturedAt && Date.parse(lastCapturedAt) < Date.parse(windowEnd)) {
        windowEnd = nextIso(lastCapturedAt);
        observations = observations.filter((value) => value.capturedAt < windowEnd);
      }
    }

    let facts: Fact[];
    let scenes: Scene[];
    let existingBlocks: TimelineBlock[];
    try {
      facts = this.fetchFactsByDateRange(windowStart, windowEnd);
      scenes = this.fetchScenesByDateRange(windowStart, windowEnd);
      existingBlocks = this.timelineBlockRepo.findOverlapping(dateKey, windowStart, windowEnd);
    } catch (error) {
      return failure("timeline_data_error", `读取时间轴来源数据失败: ${errorMessage(error)}`);
    }

    const sourceObservationIds = new Set(observations.map((value) => value.id));
    scenes = scenes.filter((scene) => scene.observationIds.some((id) => sourceObservationIds.has(id)));
    const sourceSceneIds = new Set(scenes.map((value) => value.id));
    facts = facts.filter((fact) =>
      fact.sourceObservationIds.some((id) => sourceObservationIds.has(id))
      || fact.sourceEpisodeIds.some((id) => sourceSceneIds.has(id))
    );

    if (observations.length === 0 && facts.length === 0 && scenes.length === 0) {
      try {
        this.timelineBlockRepo.replaceWindowAndCheckpoint({
          dateKey,
          windowStart,
          windowEnd,
          blocks: existingBlocks,
          processedThrough: windowEnd,
        });
      } catch (error) {
        return failure("timeline_data_error", `推进空时间轴窗口失败: ${errorMessage(error)}`);
      }
      return { ok: true, blocks: [], dayStartSummary: "", dayMainThread: "" };
    }

    const bounded = this.boundInput(dateKey, existingBlocks, observations, facts, scenes);
    if (!bounded) {
      return failure(
        "timeline_input_too_large",
        `单条 observation 超出时间轴输入预算（${MAX_PROMPT_INPUT_TOKENS.toLocaleString("en-US")} estimated tokens），无法安全构建。`
      );
    }
    observations = bounded.observations;
    facts = bounded.facts;
    scenes = bounded.scenes;
    existingBlocks = bounded.existingBlocks;
    if (bounded.windowEnd && bounded.windowEnd < windowEnd) windowEnd = bounded.windowEnd;

    const input = {
      systemTimezone: getSystemTimezone(),
      systemTimezoneOffset: getSystemTimezoneOffset(),
      systemNow: windowEnd,
      windowStart,
      windowEnd,
      dateKey,
      existingBlocks,
      observations: observations.map(this.toObservationSummary),
      facts: facts.map(this.toFactSummary),
      scenes: scenes.map(this.toSceneSummary),
    } as TimelineBuilderInput & {
      systemTimezone: string;
      systemTimezoneOffset: string;
      systemNow: string;
      windowStart: string;
      windowEnd: string;
    };
    const inputJson = JSON.stringify(input);
    const userPrompt = TIMELINE_BUILDER_PROMPT_TEMPLATE.replace(
      "{{timeline_builder_input_json}}",
      inputJson
    );
    const jobInputJson = JSON.stringify({
      dateKey,
      windowStart,
      windowEnd,
      observationCount: observations.length,
      factCount: facts.length,
      sceneCount: scenes.length,
      inputTokensEstimate: estimateTokens(inputJson),
      contextTokens: MODEL_CONTEXT_TOKENS,
      maxOutputTokens: TIMELINE_MAX_TOKENS,
      isIncremental: checkpoint !== null,
      mode,
      existingBlockCount: existingBlocks.length,
    });

    const result = await this.modelJobQueue.enqueueMultimodalJob<TimelineBuilderOutput>({
      type: "timeline_builder",
      priority: isInitialBuild ? 1 : 3,
      dedupeKey: `timeline_builder:${dateKey}`,
      executor: async () => this.modelGateway.callMultimodal<TimelineBuilderOutput>(
        {
          kind: "multimodal",
          configId: multimodalModelConfigId,
          systemPrompt: "",
          userPrompt,
          jobType: "timeline_builder",
          jobInputJson,
          maxTokens: TIMELINE_MAX_TOKENS,
          streaming: true,
        },
        TimelineBuilderOutputSchema
      ),
    });

    if (!result.ok || !result.data) {
      return failure(
        result.errorCode ?? "unknown_error",
        result.errorMessage ?? "时间轴模型调用失败",
        result.modelJobId,
        result.attempts
      );
    }

    const output = result.data;
    if (output.blocks.length === 0) {
      return failure("empty_model_output", "模型未返回可用时间轴片段。", result.modelJobId, result.attempts);
    }
    const blocks = this.mapBlocks(dateKey, output, observations, facts, scenes);
    if (blocks.length === 0) {
      return failure(
        "invalid_model_output",
        `模型返回 ${output.blocks.length} 个片段，但全部缺少当前窗口内可验证的 observation 来源。`,
        result.modelJobId,
        result.attempts
      );
    }

    try {
      const persisted = this.timelineBlockRepo.replaceWindowAndCheckpoint({
        dateKey,
        windowStart,
        windowEnd,
        blocks,
        processedThrough: windowEnd,
      });
      return {
        ok: true,
        blocks: persisted,
        dayStartSummary: output.dayStartSummary,
        dayMainThread: output.dayMainThread,
        modelJobId: result.modelJobId,
        attempts: result.attempts,
      };
    } catch (error) {
      return failure("timeline_data_error", `写入时间轴失败: ${errorMessage(error)}`, result.modelJobId, result.attempts);
    }
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
  private fetchObservationsByDateRange(startIso: string, endIso: string, checkpoint: string | null): Observation[] {
    if (!checkpoint) {
      return this.observationRepo.listByCapturedAt({
        from: startIso,
        to: endIso,
        limit: MAX_OBSERVATIONS,
        order: "asc",
      });
    }
    const tail = this.observationRepo.listByCapturedAt({
      from: startIso,
      to: checkpoint,
      limit: MAX_TAIL_OBSERVATIONS,
      order: "desc",
    }).reverse();
    const forward = this.observationRepo.listByCapturedAt({
      from: checkpoint,
      to: endIso,
      limit: MAX_FORWARD_OBSERVATIONS,
      order: "asc",
    });
    return [...tail, ...forward];
  }

  /**
   * 查询指定日期范围的 facts
   * 注：FactRepository 暂未提供按 createdAt 范围查询的方法，
   * 这里使用 list() 后在代码中过滤（与 ReporterWorker 一致）。
   */
  private fetchFactsByDateRange(startIso: string, endIso: string): Fact[] {
    return this.factRepo.listByCreatedAt({
      from: startIso,
      to: endIso,
      limit: MAX_FACTS,
      order: "asc",
    });
  }

  /**
   * 查询指定日期范围的 scenes
   * - 按 start_at 升序（便于模型理解时间线）
   */
  private fetchScenesByDateRange(startIso: string, endIso: string): Scene[] {
    return this.sceneRepo.listByStartAt({
      from: startIso,
      to: endIso,
      limit: MAX_SCENES,
      order: "asc",
    });
  }

  private boundInput(
    dateKey: string,
    existingBlocks: TimelineBlock[],
    observations: Observation[],
    facts: Fact[],
    scenes: Scene[]
  ): {
    existingBlocks: TimelineBlock[];
    observations: Observation[];
    facts: Fact[];
    scenes: Scene[];
    windowEnd?: string;
  } | null {
    const selected: Observation[] = [];
    for (const observation of observations) {
      const candidate = [...selected, observation];
      const candidateIds = new Set(candidate.map((value) => value.id));
      const candidateScenes = scenes.filter((scene) => scene.observationIds.some((id) => candidateIds.has(id)));
      const candidateSceneIds = new Set(candidateScenes.map((value) => value.id));
      const candidateFacts = facts.filter((fact) =>
        fact.sourceObservationIds.some((id) => candidateIds.has(id))
        || fact.sourceEpisodeIds.some((id) => candidateSceneIds.has(id))
      );
      const tokensEstimate = estimateTokens(JSON.stringify({
        dateKey,
        existingBlocks,
        observations: candidate.map(this.toObservationSummary),
        facts: candidateFacts.map(this.toFactSummary),
        scenes: candidateScenes.map(this.toSceneSummary),
      }));
      if (tokensEstimate > MAX_PROMPT_INPUT_TOKENS) break;
      selected.push(observation);
    }
    if (observations.length > 0 && selected.length === 0) return null;

    const selectedIds = new Set(selected.map((value) => value.id));
    const selectedScenes = scenes.filter((scene) => scene.observationIds.some((id) => selectedIds.has(id)));
    const selectedSceneIds = new Set(selectedScenes.map((value) => value.id));
    const selectedFacts = facts.filter((fact) =>
      fact.sourceObservationIds.some((id) => selectedIds.has(id))
      || fact.sourceEpisodeIds.some((id) => selectedSceneIds.has(id))
    );
    const wasTrimmed = selected.length < observations.length;
    return {
      existingBlocks,
      observations: selected,
      facts: selectedFacts,
      scenes: selectedScenes,
      windowEnd: wasTrimmed ? nextIso(selected[selected.length - 1].capturedAt) : undefined,
    };
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

function failure(errorCode: string, errorMessageValue: string, modelJobId?: string, attempts?: number): TimelineBuilderResult {
  return {
    ok: false,
    blocks: [],
    dayStartSummary: "",
    dayMainThread: "",
    errorCode,
    errorMessage: errorMessageValue,
    modelJobId,
    attempts,
  };
}

function estimateTokens(text: string): number {
  let asciiChars = 0;
  let nonAsciiTokens = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 0x7f) asciiChars++;
    else nonAsciiTokens += 2;
  }
  return Math.ceil(asciiChars / 4) + nonAsciiTokens;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextIso(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString();
}
