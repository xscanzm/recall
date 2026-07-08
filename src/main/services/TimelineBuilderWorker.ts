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
import type { SettingsService } from "./SettingsService";
import { getSystemTimezone, getSystemTimezoneOffset } from "../utils/timezone";
import { normalizeIsoToZ } from "../utils/isoTime";

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
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    observationRepo: ObservationRepository;
    factRepo: FactRepository;
    sceneRepo: SceneRepository;
    timelineBlockRepo: TimelineBlockRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.observationRepo = deps.observationRepo;
    this.factRepo = deps.factRepo;
    this.sceneRepo = deps.sceneRepo;
    this.timelineBlockRepo = deps.timelineBlockRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 构建今日时间轴
   *
   * @param dateKey 日期 YYYY-MM-DD
   * @returns 构建结果（ok=true 时包含已写入的 blocks 和日总结）
   */
  async buildTimeline(dateKey: string): Promise<TimelineBuilderResult> {
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
    const lastEndAt = this.timelineBlockRepo.getLastEndAt(dateKey);
    const isInitialBuild = lastEndAt === null;
    const { startOfDay } = getDateRange(dateKey);
    const windowStart = lastEndAt ?? startOfDay;
    const windowEnd = new Date().toISOString();

    // 3. 查询增量窗口内的数据
    const observations = this.fetchObservationsByDateRange(windowStart, windowEnd);
    const facts = this.fetchFactsByDateRange(windowStart, windowEnd);
    const scenes = this.fetchScenesByDateRange(windowStart, windowEnd);

    // 数据量过少时给出明确提示，不浪费模型调用
    if (observations.length === 0 && facts.length === 0 && scenes.length === 0) {
      return {
        ok: false,
        blocks: [],
        dayStartSummary: "",
        dayMainThread: "",
        errorCode: "insufficient_data",
        errorMessage: "增量窗口内没有新的记忆数据。",
      };
    }

    // 4. 构造 TimelineBuilderInput
    // - 顶层加 systemTimezone + systemTimezoneOffset + systemNow + windowStart + windowEnd
    // - windowStart/windowEnd 明确告知 LLM 本次只处理这个时间范围
    const baseInput: TimelineBuilderInput = {
      dateKey,
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
      isIncremental: lastEndAt !== null,
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
    const blocks = this.persistBlocks(dateKey, output, windowStart, windowEnd);

    return {
      ok: true,
      blocks,
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
   * 注意：Observation 实体未持久化 V2 体验字段（userFacingSummary / privacyRisk /
   * reportableSignal），这些字段在 ObserverOutputV2 中由 LLM 输出但未落库到
   * observations 表。这里只传 LLM 需要且实体上可用的字段。
   */
  private toObservationSummary(obs: Observation): TimelineBuilderInput["observations"][number] {
    return {
      id: obs.id,
      capturedAt: obs.capturedAt,
      appName: obs.appName,
      windowTitle: obs.windowTitle,
      sceneSummary: obs.sceneSummary,
    };
  }

  /**
   * Fact 摘要（用于 TimelineBuilderInput.facts）
   *
   * 注意：Fact 实体未持久化 V2 体验字段（displayUse / reportable / privateRisk），
   * 这些字段在 ExtractorOutputV2 中由 LLM 输出但未落库到 facts 表。
   * 这里只传 LLM 需要且实体上可用的字段。
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
      sourceObservationIds: fact.sourceObservationIds,
    };
  }

  /**
   * Scene 摘要（用于 TimelineBuilderInput.scenes）
   */
  private toSceneSummary(scene: Scene): TimelineBuilderInput["scenes"][number] {
    return {
      id: scene.id,
      title: scene.title,
      summary: scene.summary,
      startAt: scene.startAt,
      endAt: scene.endAt,
      factIds: scene.factIds,
      observationIds: scene.observationIds,
    };
  }

  // ----------------------------------------------------------------
  // 持久化
  // ----------------------------------------------------------------

  /**
   * 映射 LLM 输出的 blocks 到 TimelineBlock 并增量持久化
   *
   * 2026-07-07 重大变更：
   * - 之前用 upsertMany（先 DELETE 当天全部，再 INSERT），历史会被覆盖
   * - 现在用 insertMany（只追加，不删除），历史不可变
   * - clamp startAt：防止 LLM 输出的 startAt 早于 windowStart（避免与已落盘 blocks 时间重叠）
   * - 过滤空 blocks：LLM 返回空数组时不写入（保护已有数据）
   *
   * block.id 若 LLM 未提供则自动生成
   * createdAt/updatedAt 由 Repository 统一填充
   */
  private persistBlocks(
    dateKey: string,
    output: TimelineBuilderOutput,
    windowStart: string,
    windowEnd: string
  ): TimelineBlock[] {
    if (output.blocks.length === 0) {
      // LLM 返回空数组：插入一条 break 占位 block 推进增量窗口
      // 避免下次 build 重复处理同一窗口，同时给用户可见反馈
      const placeholderBlock: TimelineBlock = {
        id: generateBlockId(dateKey),
        dateKey,
        startAt: windowStart,
        endAt: windowEnd,
        title: "（这段时间没有产生可记录的片段）",
        summary: "",
        category: "break",
        projectIds: [],
        projectNames: [],
        highlights: [],
        generatedTasks: [],
        generatedDecisions: [],
        reportable: false,
        privateRisk: "low",
        sourceSceneIds: [],
        sourceFactIds: [],
        sourceObservationIds: [],
      };
      try {
        this.timelineBlockRepo.insertMany(dateKey, [placeholderBlock]);
      } catch {
        // 持久化失败静默
      }
      return [placeholderBlock];
    }

    const blocks: TimelineBlock[] = output.blocks
      .map((item) => this.toTimelineBlock(dateKey, item))
      .map((block) => {
        // clamp startAt：不早于 windowStart（避免与已落盘 blocks 时间重叠）
        if (block.startAt < windowStart) {
          return { ...block, startAt: windowStart };
        }
        return block;
      });

    try {
      this.timelineBlockRepo.insertMany(dateKey, blocks);
    } catch {
      // 持久化失败不阻断返回（调用方仍可拿到 blocks 数据）
      // 错误已在 model_job 层面记录，此处静默
    }
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
    item: TimelineBlockOutputItem
  ): TimelineBlock {
    return {
      id: item.id ?? generateBlockId(dateKey),
      dateKey,
      // 入库前 normalize：把任何 ISO 字符串统一成 UTC Z 后缀
      // 修复：之前 LLM 可能输出无时区 / +08:00 / Z 三种格式混用，导致渲染端错位
      startAt: normalizeIsoToZ(item.startAt),
      endAt: normalizeIsoToZ(item.endAt),
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
      sourceSceneIds: item.sourceSceneIds,
      sourceFactIds: item.sourceFactIds,
      sourceObservationIds: item.sourceObservationIds,
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
function getDateRange(date: string): { startOfDay: string; endOfDay: string } {
  const from = getLocalTodayStartIsoFromDateKey(date);
  // endOfDay：从 startOfDay 加 24 小时，再 -1ms，得到当天本地 23:59:59.999 对应 UTC
  const startDate = new Date(from);
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000 - 1);
  return {
    startOfDay: from,
    endOfDay: endDate.toISOString(),
  };
}

/**
 * 从 dateKey (YYYY-MM-DD) 构造本地 00:00:00.000 的 ISO 字符串（带本地时区偏移）
 * - 与 _helpers.getLocalTodayStartIso 等价逻辑，但接受指定日期而非"今天"
 */
function getLocalTodayStartIsoFromDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) {
    // 兜底：非法 dateKey 时回退到 UTC（与旧行为一致）
    return `${dateKey}T00:00:00.000Z`;
  }
  const local = new Date(y, m - 1, d, 0, 0, 0, 0);
  const offsetMinutes = -local.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${dateKey}T00:00:00.000${sign}${hh}:${mm}`;
}

/**
 * 生成 timeline block id（LLM 未提供 id 时使用）
 * 格式：tb_<dateKey>_<base36时间>_<随机>
 */
function generateBlockId(dateKey: string): string {
  return `tb_${dateKey}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
