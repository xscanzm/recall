// src/main/services/ReporterWorker.ts
// LLM Reporter Worker（来自 03、05 文档）
//
// 职责：
// - 生成日报、周报、月报和项目复盘
// - 不能直接总结截图，必须基于结构化记忆（facts/scenes/tasks/decisions/projects/proactive_items）
// - 重要条目必须保留 evidenceFactIds 或 evidenceSceneIds
// - 不确定内容放入 needsReview（日报）或 risks（周报/月报），不要写成确定事实
// - 调用 ModelGateway.callMultimodal
// - zod 校验 DailyReportOutput / WeeklyReportOutput / MonthlyReportOutput
// - 写入 reports 表（type=daily/weekly/monthly，content_json = 报告 JSON）
//
// 重要约束（来自 spec.md "LLM Reporter 合约"）：
// - 报告必须基于 facts/scenes，不直接引用截图
// - 报告风格：清晰 / 可复制 / 偏工作汇报 / 不夸张 / 不机械流水账
// - 低置信内容放入 needsReview，不伪装成确定事实
// - 重要条目必须有 evidenceFactIds 或 evidenceSceneIds

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type {
  Scene,
  Fact,
  Project,
  Task,
  Decision,
  ProactiveItem,
  Report,
} from "../models/types";
import type {
  DailyReportOutput,
  WeeklyReportOutput,
  MonthlyReportOutput,
} from "../models/schemas";
import {
  DailyReportOutputSchema,
  WeeklyReportOutputSchema,
  MonthlyReportOutputSchema,
} from "../models/schemas";
import { REPORTER_PROMPT_TEMPLATE } from "../models/prompts";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { ProactiveItemRepository } from "../db/repositories/ProactiveItemRepository";
import type { SettingsService } from "./SettingsService";
import type {
  ReportGenerationRequirementsSnapshot,
} from "../../shared/reportRequirements";
import {
  hasReportGenerationRequirements,
  resolveReportGenerationRequirements,
} from "./reportRequirements";
import type { InfographicService } from "./InfographicService";
import { localDateKeyUtcRange } from "../utils/dateKey";

// ============================================================================
// 输入类型（来自 spec.md "LLM Reporter 合约"）
// ============================================================================

/**
 * DailyReportInput（来自 spec.md）
 *
 * 注意：scenes/facts 是今日的数据；projects/tasks 是当前活跃的；
 * decisions 是今日的；proactiveItems 是今日新增的；
 * reportRequirements 来自用户长期维护的报告要求和本次补充要求。
 *
 * 字段类型使用 unknown[]：因为传入的是 to*Summary 方法构造的精简结构，
 * 不是数据库原始记录类型。
 */
export interface DailyReportInput {
  date: string;
  scenes: unknown[];
  facts: unknown[];
  projects: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  proactiveItems: unknown[];
  reportRequirements: ReportGenerationRequirementsSnapshot;
}

/**
 * WeeklyReportInput（来自 02 文档 Flow 8）
 *
 * 输入：
 * - 本周 daily reports
 * - 本周 scenes
 * - 本周 project progress（用 active projects 表达）
 * - 本周 completed/open tasks
 * - 本周 decisions
 *
 * 字段类型使用 unknown[]：同 DailyReportInput。
 */
export interface WeeklyReportInput {
  weekStart: string;
  weekEnd: string;
  dailyReports: Array<{
    date: string;
    headline: string;
    overview: string;
  }>;
  scenes: unknown[];
  facts: unknown[];
  projects: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  reportRequirements: ReportGenerationRequirementsSnapshot;
}

/**
 * MonthlyReportInput：自然月范围内的结构化输入。
 *
 * 与周报共享内容板块，但周期字段明确使用 monthStart/monthEnd，避免把
 * 月报降级成“从月初开始的一周”。
 */
export interface MonthlyReportInput {
  monthStart: string;
  monthEnd: string;
  dailyReports: Array<{
    date: string;
    headline: string;
    overview: string;
  }>;
  scenes: unknown[];
  facts: unknown[];
  projects: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  reportRequirements: ReportGenerationRequirementsSnapshot;
}

// ============================================================================
// 输出类型
// ============================================================================

/**
 * 日报生成结果
 */
export interface DailyReportResult {
  ok: boolean;
  report?: DailyReportOutput;
  /** 写入数据库的 report 记录（含 id） */
  reportRecord?: Report;
  modelJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
}

/**
 * 周报生成结果
 */
export interface WeeklyReportResult {
  ok: boolean;
  report?: WeeklyReportOutput;
  reportRecord?: Report;
  modelJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
}

/**
 * 月报生成结果。
 */
export interface MonthlyReportResult {
  ok: boolean;
  report?: MonthlyReportOutput;
  reportRecord?: Report;
  modelJobId?: string;
  errorCode?: string;
  errorMessage?: string;
  attempts?: number;
}

// ============================================================================
// ReporterWorker
// ============================================================================

/**
 * ReporterWorker：报告生成员
 *
 * 工作流（日报）：
 * 1. 查询今日 scenes（按 startAt 过滤）
 * 2. 查询今日 facts（按 createdAt 过滤）
 * 3. 查询 active projects
 * 4. 查询 open/in_progress/needs_confirmation tasks
 * 5. 查询今日 decisions
 * 6. 查询今日 proactive_items
 * 7. 读取长期报告要求与本次补充要求
 * 8. 构造 DailyReportInput JSON
 * 9. 填充 REPORTER_PROMPT_TEMPLATE
 * 10. 通过 ModelJobQueue 提交 LLM 任务
 * 11. zod 校验 DailyReportOutput（由 ModelGateway 完成）
 * 12. 写入 reports 表（type=daily, content_json=JSON）
 *
 * 周报工作流使用自然周范围；月报工作流使用自然月范围和独立输出契约。
 */
export class ReporterWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly reportRepo: ReportRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly factRepo: FactRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly settingsService: SettingsService | null;
  private readonly infographicService: InfographicService | null;
  private readonly onReportGenerated?: (report: Report) => void;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    reportRepo: ReportRepository;
    sceneRepo: SceneRepository;
    factRepo: FactRepository;
    memoryObjectRepo: MemoryObjectRepository;
    proactiveItemRepo: ProactiveItemRepository;
    settingsService?: SettingsService;
    infographicService?: InfographicService;
    onReportGenerated?: (report: Report) => void;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.reportRepo = deps.reportRepo;
    this.sceneRepo = deps.sceneRepo;
    this.factRepo = deps.factRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.settingsService = deps.settingsService ?? null;
    this.infographicService = deps.infographicService ?? null;
    this.onReportGenerated = deps.onReportGenerated;
  }

  /**
   * 生成日报
   *
   * @param date 日期 YYYY-MM-DD
   * @returns 日报生成结果（ok=true 时包含 DailyReportOutput 和写入的 report 记录）
   */
  async generateDailyReport(
    date: string,
    generationRequirement?: string
  ): Promise<DailyReportResult> {
    // 1. 获取多模态模型配置
    const multimodalModelConfigId = await this.modelGateway.resolveConfigId("text");
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        errorCode: "no_language_model",
        errorMessage: "没有可用的语言模型服务，无法生成日报",
      };
    }

    // 2. 查询今日数据
    const { startOfDay, endOfDay } = getDateRange(date, this.getDailyReportTime());
    const scenes = filterReportableSources(this.fetchScenesByDateRange(startOfDay, endOfDay));
    const facts = filterReportableSources(this.fetchFactsByDateRange(startOfDay, endOfDay));
    const projects = this.fetchActiveProjects();
    const tasks = this.fetchOpenTasks();
    const decisions = this.fetchDecisionsByDateRange(startOfDay, endOfDay);
    const proactiveItems = this.fetchProactiveItemsByDateRange(startOfDay, endOfDay);
    const reportRequirements = resolveReportGenerationRequirements(
      this.settingsService,
      "work",
      generationRequirement
    );

    // 数据量过少时给出明确提示
    if (scenes.length === 0 && facts.length === 0) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage: "今天还没有足够记忆生成日报。继续工作一会儿，或手动添加一条记录。",
      };
    }

    // 3. 构造 DailyReportInput
    const dailyReportInput: DailyReportInput = {
      date,
      scenes: scenes.map(this.toSceneSummary),
      facts: facts.map(this.toFactSummary),
      projects: projects.map(this.toProjectSummary),
      tasks: tasks.map(this.toTaskSummary),
      decisions: decisions.map(this.toDecisionSummary),
      proactiveItems: proactiveItems.map(this.toProactiveItemSummary),
      reportRequirements,
    };
    const inputJson = JSON.stringify(dailyReportInput, null, 2);

    // 4. 填充 prompt
    const userPrompt = REPORTER_PROMPT_TEMPLATE.replace(
      "{{reporter_input_json}}",
      inputJson
    );

    // 5. 构造脱敏 jobInputJson（不含完整 fact 内容，避免存储大量数据）
    const jobInputJson = JSON.stringify({
      date,
      sceneCount: scenes.length,
      factCount: facts.length,
      projectCount: projects.length,
      taskCount: tasks.length,
      decisionCount: decisions.length,
      proactiveItemCount: proactiveItems.length,
      hasReportRequirements: hasReportGenerationRequirements(reportRequirements),
      hasTemporaryRequirement: Boolean(reportRequirements.temporary),
    });

    // 6. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueMultimodalJob<DailyReportOutput>({
      type: "reporter",
      rateLimitKey: multimodalModelConfigId,
      executor: async () => {
        return this.modelGateway.callByConfigId<DailyReportOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "reporter",
            jobInputJson,
          },
          DailyReportOutputSchema
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

    const report = result.data;

    // 7. 写入 reports 表（type=daily, content_json=报告 JSON）
    // 重要条目的 evidenceFactIds 和 evidenceSceneIds 已包含在 content_json 中
    // 同时聚合 sourceFactIds / sourceSceneIds 用于检索
    const sourceFactIds = collectFactIds(report);
    const sourceSceneIds = collectSceneIds(report);

    const reportRecord = this.reportRepo.create({
      type: "daily",
      dateKey: date,
      title: report.headline || `日报 ${date}`,
      contentJson: JSON.stringify({ ...report, reportRequirements }),
      sourceFactIds,
      sourceSceneIds,
    });
    this.onReportGenerated?.(reportRecord);
    void this.infographicService?.generateForReport(reportRecord, reportRequirements);

    return {
      ok: true,
      report,
      reportRecord,
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  /**
   * 生成周报
   *
   * @param weekStart 周开始日期 YYYY-MM-DD（默认周一）
   * @returns 周报生成结果
   */
  async generateWeeklyReport(
    weekStart: string,
    options: { generationRequirement?: string } = {}
  ): Promise<WeeklyReportResult> {
    // 1. 获取多模态模型配置
    const multimodalModelConfigId = await this.modelGateway.resolveConfigId("text");
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        errorCode: "no_language_model",
        errorMessage: "没有可用的语言模型服务，无法生成周报",
      };
    }

    // 2. 计算周起止日期（weekStart 到 weekStart+6）
    const weekEnd = addDays(weekStart, 6);

    // 3. 查询本周 daily reports
    const dailyReports = this.fetchDailyReportsByDateRange(weekStart, weekEnd);

    // 4. 查询本周 scenes/facts/projects/tasks/decisions
    const weekStartIso = `${weekStart}T00:00:00.000Z`;
    const weekEndIso = `${weekEnd}T23:59:59.999Z`;
    const scenes = filterReportableSources(this.sceneRepo.listByStartAt({
      from: weekStartIso,
      to: weekEndIso,
      limit: 200,
    }));
    const facts = filterReportableSources(this.fetchFactsByDateRange(weekStartIso, weekEndIso));
    const projects = this.fetchActiveProjects();
    const tasks = this.fetchOpenTasks();
    const decisions = this.memoryObjectRepo.listDecisions({ limit: 50 });

    // 数据量过少时给出明确提示
    if (dailyReports.length === 0 && scenes.length === 0 && facts.length === 0) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage: "本周还没有足够记忆生成周报。",
      };
    }

    const reportRequirements = resolveReportGenerationRequirements(
      this.settingsService,
      "weekly",
      options.generationRequirement
    );

    // 5. 构造 WeeklyReportInput
    const weeklyReportInput: WeeklyReportInput = {
      weekStart,
      weekEnd,
      dailyReports: dailyReports.map((r) => ({
        date: r.dateKey,
        headline: extractHeadline(r),
        overview: extractOverview(r),
      })),
      scenes: scenes.map(this.toSceneSummary),
      facts: facts.map(this.toFactSummary),
      projects: projects.map(this.toProjectSummary),
      tasks: tasks.map(this.toTaskSummary),
      decisions: decisions.map(this.toDecisionSummary),
      reportRequirements,
    };
    const inputJson = JSON.stringify(weeklyReportInput, null, 2);

    // 6. 填充 prompt（周报使用同一 Reporter prompt，模型会根据 input 自适应）
    const weeklyUserPrompt = buildWeeklyPrompt(inputJson);

    // 7. 构造脱敏 jobInputJson
    const jobInputJson = JSON.stringify({
      weekStart,
      weekEnd,
      dailyReportCount: dailyReports.length,
      sceneCount: scenes.length,
      factCount: facts.length,
      projectCount: projects.length,
      taskCount: tasks.length,
      decisionCount: decisions.length,
      reportType: "weekly",
      hasReportRequirements: hasReportGenerationRequirements(reportRequirements),
      hasTemporaryRequirement: Boolean(reportRequirements.temporary),
    });

    // 8. 提交 LLM 任务
    const result = await this.modelJobQueue.enqueueMultimodalJob<WeeklyReportOutput>({
      type: "reporter",
      rateLimitKey: multimodalModelConfigId,
      executor: async () => {
        return this.modelGateway.callByConfigId<WeeklyReportOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt: weeklyUserPrompt,
            jobType: "reporter",
            jobInputJson,
          },
          WeeklyReportOutputSchema
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

    const report = result.data;

    // 9. 写入 reports 表（type=weekly, date_key=weekStart）
    const sourceFactIds = collectWeeklyFactIds(report);
    const sourceSceneIds = collectWeeklySceneIds(report);

    const reportRecord = this.reportRepo.create({
      type: "weekly",
      dateKey: weekStart,
      title: report.headline || `周报 ${weekStart}`,
      contentJson: JSON.stringify({ ...report, reportRequirements }),
      sourceFactIds,
      sourceSceneIds,
    });
    this.onReportGenerated?.(reportRecord);
    void this.infographicService?.generateForReport(reportRecord, reportRequirements);

    return {
      ok: true,
      report,
      reportRecord,
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  /**
   * 生成月报。
   *
   * 月报使用自然月首日到末日的完整数据范围，不复用周报的 weekStart /
   * weekEnd / nextWeekSuggestions 契约。
   */
  async generateMonthlyReport(
    monthKey: string,
    generationRequirement?: string
  ): Promise<MonthlyReportResult> {
    // 1. 获取多模态模型配置
    const multimodalModelConfigId = await this.modelGateway.resolveConfigId("text");
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        errorCode: "no_language_model",
        errorMessage: "没有可用的语言模型服务，无法生成月报",
      };
    }

    const { monthStart, monthEnd } = getCalendarMonthRange(monthKey);
    const monthStartIso = localDateKeyUtcRange(monthStart).start;
    const monthEndExclusiveIso = localDateKeyUtcRange(monthEnd).end;
    const monthEndIso = new Date(
      new Date(monthEndExclusiveIso).getTime() - 1
    ).toISOString();

    // 2. 查询整月 daily reports / scenes / facts
    const dailyReports = this.fetchDailyReportsByDateRange(monthStart, monthEnd, 31);
    const scenes = filterReportableSources(this.sceneRepo.listByStartAt({
      from: monthStartIso,
      to: monthEndIso,
      limit: 500,
    }));
    const facts = filterReportableSources(this.fetchFactsByDateRange(monthStartIso, monthEndIso));
    const projects = this.fetchActiveProjects();
    const tasks = this.fetchOpenTasks();
    const decisions = this.memoryObjectRepo.listDecisions({ limit: 200 });

    if (dailyReports.length === 0 && scenes.length === 0 && facts.length === 0) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage: "本月还没有足够记忆生成月报。",
      };
    }

    const reportRequirements = resolveReportGenerationRequirements(
      this.settingsService,
      "monthly",
      generationRequirement
    );

    // 3. 构造 MonthlyReportInput
    const monthlyReportInput: MonthlyReportInput = {
      monthStart,
      monthEnd,
      dailyReports: dailyReports.map((r) => ({
        date: r.dateKey,
        headline: extractHeadline(r),
        overview: extractOverview(r),
      })),
      scenes: scenes.map(this.toSceneSummary),
      facts: facts.map(this.toFactSummary),
      projects: projects.map(this.toProjectSummary),
      tasks: tasks.map(this.toTaskSummary),
      decisions: decisions.map(this.toDecisionSummary),
      reportRequirements,
    };
    const inputJson = JSON.stringify(monthlyReportInput, null, 2);

    // 4. 使用独立月报提示词和输出 schema
    const monthlyUserPrompt = buildMonthlyPrompt(inputJson);
    const jobInputJson = JSON.stringify({
      monthStart,
      monthEnd,
      dailyReportCount: dailyReports.length,
      sceneCount: scenes.length,
      factCount: facts.length,
      projectCount: projects.length,
      taskCount: tasks.length,
      decisionCount: decisions.length,
      reportType: "monthly",
      hasReportRequirements: hasReportGenerationRequirements(reportRequirements),
      hasTemporaryRequirement: Boolean(reportRequirements.temporary),
    });

    const result = await this.modelJobQueue.enqueueMultimodalJob<MonthlyReportOutput>({
      type: "reporter",
      rateLimitKey: multimodalModelConfigId,
      executor: async () => {
        return this.modelGateway.callByConfigId<MonthlyReportOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt: monthlyUserPrompt,
            jobType: "reporter",
            jobInputJson,
          },
          MonthlyReportOutputSchema
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

    const report = result.data;
    const reportRecord = this.reportRepo.create({
      type: "monthly",
      dateKey: monthStart,
      title: report.headline || `月报 ${monthKey}`,
      contentJson: JSON.stringify({ ...report, reportRequirements }),
      sourceFactIds: collectWeeklyFactIds(report),
      sourceSceneIds: collectWeeklySceneIds(report),
    });
    this.onReportGenerated?.(reportRecord);
    void this.infographicService?.generateForReport(reportRecord, reportRequirements);

    return {
      ok: true,
      report,
      reportRecord,
      modelJobId: result.modelJobId,
      attempts: result.attempts,
    };
  }

  // ----------------------------------------------------------------
  // 数据检索
  // ----------------------------------------------------------------

  /**
   * 查询指定日期范围的 scenes
   */
  private fetchScenesByDateRange(startIso: string, endIso: string): Scene[] {
    try {
      return this.sceneRepo.listByStartAt({
        from: startIso,
        to: endIso,
        limit: 100,
      });
    } catch {
      return [];
    }
  }

  /**
   * 查询指定日期范围的 facts
   * 注：FactRepository 暂未提供按 createdAt 范围查询的方法，
   * 这里使用 list() 后在代码中过滤。
   */
  private fetchFactsByDateRange(startIso: string, endIso: string): Fact[] {
    try {
      const all = this.factRepo.list({ includeDeleted: false, limit: 500 });
      return all.filter((f) => {
        return f.createdAt >= startIso && f.createdAt <= endIso;
      });
    } catch {
      return [];
    }
  }

  /**
   * 查询活跃项目
   */
  private fetchActiveProjects(): Project[] {
    try {
      return this.memoryObjectRepo.listProjects({
        status: "active",
        limit: 30,
      });
    } catch {
      return [];
    }
  }

  /**
   * 查询未完成任务（open/in_progress/likely_done/needs_confirmation/blocked）
   */
  private fetchOpenTasks(): Task[] {
    try {
      const statuses = [
        "open",
        "in_progress",
        "likely_done",
        "needs_confirmation",
        "blocked",
      ];
      const all: Task[] = [];
      for (const status of statuses) {
        const list = this.memoryObjectRepo.listTasks({ status, limit: 50 });
        all.push(...list);
      }
      // 去重（同一 task 可能因多次更新出现在多个状态查询中，理论上不会）
      const seen = new Set<string>();
      return all.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
    } catch {
      return [];
    }
  }

  /**
   * 查询指定日期范围的 decisions
   * 注：decision 表按 decided_at 排序，此处用 createdAt 过滤
   */
  private fetchDecisionsByDateRange(startIso: string, endIso: string): Decision[] {
    try {
      const all = this.memoryObjectRepo.listDecisions({ limit: 100 });
      return all.filter((d) => {
        const ts = d.decidedAt ?? d.createdAt;
        return ts >= startIso && ts <= endIso;
      });
    } catch {
      return [];
    }
  }

  /**
   * 查询指定日期范围的 proactive_items
   * 注：使用 list() 后在代码中过滤 createdAt
   */
  private fetchProactiveItemsByDateRange(
    startIso: string,
    endIso: string
  ): ProactiveItem[] {
    try {
      const all = this.proactiveItemRepo.list({ limit: 100 });
      return all.filter((p) => {
        return p.createdAt >= startIso && p.createdAt <= endIso;
      });
    } catch {
      return [];
    }
  }

  /**
   * 获取日报生成时间，保证数据窗口与调度时间一致。
   */
  private getDailyReportTime(): string {
    try {
      const settings = this.settingsService?.getAll();
      return settings?.notification.dailyReportTime || settings?.dailyReport.time || "17:30";
    } catch {
      return "17:30";
    }
  }

  /**
   * 查询指定日期范围内的 daily reports
   */
  private fetchDailyReportsByDateRange(
    dateFrom: string,
    dateTo: string,
    limit = 7
  ): Report[] {
    try {
      return this.reportRepo.list({
        type: "daily",
        dateFrom,
        dateTo,
        limit,
      });
    } catch {
      return [];
    }
  }

  // ----------------------------------------------------------------
  // 摘要构造（去除数据库内部字段，仅保留模型需要的语义字段）
  // ----------------------------------------------------------------

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
      evidenceText: fact.evidenceText,
      tags: fact.tags,
      createdAt: fact.createdAt,
    };
  }

  private toProjectSummary(project: Project): unknown {
    return {
      id: project.id,
      name: project.name,
      summary: project.summary,
      status: project.status,
      lastActiveAt: project.lastActiveAt,
    };
  }

  private toTaskSummary(task: Task): unknown {
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      projectId: task.projectId,
      summary: task.summary,
      dueHint: task.dueHint,
      priority: task.priority,
      confidence: task.confidence,
    };
  }

  private toDecisionSummary(decision: Decision): unknown {
    return {
      id: decision.id,
      title: decision.title,
      decision: decision.decision,
      projectId: decision.projectId,
      rationale: decision.rationale,
      confidence: decision.confidence,
      decidedAt: decision.decidedAt,
    };
  }

  private toProactiveItemSummary(item: ProactiveItem): unknown {
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      body: item.body,
      reason: item.reason,
      priority: item.priority,
      surface: item.surface,
      requiresUserConfirmation: item.requiresUserConfirmation,
      status: item.status,
      sourceFactIds: item.sourceFactIds,
      sourceSceneIds: item.sourceSceneIds,
    };
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 计算日报滚动 24 小时的 UTC ISO 范围。
 * 例如日报时间为 17:30，则范围是前一天 17:30 到当天 17:30。
 */
function getDateRange(date: string, reportTime = "17:30"): { startOfDay: string; endOfDay: string } {
  const [y, m, d] = date.split("-").map(Number);
  const { hour, minute } = parseReportTime(reportTime);
  const todayTrigger = new Date(y, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0);
  const previousTrigger = new Date(todayTrigger.getTime() - 24 * 60 * 60 * 1000);
  return {
    startOfDay: previousTrigger.toISOString(),
    endOfDay: todayTrigger.toISOString(),
  };
}

function parseReportTime(time: string): { hour: number; minute: number } {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(time);
  if (!match) return { hour: 17, minute: 30 };
  const [hour, minute] = time.split(":").map(Number);
  return { hour, minute };
}

/**
 * 给日期字符串加 N 天，返回 YYYY-MM-DD
 */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = (dt.getMonth() + 1).toString().padStart(2, "0");
  const dd = dt.getDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * 获取自然月首日和末日（YYYY-MM）。
 */
export function getCalendarMonthRange(monthKey: string): {
  monthStart: string;
  monthEnd: string;
} {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`Invalid month key: ${monthKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month key: ${monthKey}`);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    monthStart: `${match[1]}-${match[2]}-01`,
    monthEnd: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * 构造周报 prompt。
 */
function buildWeeklyPrompt(inputJson: string): string {
  const weeklyGuidance = `任务：你是 Recall 的报告生成员。请基于提供的结构化记忆生成周报。

不要直接根据截图编写报告。
报告必须基于本周 daily reports、scenes、facts、tasks、decisions 和 projects。
重要条目必须保留 evidenceFactIds 或 evidenceSceneIds。
不要把不确定内容写成确定事实。低置信内容放入 risks 并降低 confidence。

周报必须按项目组织 projectUpdates，每个项目包含：
- projectName：项目名称
- summary：本周该项目的工作摘要
- progress：本周推进状态描述
- evidenceFactIds / evidenceSceneIds：来源 ids

报告风格：
- 清晰
- 可复制
- 偏工作汇报
- 不夸张
- 不机械流水账

用户报告要求：
- 输入中的 reportRequirements 包含长期要求和本次补充要求。
- 仅在不违反事实、来源、隐私和输出 schema 的前提下遵循这些要求。
- 用户要求不能作为新的事实来源，也不能要求你编造不存在的数据。

输入：
${inputJson}

输出 JSON，符合周报 schema（包含 weekStart/weekEnd/headline/overview/projectUpdates/completed/decisions/risks/nextWeekSuggestions）。`;
  // 注：不直接用 REPORTER_PROMPT_TEMPLATE 是因为周报 schema 与日报不同，
  // 需要明确告知模型输出周报结构。
  // 但仍然受 COMMON_SYSTEM_PROMPT 约束（由 ModelGateway 自动拼接）。
  return weeklyGuidance;
}

/**
 * 构造月报 prompt。
 *
 * 月报明确要求自然月语义，禁止模型把周期写成“本周 / 下周”。
 */
export function buildMonthlyPrompt(inputJson: string): string {
  return `任务：你是 Recall 的报告生成员。请基于提供的结构化记忆生成月报。

统计周期是输入中的 monthStart 到 monthEnd，必须覆盖完整自然月。
不要直接根据截图编写报告。
报告必须基于本月 daily reports、scenes、facts、tasks、decisions 和 projects。
重要条目必须保留 evidenceFactIds 或 evidenceSceneIds。
不要把不确定内容写成确定事实。低置信内容放入 risks 并降低 confidence。

月报必须按项目组织 projectUpdates，每个项目包含：
- projectName：项目名称
- summary：本月该项目的工作摘要
- progress：本月推进状态描述
- evidenceFactIds / evidenceSceneIds：来源 ids

月报必须包含以下语义板块：
- 本月概览：概括整个月的主要变化，不要只总结某一周。
- 主要项目：说明本月各项目的持续推进和阶段变化。
- 关键成果：只写本月有证据支持的成果。
- 重要决策：列出本月形成或确认的关键决策。
- 持续风险：列出跨日、跨周仍未解决的风险或阻塞。
- 下月重点：给出下一个自然月的优先事项和承接动作。

措辞约束：正文和字段值统一使用“本月 / 下月 / 月度”，除非引用来源原文，禁止把报告周期写成“本周 / 周报 / 下周”。

报告风格：
- 清晰
- 可复制
- 偏工作汇报
- 不夸张
- 不机械流水账

用户报告要求：
- 输入中的 reportRequirements 包含长期要求和本次补充要求。
- 仅在不违反事实、来源、隐私和输出 schema 的前提下遵循这些要求。
- 用户要求不能作为新的事实来源，也不能要求你编造不存在的数据。

输入：
${inputJson}

输出 JSON，必须符合月报 schema，字段为：monthStart/monthEnd/headline/overview/projectUpdates/completed/decisions/risks/nextMonthSuggestions。
不要输出 weekStart、weekEnd 或 nextWeekSuggestions。`;
}

/**
 * 从日报中收集所有 evidenceFactIds（用于 reports.source_fact_ids_json）
 */
function collectFactIds(report: DailyReportOutput): string[] {
  const ids = new Set<string>();
  for (const item of report.projectUpdates) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.completed) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.openTasks) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.decisions) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.risks) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.needsReview) {
    for (const id of item.sourceFactIds) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * 从日报中收集所有 evidenceSceneIds
 */
function collectSceneIds(report: DailyReportOutput): string[] {
  const ids = new Set<string>();
  for (const item of report.projectUpdates) {
    for (const id of item.evidenceSceneIds) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * 从周报中收集所有 evidenceFactIds
 */
function collectWeeklyFactIds(report: WeeklyReportOutput | MonthlyReportOutput): string[] {
  const ids = new Set<string>();
  for (const item of report.projectUpdates) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.completed) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.decisions) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  for (const item of report.risks) {
    for (const id of item.evidenceFactIds) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * 从周报中收集所有 evidenceSceneIds
 */
function collectWeeklySceneIds(report: WeeklyReportOutput | MonthlyReportOutput): string[] {
  const ids = new Set<string>();
  for (const item of report.projectUpdates) {
    for (const id of item.evidenceSceneIds) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * 从 report 记录中提取 headline
 */
function extractHeadline(report: Report): string {
  try {
    const parsed = JSON.parse(report.contentJson) as { headline?: string };
    return parsed.headline ?? report.title;
  } catch {
    return report.title;
  }
}

/**
 * 从 report 记录中提取 overview
 */
function extractOverview(report: Report): string {
  try {
    const parsed = JSON.parse(report.contentJson) as { overview?: string };
    return parsed.overview ?? "";
  } catch {
    return "";
  }
}

/**
 * 兼容 JobResult 类型导入（避免未使用 import 警告）
 */
export type { JobResult };

export function filterReportableSources<T>(items: T[]): T[] {
  return items.filter((item) => {
    if (!item || typeof item !== "object") return true;
    const source = item as { reportable?: boolean | null; privateRisk?: string | null };
    return source.reportable !== false && source.privateRisk !== "high";
  });
}
