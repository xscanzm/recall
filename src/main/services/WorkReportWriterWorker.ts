// src/main/services/WorkReportWriterWorker.ts
// WorkReportWriter Worker（Phase 2 Task 2.5，来自 doc 20 第 8 节 / spec.md 行 967-1057）
//
// 职责：
// - 基于用户选中的 TimelineBlock + 关联的 reportable Facts 生成工作日报
// - 严格过滤 privateRisk=high 内容（block 级 + fact 级双重过滤）
// - 不引用未选择内容
// - 不出现"我看到你"等产品视角（由 prompt 约束）
// - 调用 ModelGateway.callMultimodal（超时 120,000ms，由 DEFAULT_TIMEOUT_MS 保证）
// - zod 校验 WorkReportOutput（由 ModelGateway 完成）
// - 持久化到 reports 表（type=work_daily_report，content_json=WorkReport JSON）
// - 写入 report_selections 表记录 selected/excluded timeline block ids
//
// 重要约束（来自 spec.md "WorkReportWriter Worker"）：
// - 只允许传入用户勾选或系统预选后用户确认的 TimelineBlock
// - 不得引用未选择内容
// - 不得包含私人聊天、娱乐、账号、支付、密码、家庭、医疗等敏感内容
// - 不得编造完成事项；不确定内容放到"风险/待确认"
// - 输出专业、简洁、可提交
//
// Model job 超时 120,000ms（与项目记忆约束一致，由 ModelGateway.DEFAULT_TIMEOUT_MS 保证）。

import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue } from "./ModelJobQueue";
import type {
  Fact,
  Report,
  WorkReportInput,
  WorkReportOutput,
  WorkReport,
  TimelineBlock,
} from "../models/types";
import { WorkReportOutputSchema } from "../models/schemas";
import { WORK_REPORT_PROMPT_TEMPLATE } from "../models/prompts";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { ReportSelectionRepository } from "../db/repositories/ReportSelectionRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { SettingsService } from "./SettingsService";
import type { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import {
  hasReportGenerationRequirements,
  resolveReportGenerationRequirements,
} from "./reportRequirements";
import type { InfographicService } from "./InfographicService";

// ============================================================================
// 结果类型
// ============================================================================

/**
 * 工作日报生成结果
 *
 * 参照 ReporterWorker.DailyReportResult 模式：
 * - ok=true 时包含 report（WorkReport 实体）和 reportRecord（Report DB 记录）
 * - ok=false 时包含 errorCode/errorMessage
 */
export interface WorkReportResult {
  ok: boolean;
  /** 持久化后的 WorkReport 实体（ok=true 时有值） */
  report?: WorkReport;
  /** 写入数据库的 report 记录（ok=true 时有值） */
  reportRecord?: Report;
  /** model_job id（用于追踪） */
  modelJobId?: string;
  /** 失败错误码 */
  errorCode?: string;
  /** 失败错误信息 */
  errorMessage?: string;
  /** 尝试次数 */
  attempts?: number;
}

// ============================================================================
// WorkReportWriterWorker
// ============================================================================

/**
 * WorkReportWriterWorker：工作日报撰写员
 *
 * 工作流：
 * 1. 查询当日所有 TimelineBlock
 * 2. 过滤到用户选中的 block（selectedBlockIds）
 * 3. 严格过滤 privateRisk=high block（不传入 LLM，计入 omittedForPrivacy）
 * 4. 收集选中 block 关联的 sourceFactIds
 * 5. 批量加载 Facts（仅未删除，使用 listByIds）
 * 6. 防御性过滤 reportable=false / privateRisk=high 的 facts（持久化 Fact 暂无此字段，过滤为前瞻性兜底）
 * 7. 构造 WorkReportInput JSON
 * 8. 填充 WORK_REPORT_PROMPT_TEMPLATE
 * 9. 通过 ModelJobQueue 提交 LLM 任务（超时 120,000ms）
 * 10. zod 校验 WorkReportOutput（由 ModelGateway 完成）
 * 11. 持久化到 reports 表（type=work_daily_report，content_json 含完整 WorkReport + 元数据）
 * 12. 写入 report_selections 表记录 selected/excluded ids
 *
 * 隐私约束：
 * - 只加载用户选中的 TimelineBlock
 * - 严格过滤 privateRisk=high 内容（block 级 + fact 级双重过滤）
 * - 不引用未选择内容
 * - 不出现"我看到你"等产品视角（由 prompt 约束）
 */
export class WorkReportWriterWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly timelineBlockRepo: TimelineBlockRepository;
  private readonly reportSelectionRepo: ReportSelectionRepository;
  private readonly factRepo: FactRepository;
  private readonly reportRepo: ReportRepository;
  private readonly settingsService: SettingsService | null;
  private readonly timelineBuilderWorker: TimelineBuilderWorker | null;
  private readonly infographicService: InfographicService | null;
  private readonly onReportGenerated?: (report: Report) => void;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    timelineBlockRepo: TimelineBlockRepository;
    reportSelectionRepo: ReportSelectionRepository;
    factRepo: FactRepository;
    reportRepo: ReportRepository;
    settingsService?: SettingsService;
    timelineBuilderWorker?: TimelineBuilderWorker;
    infographicService?: InfographicService;
    onReportGenerated?: (report: Report) => void;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.timelineBlockRepo = deps.timelineBlockRepo;
    this.reportSelectionRepo = deps.reportSelectionRepo;
    this.factRepo = deps.factRepo;
    this.reportRepo = deps.reportRepo;
    this.settingsService = deps.settingsService ?? null;
    this.timelineBuilderWorker = deps.timelineBuilderWorker ?? null;
    this.infographicService = deps.infographicService ?? null;
    this.onReportGenerated = deps.onReportGenerated;
  }

  /**
   * 生成工作日报
   *
   * @param dateKey 日期 YYYY-MM-DD
   * @param selectedBlockIds 用户选中的 TimelineBlock id 列表
   * @param style 日报风格：brief / standard / formal
   * @param recipientHint 接收者提示：manager / team / client / self
   * @returns 日报生成结果（ok=true 时包含 WorkReport 和 Report 记录）
   */
  async writeWorkReport(
    dateKey: string,
    selectedBlockIds: string[],
    style: "brief" | "standard" | "formal",
    recipientHint?: "manager" | "team" | "client" | "self",
    generationRequirement?: string
  ): Promise<WorkReportResult> {
    // 1. 获取启用的多模态模型配置
    const multimodalModelConfigId = await this.modelGateway.resolveConfigId("text");
    if (!multimodalModelConfigId) {
      return {
        ok: false,
        errorCode: "no_language_model",
        errorMessage: "没有可用的语言模型服务，无法生成工作日报",
      };
    }

    // 2. 加载当日所有 TimelineBlock
    //    先调用 buildTimeline 确保最新（spec.md 行 645 "生成报告前确保 timeline blocks 最新"）。
    //    buildTimeline 失败不阻断报告生成，继续使用现有 timeline_blocks。
    if (this.timelineBuilderWorker) {
      try {
        await this.timelineBuilderWorker.buildTimeline(dateKey, "forceFinalizeTail");
      } catch {
        // buildTimeline 失败不阻断报告生成，继续使用现有 timeline_blocks
      }
    }
    const allBlocks = this.fetchTimelineBlocks(dateKey);
    if (allBlocks.length === 0) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage: "当天没有 TimelineBlock，无法生成工作日报。请先生成时间轴。",
      };
    }

    // 3. 过滤到用户选中的 block（只加载用户选中的 TimelineBlock）
    const selectedBlockIdSet = new Set(selectedBlockIds);
    const selectedBlocks = allBlocks.filter((b) => selectedBlockIdSet.has(b.id));
    if (selectedBlocks.length === 0) {
      return {
        ok: false,
        errorCode: "insufficient_data",
        errorMessage: "未选中任何 TimelineBlock，无法生成工作日报。",
      };
    }

    // 4. 严格过滤不可报告或 privateRisk=high block（不传入 LLM）
    const safeBlocks = selectedBlocks.filter(
      (b) => b.reportable !== false && b.privateRisk !== "high"
    );
    const omittedBlockCount = selectedBlocks.length - safeBlocks.length;
    if (safeBlocks.length === 0) {
      return {
        ok: false,
        errorCode: "all_blocked_for_privacy",
        errorMessage:
          "选中的所有 TimelineBlock 均不可报告或为高隐私风险，已全部过滤，无法生成工作日报。",
      };
    }

    // 5. 收集选中 block 关联的 sourceFactIds
    const selectedFactIdSet = new Set<string>();
    for (const block of safeBlocks) {
      for (const fid of block.sourceFactIds ?? []) {
        selectedFactIdSet.add(fid);
      }
    }

    // 6. 批量加载 Facts（仅未删除，使用 listByIds 高效查询）
    const allSelectedFacts = this.fetchFactsByIds(Array.from(selectedFactIdSet));

    // 7. 防御性过滤 reportable=false / privateRisk=high 的 facts
    //    注意：持久化 Fact 类型暂无 reportable/privateRisk 字段（仅 ExtractorFactV2 LLM 输出有），
    //    此过滤为前瞻性兜底；当前持久化 Facts 会全部通过。
    const reportableFacts = allSelectedFacts.filter((f) => {
      const reportable = (f as Fact & { reportable?: boolean }).reportable;
      const privateRisk =
        (f as Fact & { privateRisk?: "low" | "medium" | "high" }).privateRisk ?? "low";
      return reportable !== false && privateRisk !== "high";
    });

    // 8. 构造 WorkReportInput
    const reportRequirements = resolveReportGenerationRequirements(
      this.settingsService,
      "work",
      generationRequirement
    );
    const workReportInput: WorkReportInput = {
      dateKey,
      selectedTimelineBlocks: safeBlocks,
      selectedFacts: reportableFacts,
      style,
      ...(recipientHint ? { recipientHint } : {}),
      reportRequirements,
    };
    const inputJson = JSON.stringify(workReportInput, null, 2);

    // 9. 填充 prompt
    const userPrompt = WORK_REPORT_PROMPT_TEMPLATE.replace(
      "{{work_report_input_json}}",
      inputJson
    );

    // 10. 构造脱敏 jobInputJson（不含完整 fact 内容，避免存储大量数据）
    const jobInputJson = JSON.stringify({
      dateKey,
      style,
      recipientHint,
      selectedBlockCount: selectedBlocks.length,
      safeBlockCount: safeBlocks.length,
      omittedBlockCount,
      factCount: reportableFacts.length,
      hasReportRequirements: hasReportGenerationRequirements(reportRequirements),
      hasTemporaryRequirement: Boolean(reportRequirements.temporary),
    });

    // 11. 提交 LLM 任务
    //     超时 120,000ms 由 ModelGateway.DEFAULT_TIMEOUT_MS 保证
    //     队列类型使用 "reporter"（enqueueMultimodalJob 限定的枚举值）
    const result = await this.modelJobQueue.enqueueMultimodalJob<WorkReportOutput>({
      type: "reporter",
      rateLimitKey: multimodalModelConfigId,
      executor: async () => {
        return this.modelGateway.callByConfigId<WorkReportOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "reporter",
            jobInputJson,
          },
          WorkReportOutputSchema
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

    const parsed = result.data;

    // 12. 计算已排除的 block ids（用户未选中的，用于 report_selections 记录）
    const excludedBlockIds = allBlocks
      .filter((b) => !selectedBlockIdSet.has(b.id))
      .map((b) => b.id);

    const allowedBlockIds = new Set(safeBlocks.map((block) => block.id));
    const allowedFactIds = new Set(reportableFacts.map((fact) => fact.id));
    const usedBlockIds = Array.from(
      new Set(parsed.sourceTimelineBlockIds.filter((id) => allowedBlockIds.has(id)))
    );
    const usedFactIds = Array.from(
      new Set(parsed.sourceFactIds.filter((id) => allowedFactIds.has(id)))
    );

    // 13. 构造持久化的 WorkReport 实体
    const now = new Date().toISOString();
    const workReportId = `wr_${dateKey}_${Date.now().toString(36)}`;

    const highPrivacyBlockCount = selectedBlocks.filter((block) => block.privateRisk === "high").length;
    // 仅将高隐私 block 计入隐私省略数；reportable=false 仍会在模型调用前排除。
    const totalOmittedForPrivacy = parsed.omittedForPrivacy + highPrivacyBlockCount;
    const warnings = [...parsed.warnings];
    if (omittedBlockCount > 0) {
      warnings.push(`已省略 ${omittedBlockCount} 个不可报告或高隐私风险时间段。`);
    }

    const report: WorkReport = {
      id: workReportId,
      dateKey,
      title: parsed.title || `${dateKey} 工作日报`,
      plainText: parsed.plainText,
      sections: parsed.sections,
      sourceTimelineBlockIds: usedBlockIds,
      sourceFactIds: usedFactIds,
      omittedForPrivacy: totalOmittedForPrivacy,
      warnings,
      createdAt: now,
      updatedAt: now,
    };

    // contentJson 包含完整 WorkReport + 额外元数据（type/style/recipientHint）
    // 便于后续读取时恢复完整上下文
    const contentJson = JSON.stringify({
      ...report,
      type: "work_daily_report",
      style,
      recipientHint: recipientHint ?? null,
      reportRequirements,
    });

    // 14. 持久化到 reports 表（type=work_daily_report）
    //     sourceSceneIds 列复用为 sourceTimelineBlockIds（reports 表未单独建列）
    const reportRecord = this.reportRepo.upsertWorkReport(dateKey, {
      title: report.title,
      contentJson,
      sourceFactIds: report.sourceFactIds,
      sourceTimelineBlockIds: report.sourceTimelineBlockIds,
    });
    this.onReportGenerated?.(reportRecord);
    void this.infographicService?.generateForReport(reportRecord, reportRequirements);

    // 15. 写入 report_selections 表记录 selected/excluded ids
    this.reportSelectionRepo.upsert(
      dateKey,
      "work_daily_report",
      selectedBlockIds,
      excludedBlockIds
    );

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
   * 查询当日所有 TimelineBlock
   */
  private fetchTimelineBlocks(dateKey: string): TimelineBlock[] {
    try {
      return this.timelineBlockRepo.findByDateKey(dateKey);
    } catch {
      return [];
    }
  }

  /**
   * 批量加载 Facts（仅未删除）
   * 使用 listByIds 高效查询，避免全量加载后过滤。
   */
  private fetchFactsByIds(ids: string[]): Fact[] {
    if (ids.length === 0) return [];
    try {
      return this.factRepo.listByIds(ids);
    } catch {
      return [];
    }
  }

}
