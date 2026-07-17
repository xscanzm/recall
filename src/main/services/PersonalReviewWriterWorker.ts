// src/main/services/PersonalReviewWriterWorker.ts
// LLM Personal Review Writer Worker（Phase 2 Task 2.4 / doc 20 第 7 节）
//
// 职责：
// - 基于当天 TimelineBlock + UnfinishedThread + decisions + memoriesWorthKeeping
// - 生成给用户自己看的今日复盘（PersonalReview）
// - 语气温和真实，不鸡汤，不写给上司看的口吻
// - 不写"今日颂歌""深海沉浸""心流年轮"等诗意词
// - 调用 ModelGateway.callMultimodal（多模态模型，超时 120,000ms）
// - zod 校验 PersonalReviewOutput
// - 写入 reports 表（type=personal_daily_review，content_json=PersonalReview JSON）
//
// 重要约束（来自 spec.md "PersonalReviewWriter Prompt"）：
// - 复盘不是工作日报，允许包含工作日报不适合出现但对用户自己有价值的内容
// - 不编造成果，不对不确定内容伪装成确定事实
// - 重要条目保留 sourceFactIds / sourceTimelineBlockIds，便于追溯
// - 输出语气温和、真实、不评判、不夸张

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue } from "./ModelJobQueue";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { UnfinishedThreadRepository } from "../db/repositories/UnfinishedThreadRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { Fact } from "../models/types";
import type { PersonalReviewInput, PersonalReviewOutput } from "../models/types";
import { PersonalReviewOutputSchema } from "../models/schemas";
import { PERSONAL_REVIEW_PROMPT_TEMPLATE } from "../models/prompts";
import type { PersonalReview, TimelineBlock, UnfinishedThread } from "../../shared/types";
import type { SettingsService } from "./SettingsService";
import type { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import {
  hasReportGenerationRequirements,
  resolveReportGenerationRequirements,
} from "./reportRequirements";

// ============================================================================
// 输入 / 输出类型
// ============================================================================

/**
 * PersonalReviewWriter 生成结果
 */
export interface PersonalReviewResult {
  ok: boolean;
  /** 已落库的 PersonalReview 实体（ok=true 时包含） */
  review?: PersonalReview;
  /** 写入数据库的 report 记录（含 id / createdAt / updatedAt） */
  reportRecord?: import("../models/types").Report;
  modelJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
}

// ============================================================================
// PersonalReviewWriterWorker
// ============================================================================

/**
 * PersonalReviewWriterWorker：个人复盘撰写员
 *
 * 工作流：
 * 1. 查询当天 TimelineBlock（按 dateKey）
 * 2. 查询当天 UnfinishedThread（按 dateKey）
 * 3. 查询当天 decisions（type=decision 的 facts，按 createdAt 过滤）
 * 4. 查询当天 memoriesWorthKeeping（importance 高或标记为 memory 的 facts）
 * 5. 构造 PersonalReviewInput JSON
 * 6. 填充 PERSONAL_REVIEW_PROMPT_TEMPLATE
 * 7. 通过 ModelJobQueue 提交 LLM 任务
 * 8. zod 校验 PersonalReviewOutput（由 ModelGateway 完成）
 * 9. 写入 reports 表（type=personal_daily_review，content_json=PersonalReview JSON）
 *
 * 语气约束（来自 spec.md / doc 20）：
 * - 温和、真实、不评判、不鸡汤、不夸张
 * - 不写"今日颂歌""深海沉浸""心流年轮"等诗意词
 * - 不写"辛苦了创造者""你点亮了灵感微光"
 * - 复盘不是工作日报口吻
 */
export class PersonalReviewWriterWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly timelineBlockRepo: TimelineBlockRepository;
  private readonly unfinishedThreadRepo: UnfinishedThreadRepository;
  private readonly factRepo: FactRepository;
  private readonly reportRepo: ReportRepository;
  private readonly settingsService: SettingsService | null;
  private readonly timelineBuilderWorker: TimelineBuilderWorker | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    timelineBlockRepo: TimelineBlockRepository;
    unfinishedThreadRepo: UnfinishedThreadRepository;
    factRepo: FactRepository;
    reportRepo: ReportRepository;
    settingsService?: SettingsService;
    timelineBuilderWorker?: TimelineBuilderWorker;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.timelineBlockRepo = deps.timelineBlockRepo;
    this.unfinishedThreadRepo = deps.unfinishedThreadRepo;
    this.factRepo = deps.factRepo;
    this.reportRepo = deps.reportRepo;
    this.settingsService = deps.settingsService ?? null;
    this.timelineBuilderWorker = deps.timelineBuilderWorker ?? null;
  }

  /**
   * 生成今日个人复盘
   *
   * @param dateKey 日期 YYYY-MM-DD
   * @returns 生成结果（ok=true 时包含 PersonalReview 和写入的 report 记录）
   */
  async writePersonalReview(
    dateKey: string,
    generationRequirement?: string
  ): Promise<PersonalReviewResult> {
    // 1. 获取多模态模型配置
    const multimodalModelConfigId = this.getActiveMultimodalModelConfigId();
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        errorCode: "no_language_model",
        errorMessage: "未配置启用的多模态模型，无法生成个人复盘",
      };
    }

    // 2. 查询当天数据
    //    先调用 buildTimeline 确保最新（spec.md 行 645 "生成报告前确保 timeline blocks 最新"）。
    //    buildTimeline 失败不阻断报告生成，继续使用现有 timeline_blocks。
    if (this.timelineBuilderWorker) {
      try {
        await this.timelineBuilderWorker.buildTimeline(dateKey, "forceFinalizeTail");
      } catch {
        // buildTimeline 失败不阻断报告生成，继续使用现有 timeline_blocks
      }
    }
    const timelineBlocks = this.fetchTimelineBlocks(dateKey);
    const unfinishedThreads = this.fetchUnfinishedThreads(dateKey);
    const decisions = this.fetchDecisions(dateKey);
    const memoriesWorthKeeping = this.fetchMemoriesWorthKeeping(dateKey);

    // 数据量过少时给出明确提示
    if (
      timelineBlocks.length === 0 &&
      unfinishedThreads.length === 0 &&
      decisions.length === 0 &&
      memoriesWorthKeeping.length === 0
    ) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage:
          "今天还没有足够记忆生成个人复盘。继续工作一会儿，或手动添加一条记录。",
      };
    }

    // 3. 构造 PersonalReviewInput
    const reportRequirements = resolveReportGenerationRequirements(
      this.settingsService,
      "personal",
      generationRequirement
    );
    const personalReviewInput: PersonalReviewInput = {
      dateKey,
      timelineBlocks,
      unfinishedThreads,
      decisions,
      memoriesWorthKeeping,
      reportRequirements,
    };
    const inputJson = JSON.stringify(personalReviewInput, null, 2);

    // 4. 填充 prompt
    const userPrompt = PERSONAL_REVIEW_PROMPT_TEMPLATE.replace(
      "{{personal_review_input_json}}",
      inputJson
    );

    // 5. 构造脱敏 jobInputJson（不含完整 fact 内容，避免存储大量数据）
    const jobInputJson = JSON.stringify({
      dateKey,
      timelineBlockCount: timelineBlocks.length,
      unfinishedThreadCount: unfinishedThreads.length,
      decisionCount: decisions.length,
      memoriesWorthKeepingCount: memoriesWorthKeeping.length,
      hasReportRequirements: hasReportGenerationRequirements(reportRequirements),
      hasTemporaryRequirement: Boolean(reportRequirements.temporary),
    });

    // 6. 提交 LLM 任务
    // ModelGateway 默认超时 120,000ms（DEFAULT_TIMEOUT_MS），满足复盘生成的耗时需求
    const result = await this.modelJobQueue.enqueueMultimodalJob<PersonalReviewOutput>({
      type: "reporter",
      executor: async () => {
        return this.modelGateway.callMultimodal<PersonalReviewOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "personal_review",
            jobInputJson,
          },
          PersonalReviewOutputSchema
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

    const parsed: PersonalReviewOutput = result.data;

    // 7. 持久化到 reports 表（type=personal_daily_review）
    const now = new Date().toISOString();
    const review: PersonalReview = {
      id: `pr_${dateKey}_${Date.now()}`,
      dateKey,
      title: parsed.title,
      overview: parsed.overview,
      mainThreads: parsed.mainThreads,
      meaningfulProgress: parsed.meaningfulProgress,
      unfinished: parsed.unfinished,
      worthRemembering: parsed.worthRemembering,
      tomorrowStartHere: parsed.tomorrowStartHere,
      createdAt: now,
      updatedAt: now,
    };

    const reportRecord = this.reportRepo.upsertPersonalReview(
      dateKey,
      review,
      reportRequirements
    );

    // 用 DB 实际的 id / createdAt / updatedAt 回填 review，保持与持久化记录一致
    const persistedReview: PersonalReview = {
      ...review,
      id: reportRecord.id,
      createdAt: reportRecord.createdAt,
      updatedAt: reportRecord.updatedAt,
    };

    return {
      ok: true,
      review: persistedReview,
      reportRecord,
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
   * 查询当天 TimelineBlock
   */
  private fetchTimelineBlocks(dateKey: string): TimelineBlock[] {
    try {
      return this.timelineBlockRepo.findByDateKey(dateKey);
    } catch {
      return [];
    }
  }

  /**
   * 查询当天 UnfinishedThread
   */
  private fetchUnfinishedThreads(dateKey: string): UnfinishedThread[] {
    try {
      return this.unfinishedThreadRepo.findByDateKey(dateKey);
    } catch {
      return [];
    }
  }

  /**
   * 查询当天 decisions（type=decision 的 facts，按 createdAt 过滤）
   *
   * 注：FactRepository 暂未提供按 createdAt 范围查询的方法，
   * 这里使用 list() 后在代码中过滤。
   */
  private fetchDecisions(dateKey: string): Fact[] {
    try {
      const { startOfDay, endOfDay } = getDateRange(dateKey);
      const all = this.factRepo.list({ includeDeleted: false, limit: 500 });
      return all.filter(
        (f) => f.type === "decision" && f.createdAt >= startOfDay && f.createdAt <= endOfDay
      );
    } catch {
      return [];
    }
  }

  /**
   * 查询当天值得保留的记忆（importance>=0.7 或 tags 含 memory）
   *
   * 用于 PersonalReviewInput.memoriesWorthKeeping，
   * 帮 LLM 识别哪些事实值得在"值得记住"部分呈现。
   */
  private fetchMemoriesWorthKeeping(dateKey: string): Fact[] {
    try {
      const { startOfDay, endOfDay } = getDateRange(dateKey);
      const all = this.factRepo.list({ includeDeleted: false, limit: 500 });
      return all.filter(
        (f) =>
          f.createdAt >= startOfDay &&
          f.createdAt <= endOfDay &&
          (f.importance >= 0.7 || f.tags.includes("memory"))
      );
    } catch {
      return [];
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算某天的起始/结束 ISO 时间
 * - startOfDay: YYYY-MM-DDT00:00:00.000Z
 * - endOfDay: YYYY-MM-DDT23:59:59.999Z
 */
function getDateRange(date: string): { startOfDay: string; endOfDay: string } {
  // 2026-07-07 变更：个人复盘数据范围改为昨天 23:00 → 今天 23:00（滚动 24 小时）
  // 原因：个人复盘在 23:00 生成，覆盖"从昨晚睡前到今晚睡前"的完整活动周期
  // 修复：之前用 UTC Z 后缀（${date}T00:00:00.000Z），在 UTC+8 时区凌晨会偏移到前一天
  const [y, m, d] = date.split("-").map(Number);
  // 今天 23:00（本地）
  const today23 = new Date(y, (m ?? 1) - 1, d ?? 1, 23, 0, 0, 0);
  // 昨天 23:00（本地）= 今天 23:00 - 24h
  const yesterday23 = new Date(today23.getTime() - 24 * 60 * 60 * 1000);
  return {
    startOfDay: yesterday23.toISOString(),
    endOfDay: today23.toISOString(),
  };
}
