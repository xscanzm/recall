// src/main/models/schemas.ts
// 模型输出 / IPC 参数 zod schema 校验
// M0 仅建立基础结构，M1+ 后续填充完整 schema

import { z } from "zod";

/**
 * AppStatus schema（与 shared/types.ts 的 AppStatus 一致）
 */
export const AppStatusSchema = z.object({
  observing: z.boolean(),
  paused: z.boolean(),
  currentWindow: z
    .object({
      appName: z.string(),
      windowTitle: z.string(),
      privacyState: z.enum(["allowed", "blocked", "sensitive", "unknown"]),
    })
    .optional(),
  pipelineState: z.enum([
    "idle",
    "capturing",
    "observing",
    "extracting",
    "linking",
    "judging",
    "reporting",
    "error",
  ]),
  lastError: z.string().optional(),
});

/**
 * Confidence / Importance / Priority 通用约束：[0, 1]
 * 来自 05_PROMPTS_AND_JSON_SCHEMAS.md
 */
export const ConfidenceSchema = z.number().min(0).max(1);
export const ImportanceSchema = z.number().min(0).max(1);
export const PrioritySchema = z.number().min(0).max(1);

/**
 * 文本长度限制（来自 05 文档）
 */
export const TEXT_LIMITS = {
  title: 120,
  summary: 1000,
  factContent: 500,
  evidenceText: 500,
  reason: 500,
  reportOverview: 2000,
} as const;

export const TitleSchema = z.string().max(TEXT_LIMITS.title);
export const SummarySchema = z.string().max(TEXT_LIMITS.summary);
export const FactContentSchema = z.string().max(TEXT_LIMITS.factContent);
export const EvidenceTextSchema = z.string().max(TEXT_LIMITS.evidenceText);
export const ReasonSchema = z.string().max(TEXT_LIMITS.reason);

/**
 * ISO 8601 时间归一化辅助：把任何 ISO 字符串统一成 UTC Z 后缀
 *
 * 处理：
 * - "2026-07-07T08:30:00.000Z" → 原样
 * - "2026-07-07T16:30:00.000+08:00" → "2026-07-07T08:30:00.000Z"
 * - "2026-07-07T08:30:00.000"（无时区） → 当作系统本地时间，转 UTC
 * - 解析失败时原样返回（让后续 zod 校验捕获）
 *
 * 修复：LLM 输出可能无时区 / 带 Z / 带 offset 三种格式混用，导致渲染端错位
 */
export function normalizeIsoToZ(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return value;
    return d.toISOString();
  } catch {
    return value;
  }
}

/**
 * 强约束的 ISO 8601 datetime schema（必须带时区：Z 或 ±HH:MM）
 * - 修复：之前用 z.string() 放过无时区字符串，渲染端 new Date() 解析为本地时间，导致错位
 * - 配合 z.preprocess(normalizeIsoToZ, ...) 容忍 LLM 输出混合格式
 */
export const IsoDateTimeWithOffsetSchema = z.preprocess(
  normalizeIsoToZ,
  z
    .string()
    .refine(
      (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.test(v),
      {
        message: "ISO 8601 datetime must include timezone (Z or ±HH:MM)",
      }
    )
);

/**
 * PrivacyRule schema（用于 privacy:addRule / privacy:updateRule IPC 参数校验）
 */
export const PrivacyRuleInputSchema = z.object({
  type: z.enum(["app_name", "window_title_keyword", "domain_keyword"]),
  pattern: z.string().min(1).max(500),
  action: z.enum(["exclude", "ask_before_capture", "blur_sensitive"]),
  enabled: z.boolean().default(true),
});

export const PrivacyRuleIdSchema = z.object({
  id: z.string().min(1),
});

/** 设置更新 IPC 参数 schema。每个分区按 SettingsService 的浅合并语义整体替换。 */
const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须为 HH:mm");

export const ReportRequirementSchema = z.object({
  focus: z.string().max(2000),
  presentation: z.string().max(2000),
  reminders: z.string().max(2000),
}).strict();

export const ReportRequirementsSchema = z.object({
  personal: ReportRequirementSchema,
  work: ReportRequirementSchema,
  weekly: ReportRequirementSchema,
  monthly: ReportRequirementSchema,
}).strict();

export const SettingsUpdateSchema = z.object({
  observation: z.object({
    enabled: z.boolean(),
    activeWindowStableSeconds: z.number().nonnegative(),
    contentChangeMinIntervalSeconds: z.number().nonnegative(),
    longSessionIntervalMinutes: z.number().nonnegative(),
    idleThresholdSeconds: z.number().nonnegative(),
  }).optional(),
  screenshot: z.object({
    retentionPolicy: z.enum(["delete_immediately", "1h", "6h", "today", "3d", "7d"]),
  }).optional(),
  notification: z.object({
    inAppReminders: z.boolean(),
    desktopNotifications: z.boolean(),
    dailyReportTime: z.string(),
    weeklyReportTime: z.string(),
  }).optional(),
  endOfDayReview: z.object({
    enabled: z.boolean(),
    firstTime: TimeOfDaySchema,
    secondTime: TimeOfDaySchema,
  }).refine((value) => value.secondTime > value.firstTime, {
    message: "第二次通知时间必须晚于第一次",
    path: ["secondTime"],
  }).optional(),
  dailyReport: z.object({ autoGenerate: z.boolean(), time: z.string() }).optional(),
  personalReview: z.object({ autoGenerate: z.boolean(), time: z.string() }).optional(),
  reportRequirements: ReportRequirementsSchema.optional(),
  defaultModelService: z.object({
    consent: z.enum(["pending", "accepted", "declined"]),
    acceptedAt: z.string().datetime().nullable(),
  }).optional(),
  schedule: z.object({
    lastDailyReportDate: z.string().nullable(),
    lastWeeklyReportWeekStart: z.string().nullable(),
    lastPersonalReviewDate: z.string().nullable(),
  }).optional(),
  onboardingCompleted: z.boolean().optional(),
  debug: z.object({ enabled: z.boolean(), verboseModelIO: z.boolean() }).optional(),
}).strict();

/**
 * 模型配置测试 IPC 参数 schema
 */
export const ModelTestConnectionInputSchema = z.object({
  kind: z.enum(["vision", "language", "multimodal"]),
  endpoint: z.string().url(),
  model: z.string().min(1),
  // API Key 不进入 renderer/SQLite/日志：测试连接时通过临时字段传入 main 进程
  apiKey: z.string().min(1),
});

/**
 * M8 新增：模型配置保存 IPC 参数 schema
 * - id 可选：传入则更新现有配置，否则创建新配置
 * - apiKey 可选：传入则写入 SecretService，不传则保留已存 key
 *   保存后 apiKey 不返回 renderer
 */
export const ModelSaveConfigInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["vision", "language", "multimodal"]),
  providerName: z.string().min(1).max(120),
  endpoint: z.string().url(),
  model: z.string().min(1).max(120),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  // Phase 7：可选字段，留空时使用模型默认值（写入 options_json）
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
});

/**
 * M8 新增：模型配置删除 IPC 参数 schema
 * 删除模型配置时同时删除 SecretService 中的 API Key
 */
export const ModelDeleteConfigInputSchema = z.object({
  id: z.string().min(1),
});

/**
 * M8 新增：数据导出 IPC 参数 schema
 * - includeScreenshots：是否保留截图路径引用（默认 false）
 *   注意：JSON 导出不打包截图文件；true 仅保留 observation.screenshotPaths。
 */
export const DataExportInputSchema = z.object({
  includeScreenshots: z.boolean().optional(),
});

/**
 * 忘掉最近 IPC 参数 schema
 * duration:
 * - 15m / 30m / 1h：忘掉最近 N 分钟
 * - today：忘掉今天
 * - all：清空所有截图缓存（用于设置页"清空截图缓存"按钮）
 */
export const ForgetRecentInputSchema = z.object({
  duration: z.enum(["15m", "30m", "1h", "today", "all"]),
});

/**
 * 提醒状态更新 IPC 参数 schema
 */
export const ReminderUpdateStatusInputSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    "new",
    "confirmed",
    "ignored",
    "snoozed",
    "done",
    "do_not_remind_again",
  ]),
});

/**
 * 报告生成 IPC 参数 schema
 */
export const ReportGenerateInputSchema = z.object({
  type: z.enum(["daily", "weekly", "monthly", "retrospective"]),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectId: z.string().optional(),
  generationRequirement: z.string().trim().max(2000).optional(),
});

export const PersonalReviewGenerateInputSchema = z.object({
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  generationRequirement: z.string().trim().max(2000).optional(),
}).strict();

/**
 * 报告更新 IPC 参数 schema
 */
export const ReportUpdateInputSchema = z.object({
  id: z.string().min(1),
  contentJson: z.string(),
});

/**
 * 记忆搜索 IPC 参数 schema
 */
export const MemorySearchInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

/**
 * 记忆更新（Fact / Task）IPC 参数 schema
 */
export const MemoryUpdateFactInputSchema = z.object({
  id: z.string().min(1),
  content: z.string().max(TEXT_LIMITS.factContent).optional(),
  importance: ImportanceSchema.optional(),
  status: z
    .enum(["open", "in_progress", "likely_done", "done", "blocked", "unknown"])
    .optional(),
  tags: z.array(z.string()).optional(),
});

export const MemoryUpdateTaskInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(TEXT_LIMITS.title).optional(),
  status: z
    .enum([
      "open",
      "in_progress",
      "likely_done",
      "done",
      "blocked",
      "needs_confirmation",
    ])
    .optional(),
  projectId: z.string().nullable().optional(),
  summary: z.string().max(TEXT_LIMITS.summary).nullable().optional(),
});

export const MemoryUpdatePersonInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(TEXT_LIMITS.title).optional(),
  role: z.string().max(TEXT_LIMITS.title).nullable().optional(),
  organization: z.string().max(TEXT_LIMITS.title).nullable().optional(),
  relationship: z.string().max(TEXT_LIMITS.title).nullable().optional(),
  summary: z.string().max(TEXT_LIMITS.summary).nullable().optional(),
});

export const MemoryDeleteObjectInputSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["fact", "task", "scene", "project", "person", "decision"]),
});

/**
 * 用户纠错 IPC 参数 schema（来自 spec.md 02 文档 Flow 6）
 *
 * 纠错类型：
 * - 内容错了
 * - 不重要
 * - 项目归属错了
 * - 这个任务已完成
 * - 这不是任务
 * - 不要记这类内容
 * - 这是敏感内容，删除
 *
 * 系统处理：
 * - 保存 edit history
 * - 更新对应对象（soft delete 优先）
 * - 把纠错写入 user_feedback
 * - 后续 Judge 和 Linker 调用时带入用户反馈摘要
 */
export const UserFeedbackInputSchema = z.object({
  targetType: z.enum(["fact", "task", "scene", "project", "person", "decision", "reminder"]),
  targetId: z.string().min(1),
  feedbackType: z.enum([
    "content_wrong",
    "not_important",
    "wrong_project",
    "task_done",
    "not_a_task",
    "do_not_record",
    "sensitive_delete",
  ]),
  note: z.string().max(1000).optional(),
  /** 可选：更新对象字段（不覆盖 source ids） */
  patch: z.record(z.string(), z.unknown()).optional(),
});

/**
 * 轻量问答 IPC 参数 schema（来自 spec.md "历史查询与轻量问答" 章节）
 *
 * 第一版轻量问答：
 * - 输入自然语言
 * - main 进程：先用关键词检索相关 facts/scenes/reports
 * - 调用 ModelGateway.callLanguage，输入检索结果 + 问题
 * - LLM 回答必须列出来源对象 id
 * - 聊天只是查询入口，不作为主界面
 */
export const MemoryAskInputSchema = z.object({
  question: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(50).default(10),
});

/**
 * 轻量问答输出 schema
 * - answer：自然语言回答
 * - sources：来源对象列表（必须列出）
 */
export const MemoryAskOutputSchema = z.object({
  answer: z.string().max(2000),
  caveat: z.string().max(500).optional(),
  sourceIds: z.array(z.string()).optional(),
  sources: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["fact", "scene", "task", "project", "decision", "report", "person", "record"]),
      title: z.string(),
      summary: z.string().optional(),
    })
  ).optional(),
}).refine((value) => value.sourceIds !== undefined || value.sources !== undefined, {
  message: "sourceIds or sources is required",
});

export const MemorySearchExpansionOutputSchema = z.object({
  terms: z.array(z.string().min(1).max(80)).max(12),
  timeFrom: z.string().optional(),
  timeTo: z.string().optional(),
  type: z.enum(["fact", "scene", "task", "project", "decision", "report", "person", "record"]).optional(),
});

/**
 * 项目详情 IPC 参数 schema
 */
export const ProjectDetailInputSchema = z.object({
  id: z.string().min(1),
});

/**
 * 合并对象 IPC 参数 schema（基于 Linker mergeSuggestions）
 *
 * 当 Linker 输出 mergeSuggestions 时，写入 proactive_items 作为 needs_confirmation。
 * 用户在提醒页确认合并时，调用合并 API。
 */
export const MergeObjectsInputSchema = z.object({
  objectType: z.enum(["project", "task", "person", "decision"]),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

// ============================================================================
// 模型输出 schema（来自 05_PROMPTS_AND_JSON_SCHEMAS.md / spec.md M2）
// ============================================================================
// 每个模型调用完成后必须用对应 schema 做 zod 校验
// 校验失败最多调用一次 JSON repair，仍失败记录 model_job.status=failed
// ============================================================================

/**
 * L0 VisionObservationOutput：视觉观察模型输出
 *
 * 注意：导出的 schema 已用 z.preprocess 包装，会在校验前对模型输出做归一化：
 * - detectedEntities 分组结构（{type:"products", items:[...]}）→ 扁平结构（{name, type, evidence, confidence}）
 * - type 复数（products/concepts/companies/people）→ 单数（product/concept/company/person）
 * - possibleTasks/possibleDecisions/possibleProjectProgress 中 description/importance/priority/progress
 *   别名 → text/confidence/evidence 标准字段名
 *
 * 即使 prompt 已经明确告诉模型字段名，模型偶尔仍会返回旧字段名，preprocess 作为安全网兜底。
 */
const VisionObservationOutputCoreSchema = z.object({
  sceneSummary: SummarySchema,
  visibleContent: z.array(
    z.object({
      type: z.enum([
        "webpage",
        "document",
        "chat",
        "code",
        "spreadsheet",
        "design",
        "email",
        "terminal",
        "unknown",
      ]),
      summary: SummarySchema,
      fullText: z.string(),
      keyTextSnippets: z.array(z.string().max(TEXT_LIMITS.evidenceText)),
    })
  ),
  detectedEntities: z.array(
    z.object({
      name: TitleSchema,
      type: z.enum([
        "person",
        "product",
        "project",
        "company",
        "file",
        "url",
        "concept",
        "other",
      ]),
      evidence: EvidenceTextSchema,
      confidence: ConfidenceSchema,
    })
  ),
  possibleUserIntent: z.string().max(TEXT_LIMITS.factContent),
  possibleTasks: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  possibleDecisions: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  possibleProjectProgress: z.array(
    z.object({
      text: FactContentSchema,
      projectHint: TitleSchema.optional(),
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  sensitivity: z.enum(["normal", "possibly_sensitive", "high_sensitive"]),
  sensitivityReason: z.string().max(TEXT_LIMITS.reason).optional(),
  confidence: ConfidenceSchema,
  uncertainties: z.array(z.string().max(TEXT_LIMITS.factContent)),
});

/**
 * 复数 type → 单数 type 映射（用于 detectedEntities 归一化）
 *
 * 模型偶尔会返回复数形式（products/concepts/companies/people/files/urls），
 * 也可能出现首字母大写（Person/Product）或单数变体，统一映射到 schema 期望的枚举值。
 */
const ENTITY_TYPE_PLURAL_TO_SINGULAR: Record<string, string> = {
  // 复数 → 单数
  people: "person",
  persons: "person",
  products: "product",
  projects: "project",
  companies: "company",
  files: "file",
  urls: "url",
  concepts: "concept",
  others: "other",
  // 首字母大写 → 小写
  person: "person",
  product: "product",
  project: "project",
  company: "company",
  file: "file",
  url: "url",
  concept: "concept",
  other: "other",
  // 模型常见但 schema 未直接接收的实体类型
  model: "product",
  models: "product",
  service: "product",
  services: "product",
  platform: "product",
  platforms: "product",
  tool: "product",
  tools: "product",
  technology: "concept",
  technologies: "concept",
  framework: "concept",
  frameworks: "concept",
  library: "concept",
  libraries: "concept",
  website: "url",
  websites: "url",
  repo: "project",
  repository: "project",
  repositories: "project",
};

/**
 * 把模型返回的 detectedEntities 归一化为扁平结构
 *
 * 模型可能返回两种结构：
 * 1. 扁平（schema 期望）：[{name:"PowerShell", type:"product", evidence:"...", confidence:0.9}]
 * 2. 分组：[{type:"products", items:["PowerShell", "VSCode"]}]
 *
 * 本函数把分组结构展平为扁平结构，并归一化 type 枚举值。
 * 缺失的字段用默认值填充（confidence=0.5, evidence=""）。
 */
function normalizeDetectedEntities(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    // 分组结构：{type:"products", items:["x","y"]}
    if (Array.isArray(obj.items)) {
      const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : "other";
      const normalizedType = ENTITY_TYPE_PLURAL_TO_SINGULAR[rawType] ?? "other";
      for (const name of obj.items) {
        if (typeof name !== "string" || !name.trim()) continue;
        result.push({
          name: name.trim().slice(0, TEXT_LIMITS.title),
          type: normalizedType,
          evidence:
            typeof obj.evidence === "string"
              ? obj.evidence.slice(0, TEXT_LIMITS.evidenceText)
              : `来自分组 ${rawType}`,
          confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
        });
      }
      continue;
    }

    // 扁平结构：{name, type, evidence, confidence}
    const name =
      typeof obj.name === "string"
        ? obj.name
        : typeof obj.text === "string"
        ? obj.text
        : typeof obj.value === "string"
        ? obj.value
        : "";
    if (!name.trim()) continue;

    const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : "other";
    const normalizedType = ENTITY_TYPE_PLURAL_TO_SINGULAR[rawType] ?? "other";

    result.push({
      name: name.trim().slice(0, TEXT_LIMITS.title),
      type: normalizedType,
      evidence:
        typeof obj.evidence === "string"
          ? obj.evidence.slice(0, TEXT_LIMITS.evidenceText)
          : "",
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
    });
  }
  return result;
}

/**
 * 把 possibleTasks/possibleDecisions/possibleProjectProgress 元素归一化
 *
 * 模型可能返回的字段名变体：
 * - description / text / content / title → text
 * - importance / priority / progress / confidence → confidence
 * - evidence / reason / rationale → evidence
 *
 * 缺失字段用默认值填充（confidence=0.5, evidence=""）。
 */
function normalizeTaskLikeItems(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    // 字符串元素：模型偶尔会返回 ["task1", "task2"] 而非对象数组
    // 包装为 {text: string, confidence: 0.5, evidence: ""} 标准结构，避免数据丢失
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed) continue;
      result.push({
        text: trimmed.slice(0, TEXT_LIMITS.factContent),
        confidence: 0.5,
        evidence: "",
      });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    // text 别名：description / text / content / title
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.description === "string"
        ? obj.description
        : typeof obj.content === "string"
        ? obj.content
        : typeof obj.title === "string"
        ? obj.title
        : "";
    if (!text.trim()) continue;

    // confidence 别名：confidence / importance / priority / progress
    const confidence =
      typeof obj.confidence === "number"
        ? obj.confidence
        : typeof obj.importance === "number"
        ? obj.importance
        : typeof obj.priority === "number"
        ? obj.priority
        : typeof obj.progress === "number"
        ? obj.progress
        : 0.5;

    // evidence 别名：evidence / reason / rationale
    const evidence =
      typeof obj.evidence === "string"
        ? obj.evidence
        : typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.rationale === "string"
        ? obj.rationale
        : "";

    const normalized: Record<string, unknown> = {
      text: text.trim().slice(0, TEXT_LIMITS.factContent),
      confidence: Math.max(0, Math.min(1, confidence)),
      evidence: evidence.slice(0, TEXT_LIMITS.evidenceText),
    };

    // possibleProjectProgress 可选 projectHint
    if (typeof obj.projectHint === "string") {
      normalized.projectHint = obj.projectHint.slice(0, TEXT_LIMITS.title);
    } else if (typeof obj.project === "string") {
      normalized.projectHint = obj.project.slice(0, TEXT_LIMITS.title);
    }

    result.push(normalized);
  }
  return result;
}

/**
 * VisionObservationOutput 归一化函数
 *
 * 在 zod schema 校验前对模型输出做归一化转换，让 schema 能容忍模型字段名变体。
 * 不修改原始数据，返回新对象。
 */
function normalizeVisionObservationOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;

  // 仅在字段存在时归一化，避免引入新字段
  const result: Record<string, unknown> = { ...obj };

  if (obj.detectedEntities !== undefined) {
    result.detectedEntities = normalizeDetectedEntities(obj.detectedEntities);
  }
  if (obj.possibleTasks !== undefined) {
    result.possibleTasks = normalizeTaskLikeItems(obj.possibleTasks);
  }
  if (obj.possibleDecisions !== undefined) {
    result.possibleDecisions = normalizeTaskLikeItems(obj.possibleDecisions);
  }
  if (obj.possibleProjectProgress !== undefined) {
    result.possibleProjectProgress = normalizeTaskLikeItems(obj.possibleProjectProgress);
  }

  return result;
}

/**
 * 导出的 schema（已用 preprocess 包装，自动归一化模型输出）
 *
 * 使用方式不变：ModelGateway.callVision 时传入此 schema，
 * 校验前会自动调用 normalizeVisionObservationOutput 归一化模型输出。
 */
export const VisionObservationOutputSchema = z.preprocess(
  normalizeVisionObservationOutput,
  VisionObservationOutputCoreSchema
);

/**
 * L1 ExtractorOutput：事实提取模型输出
 *
 * 注意：导出的 schema 已用 z.preprocess 包装，会在校验前对模型输出做归一化：
 * - facts[].peopleHints/tags/sourceObservationIds 缺失 → 默认空数组 []
 * - facts[].inferred 缺失 → 默认 false
 * - facts[].status 枚举值变体（active/completed/pending/finished）→ 标准枚举值
 * - facts[].type 复数（tasks/decisions）→ 单数（task/decision）
 * - facts[].importance/confidence 字符串数值 → 数值
 * - discardedNoise 缺失 → 默认空数组 []
 *
 * 即使 prompt 已明确字段定义，模型偶尔仍会缺失字段，preprocess 作为安全网兜底。
 */
const ExtractorOutputCoreSchema = z.object({
  facts: z.array(
    z.object({
      type: z.enum([
        "task",
        "decision",
        "project_progress",
        "person",
        "preference",
        "knowledge",
        "risk",
        "question",
        "note",
      ]),
      content: FactContentSchema,
      status: z
        .enum(["open", "in_progress", "likely_done", "done", "blocked", "unknown"])
        .optional(),
      projectHint: TitleSchema.optional(),
      peopleHints: z.array(TitleSchema),
      importance: ImportanceSchema,
      confidence: ConfidenceSchema,
      inferred: z.boolean(),
      evidenceText: EvidenceTextSchema,
      sourceObservationIds: z.array(z.string()),
      tags: z.array(TitleSchema),
    })
  ),
  discardedNoise: z.array(
    z.object({
      reason: ReasonSchema,
      text: FactContentSchema,
    })
  ),
});

/**
 * fact type 复数 → 单数 / 首字母大写 → 小写 映射
 */
const FACT_TYPE_NORMALIZE: Record<string, string> = {
  tasks: "task",
  decisions: "decision",
  project_progresses: "project_progress",
  "project progress": "project_progress",
  projectprogress: "project_progress",
  persons: "person",
  people: "person",
  preferences: "preference",
  knowledges: "knowledge",
  risks: "risk",
  questions: "question",
  notes: "note",
  task: "task",
  decision: "decision",
  project_progress: "project_progress",
  person: "person",
  preference: "preference",
  knowledge: "knowledge",
  risk: "risk",
  question: "question",
  note: "note",
  entity: "note",
  event: "note",
  progress: "project_progress",
  project: "project_progress",
  reminder: "task",
  action: "task",
};

/**
 * status 枚举值变体 → 标准枚举值
 *
 * 模型经常返回 active/completed/pending/finished/in-progress 等，
 * 统一映射到 schema 期望的 open/in_progress/likely_done/done/blocked/unknown
 */
const FACT_STATUS_NORMALIZE: Record<string, string> = {
  open: "open",
  new: "open",
  pending: "open",
  todo: "open",
  "to-do": "open",
  in_progress: "in_progress",
  inprogress: "in_progress",
  "in-progress": "in_progress",
  active: "in_progress",
  ongoing: "in_progress",
  doing: "in_progress",
  started: "in_progress",
  likely_done: "likely_done",
  likelydone: "likely_done",
  "likely-done": "likely_done",
  almost_done: "likely_done",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  resolved: "done",
  closed: "done",
  blocked: "blocked",
  stuck: "blocked",
  paused: "blocked",
  unknown: "unknown",
  unclear: "unknown",
  dropped: "unknown",
  cancelled: "unknown",
  canceled: "unknown",
};

/**
 * 把 facts 数组元素归一化
 *
 * 处理：
 * - 缺失 peopleHints/tags/sourceObservationIds → 默认 []
 * - 缺失 inferred → 默认 false
 * - 缺失 importance/confidence → 默认 0.5
 * - 缺失 evidenceText → 默认 ""
 * - status 枚举值变体 → 标准值
 * - type 复数 → 单数
 * - importance/confidence 字符串数值 → 数值
 * - content 缺失 → 跳过该 fact（content 是核心字段，缺失则无意义）
 */
function normalizeFacts(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    // content 是核心字段，缺失则跳过
    const content =
      typeof obj.content === "string"
        ? obj.content
        : typeof obj.text === "string"
        ? obj.text
        : typeof obj.description === "string"
        ? obj.description
        : "";
    if (!content.trim()) continue;

    // type 归一化（复数 → 单数）
    const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : "note";
    const normalizedType = FACT_TYPE_NORMALIZE[rawType] ?? "note";

    // status 归一化
    let normalizedStatus: string | undefined;
    if (typeof obj.status === "string") {
      const rawStatus = obj.status.toLowerCase();
      normalizedStatus = FACT_STATUS_NORMALIZE[rawStatus];
    }

    // importance/confidence 归一化（字符串数值 → 数值）
    const importance = normalizeNumber(obj.importance, 0.5);
    const confidence = normalizeNumber(obj.confidence, 0.5);

    // inferred 归一化
    let inferred: boolean;
    if (typeof obj.inferred === "boolean") {
      inferred = obj.inferred;
    } else if (typeof obj.inferred === "string") {
      inferred = obj.inferred.toLowerCase() === "true" || obj.inferred.toLowerCase() === "1";
    } else {
      inferred = false; // 默认非推断
    }

    // 数组字段归一化
    const peopleHints = normalizeStringArray(obj.peopleHints);
    const sourceObservationIds = normalizeStringArray(obj.sourceObservationIds);
    const tags = normalizeStringArray(obj.tags);

    // evidenceText 归一化
    const evidenceText =
      typeof obj.evidenceText === "string"
        ? obj.evidenceText
        : typeof obj.evidence === "string"
        ? obj.evidence
        : typeof obj.reason === "string"
        ? obj.reason
        : "";

    const normalized: Record<string, unknown> = {
      type: normalizedType,
      content: content.slice(0, TEXT_LIMITS.factContent),
      importance: Math.max(0, Math.min(1, importance)),
      confidence: Math.max(0, Math.min(1, confidence)),
      inferred,
      evidenceText: evidenceText.slice(0, TEXT_LIMITS.evidenceText),
      peopleHints: peopleHints.map((s) => s.slice(0, TEXT_LIMITS.title)),
      sourceObservationIds,
      tags: tags.map((s) => s.slice(0, TEXT_LIMITS.title)),
    };

    if (normalizedStatus) {
      normalized.status = normalizedStatus;
    }
    if (typeof obj.projectHint === "string" && obj.projectHint.trim()) {
      normalized.projectHint = obj.projectHint.slice(0, TEXT_LIMITS.title);
    } else if (typeof obj.project === "string" && obj.project.trim()) {
      normalized.projectHint = obj.project.slice(0, TEXT_LIMITS.title);
    }

    result.push(normalized);
  }
  return result;
}

/**
 * 把 unknown 转为字符串数组
 * - 字符串 → [字符串]
 * - 数组 → 过滤非字符串
 * - 其他 → []
 */
function normalizeStringArray(raw: unknown): string[] {
  if (typeof raw === "string") {
    return raw.trim() ? [raw.trim()] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
  }
  return [];
}

/**
 * 把 unknown 转为数值
 * - 字符串数值 → 数值
 * - 数值 → 数值（限制范围）
 * - 其他 → 默认值
 */
function normalizeNumber(raw: unknown, defaultValue: number): number {
  if (typeof raw === "number" && !isNaN(raw)) return raw;
  if (typeof raw === "string") {
    const n = parseFloat(raw);
    if (!isNaN(n)) return n;
  }
  return defaultValue;
}

/**
 * 把 discardedNoise 数组元素归一化
 */
function normalizeDiscardedNoise(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.why === "string"
        ? obj.why
        : "无后续价值";
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.content === "string"
        ? obj.content
        : "";

    if (!text.trim()) continue;
    result.push({
      reason: reason.slice(0, TEXT_LIMITS.reason),
      text: text.slice(0, TEXT_LIMITS.factContent),
    });
  }
  return result;
}

/**
 * ExtractorOutput 归一化函数
 */
function normalizeExtractorOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = data as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  if (obj.facts !== undefined) {
    result.facts = normalizeFacts(obj.facts);
  }
  if (obj.discardedNoise !== undefined) {
    result.discardedNoise = normalizeDiscardedNoise(obj.discardedNoise);
  } else {
    result.discardedNoise = [];
  }

  return result;
}

/**
 * 导出的 schema（已用 preprocess 包装，自动归一化模型输出）
 */
export const ExtractorOutputSchema = z.preprocess(
  normalizeExtractorOutput,
  ExtractorOutputCoreSchema
);

/**
 * L2 LinkerOutput：记忆关联模型输出
 */
function normalizeLinkerLinks(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const targetType = pickFirst(obj, ["targetType", "objectType", "type"]);
    const targetId = pickFirst(obj, ["targetId", "id"]);
    const factIds = normalizeStringArray(
      pickFirst(obj, ["sourceFactIds", "factIds", "sourceFactId", "factId"])
    );
    if (typeof targetType !== "string" || typeof targetId !== "string" || factIds.length === 0) continue;

    const rawRelationship = pickFirst(obj, ["relationship", "relation"]);
    const relationship =
      typeof rawRelationship === "string" && rawRelationship.trim()
        ? rawRelationship
        : targetType === "project"
        ? "belongs_to"
        : "mentions";
    const reasonRaw = pickFirst(obj, ["reason", "rationale", "why"]);
    const reason = typeof reasonRaw === "string" ? reasonRaw : "模型建议关联";
    const confidence = normalizeNumber(pickFirst(obj, ["confidence", "score"]), 0.6);

    for (const sourceFactId of factIds) {
      result.push({
        sourceFactId,
        targetType,
        targetId,
        relationship,
        confidence: Math.max(0, Math.min(1, confidence)),
        reason: reason.slice(0, TEXT_LIMITS.reason),
      });
    }
  }
  return result;
}

function normalizeLinkerNewObjects(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const objectType = pickFirst(obj, ["objectType", "targetType", "type", "kind"]);
    const title = pickFirst(obj, ["title", "name", "displayName"]);
    const summaryRaw = pickFirst(obj, ["summary", "description", "reason", "rationale"]);
    const sourceFactIds = normalizeStringArray(
      pickFirst(obj, ["sourceFactIds", "factIds", "sourceFactId", "factId"])
    );
    if (typeof objectType !== "string" || typeof title !== "string" || !title.trim()) continue;
    if (sourceFactIds.length === 0) continue;

    const summary =
      typeof summaryRaw === "string" && summaryRaw.trim()
        ? summaryRaw.trim()
        : title.trim();
    const confidence = normalizeNumber(pickFirst(obj, ["confidence", "score"]), 0.6);

    // 仅 person 提取 role/organization
    const roleRaw = pickFirst(obj, ["role", "personRole", "title_role"]);
    const organizationRaw = pickFirst(obj, ["organization", "org", "company"]);
    const role = (typeof roleRaw === "string" && roleRaw.trim())
      ? roleRaw.trim().slice(0, TEXT_LIMITS.title) : null;
    const organization = (typeof organizationRaw === "string" && organizationRaw.trim())
      ? organizationRaw.trim().slice(0, TEXT_LIMITS.title) : null;

    result.push({
      objectType,
      title: title.trim().slice(0, TEXT_LIMITS.title),
      summary: summary.slice(0, TEXT_LIMITS.summary),
      sourceFactIds,
      confidence: Math.max(0, Math.min(1, confidence)),
      ...(objectType === "person" ? { role, organization } : {}),
    });
  }
  return result;
}

function normalizeLinkerMergeSuggestions(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const objectType = pickFirst(obj, ["objectType", "targetType", "type"]);
    const fromId = pickFirst(obj, ["fromId", "mergeId"]);
    const toId = pickFirst(obj, ["toId", "keepId"]);
    const reasonRaw = pickFirst(obj, ["reason", "rationale", "why"]);
    if (typeof objectType !== "string" || typeof fromId !== "string" || typeof toId !== "string") continue;

    const reason = typeof reasonRaw === "string" ? reasonRaw : "模型判断两个对象可能重复";
    const confidence = normalizeNumber(pickFirst(obj, ["confidence", "score"]), 0.6);
    result.push({
      objectType,
      fromId,
      toId,
      reason: reason.slice(0, TEXT_LIMITS.reason),
      confidence: Math.max(0, Math.min(1, confidence)),
    });
  }
  return result;
}

function normalizeLinkerOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  return {
    links: normalizeLinkerLinks(obj.links),
    newObjects: normalizeLinkerNewObjects(obj.newObjects),
    mergeSuggestions: normalizeLinkerMergeSuggestions(obj.mergeSuggestions),
  };
}

const LinkerOutputCoreSchema = z.object({
  links: z.array(
    z.object({
      sourceFactId: z.string(),
      targetType: z.enum([
        "project",
        "task",
        "person",
        "decision",
        "knowledge",
        "scene",
      ]),
      targetId: z.string(),
      relationship: z.enum([
        "belongs_to",
        "updates",
        "mentions",
        "depends_on",
        "duplicates",
        "continues",
        "contradicts",
      ]),
      confidence: ConfidenceSchema,
      reason: ReasonSchema,
    })
  ),
  newObjects: z.array(
    z.object({
      // 注意：MVP 阶段不支持 knowledge 对象创建（无对应存储表），LinkerWorker 会过滤掉该类型建议
      objectType: z.enum(["project", "task", "person", "decision", "knowledge"]),
      title: TitleSchema,
      summary: SummarySchema,
      sourceFactIds: z.array(z.string()),
      confidence: ConfidenceSchema,
      // 仅 objectType="person" 时有意义，其他类型会忽略
      role: z.string().max(TEXT_LIMITS.title).nullable().optional(),
      organization: z.string().max(TEXT_LIMITS.title).nullable().optional(),
    })
  ),
  mergeSuggestions: z.array(
    z.object({
      // 注意：MVP 阶段不支持 knowledge 对象创建（无对应存储表），LinkerWorker 会过滤掉该类型建议
      objectType: z.enum(["project", "task", "person", "decision", "knowledge"]),
      fromId: z.string(),
      toId: z.string(),
      reason: ReasonSchema,
      confidence: ConfidenceSchema,
    })
  ),
});

export const LinkerOutputSchema = z.preprocess(
  normalizeLinkerOutput,
  LinkerOutputCoreSchema
);

/**
 * L2 SceneBuilderOutput：场景聚合模型输出
 *
 * - startAt/endAt 强约束必须带时区（IsoDateTimeWithOffsetSchema）
 * - 修复：之前 z.string() 放过无时区字符串，渲染端 new Date() 解析为本地时间，导致错位
 *
 * 2026-07-07 修复：
 * - 新增 z.preprocess 包装（normalizeSceneBuilderOutput），处理字段名变体
 * - 之前无 preprocess 兜底，LLM 输出 project/fact_ids/entities 等变体时直接 schema_invalid
 * - 失败率 99%（541/2）。修复后对齐项目里其他 V2 schema 的设计约定
 */

/**
 * SceneBuilderOutput scenes 数组元素归一化
 *
 * 处理字段名变体：
 * - title / name
 * - summary / description
 * - startAt / start / startTime / beginAt
 * - endAt / end / endTime
 * - projectHint / project / projectName
 * - factIds / fact_ids / facts
 * - entityNames / entities / entity_names / names
 * - taskIds / task_ids / tasks
 * - decisionIds / decision_ids / decisions
 * - confidence / score
 *
 * 时间字段容错：缺失或非字符串时返回 ""，由 IsoDateTimeWithOffsetSchema 校验拒绝
 * （但不会污染整个数组——title 缺失才跳过该 scene）
 */
function normalizeSceneBuilderScenes(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;

    // title 是核心字段，缺失则跳过该 scene
    const title = typeof obj.title === "string" ? obj.title : typeof obj.name === "string" ? obj.name : "";
    if (!title.trim()) continue;

    const summary =
      typeof obj.summary === "string"
        ? obj.summary
        : typeof obj.description === "string"
        ? obj.description
        : "";

    // 时间字段：取字符串，否则空串（让 IsoDateTimeWithOffsetSchema 拒绝）
    const startAt =
      typeof obj.startAt === "string"
        ? obj.startAt
        : typeof obj.start === "string"
        ? obj.start
        : typeof obj.startTime === "string"
        ? obj.startTime
        : typeof obj.beginAt === "string"
        ? obj.beginAt
        : "";
    const endAt =
      typeof obj.endAt === "string"
        ? obj.endAt
        : typeof obj.end === "string"
        ? obj.end
        : typeof obj.endTime === "string"
        ? obj.endTime
        : "";

    // projectHint 可选
    const projectHintRaw = obj.projectHint ?? obj.project ?? obj.projectName;
    const projectHint = typeof projectHintRaw === "string" ? projectHintRaw : undefined;

    // 数组字段归一化
    const factIds = normalizeStringArray(obj.factIds ?? obj.facts);
    const entityNames = normalizeStringArray(obj.entityNames ?? obj.entities ?? obj.names);
    const taskIds = normalizeStringArray(obj.taskIds ?? obj.tasks);
    const decisionIds = normalizeStringArray(obj.decisionIds ?? obj.decisions);

    const confidence = normalizeNumber(obj.confidence ?? obj.score, 0.5);

    result.push({
      title: title.slice(0, TEXT_LIMITS.title),
      summary: summary.slice(0, TEXT_LIMITS.summary),
      startAt,
      endAt,
      ...(projectHint !== undefined ? { projectHint: projectHint.slice(0, TEXT_LIMITS.title) } : {}),
      factIds,
      entityNames,
      taskIds,
      decisionIds,
      confidence: Math.max(0, Math.min(1, confidence)),
    });
  }
  return result;
}

/**
 * SceneBuilderOutput 归一化函数
 */
function normalizeSceneBuilderOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };
  result.scenes = normalizeSceneBuilderScenes(obj.scenes);
  return result;
}

/**
 * SceneBuilderOutput CoreSchema（导出 preprocess 包装后的版本）
 */
const SceneBuilderOutputCoreSchema = z.object({
  scenes: z.array(
    z.object({
      title: TitleSchema,
      summary: SummarySchema,
      startAt: IsoDateTimeWithOffsetSchema,
      endAt: IsoDateTimeWithOffsetSchema,
      projectHint: TitleSchema.optional(),
      factIds: z.array(z.string()),
      entityNames: z.array(TitleSchema),
      taskIds: z.array(z.string()),
      decisionIds: z.array(z.string()),
      confidence: ConfidenceSchema,
    })
  ),
});

export const SceneBuilderOutputSchema = z.preprocess(
  normalizeSceneBuilderOutput,
  SceneBuilderOutputCoreSchema
);

/**
 * L3 JudgeOutput：主动性判断模型输出
 */
export const JudgeOutputSchema = z.object({
  proactiveItems: z.array(
    z.object({
      type: z.enum([
        "task_reminder",
        "unfinished_work",
        "decision_review",
        "project_update",
        "daily_summary_candidate",
        "tomorrow_suggestion",
        "risk_warning",
        "needs_confirmation",
      ]),
      title: TitleSchema,
      body: SummarySchema,
      reason: ReasonSchema,
      priority: PrioritySchema,
      surface: z.enum(["in_app", "daily_report", "desktop_notification_candidate"]),
      requiresUserConfirmation: z.boolean(),
      sourceFactIds: z.array(z.string()),
      sourceSceneIds: z.array(z.string()),
    })
  ),
  memoryUpdates: z.array(
    z.object({
      targetType: z.enum(["task", "project", "person", "preference", "decision"]),
      targetId: z.string(),
      updateType: z.enum([
        "status_change",
        "summary_refresh",
        "importance_change",
        "needs_review",
      ]),
      value: z.string().max(TEXT_LIMITS.factContent),
      reason: ReasonSchema,
      confidence: ConfidenceSchema,
    })
  ),
});

/**
 * 日报输出 schema（来自 05 文档）
 *
 * 2026-07-07 修复：
 * - 新增 z.preprocess 包装（normalizeDailyReportOutput），处理字段名变体和缺失数组兜底
 * - 之前无 preprocess 兜底，LLM 漏掉 evidenceFactIds 或用 snake_case 时整张失败（6/0 成功）
 * - 修复后对齐项目里其他 V2 schema 的设计约定
 */

/**
 * 日报 projectUpdates 元素归一化
 */
function normalizeReportProjectUpdates(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const projectName =
      typeof obj.projectName === "string"
        ? obj.projectName
        : typeof obj.project === "string"
        ? obj.project
        : "";
    if (!projectName.trim()) continue;
    const summary = typeof obj.summary === "string" ? obj.summary : typeof obj.description === "string" ? obj.description : "";
    const projectIdRaw = obj.projectId ?? obj.project_id;
    result.push({
      ...(typeof projectIdRaw === "string" ? { projectId: projectIdRaw } : {}),
      projectName: projectName.slice(0, TEXT_LIMITS.title),
      summary: summary.slice(0, TEXT_LIMITS.summary),
      evidenceFactIds: normalizeStringArray(obj.evidenceFactIds ?? obj.factIds ?? obj.facts),
      evidenceSceneIds: normalizeStringArray(obj.evidenceSceneIds ?? obj.sceneIds ?? obj.scenes),
    });
  }
  return result;
}

/**
 * 通用：归一化 "带 text/confidence/evidenceFactIds 的数组"
 * 用于 completed / decisions / risks
 */
function normalizeTextConfidenceEvidenceArray(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.content === "string"
        ? obj.content
        : typeof obj.description === "string"
        ? obj.description
        : "";
    if (!text.trim()) continue;
    result.push({
      text: text.slice(0, TEXT_LIMITS.factContent),
      confidence: Math.max(0, Math.min(1, normalizeNumber(obj.confidence ?? obj.score, 0.5))),
      evidenceFactIds: normalizeStringArray(obj.evidenceFactIds ?? obj.factIds ?? obj.facts),
    });
  }
  return result;
}

/**
 * 日报 openTasks 归一化
 */
function normalizeReportOpenTasks(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  const STATUS_NORMALIZE: Record<string, string> = {
    open: "open",
    in_progress: "in_progress",
    inprogress: "in_progress",
    "in-progress": "in_progress",
    blocked: "blocked",
    needs_confirmation: "needs_confirmation",
    needsconfirmation: "needs_confirmation",
    pending: "open",
    active: "in_progress",
  };
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.content === "string"
        ? obj.content
        : "";
    if (!text.trim()) continue;
    const rawStatus = typeof obj.status === "string" ? obj.status.toLowerCase() : "open";
    const status = STATUS_NORMALIZE[rawStatus] ?? "open";
    result.push({
      text: text.slice(0, TEXT_LIMITS.factContent),
      status,
      confidence: Math.max(0, Math.min(1, normalizeNumber(obj.confidence ?? obj.score, 0.5))),
      evidenceFactIds: normalizeStringArray(obj.evidenceFactIds ?? obj.factIds ?? obj.facts),
    });
  }
  return result;
}

/**
 * 日报 needsReview 归一化
 */
function normalizeReportNeedsReview(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const text =
      typeof obj.text === "string"
        ? obj.text
        : typeof obj.content === "string"
        ? obj.content
        : "";
    if (!text.trim()) continue;
    const reason = typeof obj.reason === "string" ? obj.reason : typeof obj.rationale === "string" ? obj.rationale : "";
    result.push({
      text: text.slice(0, TEXT_LIMITS.factContent),
      reason: reason.slice(0, TEXT_LIMITS.reason),
      sourceFactIds: normalizeStringArray(obj.sourceFactIds ?? obj.factIds ?? obj.facts),
    });
  }
  return result;
}

/**
 * DailyReportOutput 归一化函数
 */
function normalizeDailyReportOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // 顶层字符串字段兜底
  if (typeof obj.date !== "string") result.date = "";
  if (typeof obj.headline !== "string") result.headline = "";
  if (typeof obj.overview !== "string") result.overview = "";

  result.projectUpdates = normalizeReportProjectUpdates(obj.projectUpdates);
  result.completed = normalizeTextConfidenceEvidenceArray(obj.completed);
  result.openTasks = normalizeReportOpenTasks(obj.openTasks);
  result.decisions = normalizeTextConfidenceEvidenceArray(obj.decisions);
  result.risks = normalizeTextConfidenceEvidenceArray(obj.risks);
  result.tomorrowSuggestions = normalizeStringArray(obj.tomorrowSuggestions ?? obj.suggestions);
  result.needsReview = normalizeReportNeedsReview(obj.needsReview);

  return result;
}

/**
 * DailyReportOutput CoreSchema
 *
 * 注意：所有数组字段在 normalize 阶段已保证为数组，这里用 .default([]) 作为第二道防线
 */
const DailyReportOutputCoreSchema = z.object({
  date: z.string(),
  headline: z.string().max(200),
  overview: z.string().max(TEXT_LIMITS.reportOverview),
  projectUpdates: z.array(
    z.object({
      projectId: z.string().optional(),
      projectName: TitleSchema,
      summary: SummarySchema,
      evidenceFactIds: z.array(z.string()),
      evidenceSceneIds: z.array(z.string()),
    })
  ),
  completed: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  openTasks: z.array(
    z.object({
      text: FactContentSchema,
      status: z.enum(["open", "in_progress", "blocked", "needs_confirmation"]),
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  decisions: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  risks: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  tomorrowSuggestions: z.array(z.string().max(TEXT_LIMITS.factContent)),
  needsReview: z.array(
    z.object({
      text: FactContentSchema,
      reason: ReasonSchema,
      sourceFactIds: z.array(z.string()),
    })
  ),
});

export const DailyReportOutputSchema = z.preprocess(
  normalizeDailyReportOutput,
  DailyReportOutputCoreSchema
);

/**
 * WeeklyReport 归一化函数
 *
 * 周报与日报结构类似，多 weekStart/weekEnd/progress 字段，少 openTasks/needsReview/tomorrowSuggestions
 */
function normalizeWeeklyReportOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // 顶层字符串字段兜底
  if (typeof obj.weekStart !== "string") result.weekStart = "";
  if (typeof obj.weekEnd !== "string") result.weekEnd = "";
  if (typeof obj.headline !== "string") result.headline = "";
  if (typeof obj.overview !== "string") result.overview = "";

  // projectUpdates（周报多 progress 字段）
  const projectUpdatesRaw = obj.projectUpdates;
  result.projectUpdates = Array.isArray(projectUpdatesRaw)
    ? projectUpdatesRaw.map((item) => {
        if (!item || typeof item !== "object") return null;
        const o = normalizeKeysToCamel(item) as Record<string, unknown>;
        const projectName =
          typeof o.projectName === "string" ? o.projectName : typeof o.project === "string" ? o.project : "";
        const summary = typeof o.summary === "string" ? o.summary : "";
        const progress = typeof o.progress === "string" ? o.progress : typeof o.status === "string" ? o.status : "";
        const projectIdRaw = o.projectId ?? o.project_id;
        return {
          ...(typeof projectIdRaw === "string" ? { projectId: projectIdRaw } : {}),
          projectName: projectName.slice(0, TEXT_LIMITS.title),
          summary: summary.slice(0, TEXT_LIMITS.summary),
          progress: progress.slice(0, TEXT_LIMITS.summary),
          evidenceFactIds: normalizeStringArray(o.evidenceFactIds ?? o.factIds ?? o.facts),
          evidenceSceneIds: normalizeStringArray(o.evidenceSceneIds ?? o.sceneIds ?? o.scenes),
        };
      }).filter((x) => {
        if (x === null || typeof x !== "object") return false;
        const pn = (x as Record<string, unknown>).projectName;
        return typeof pn === "string" && pn.trim() !== "";
      })
    : [];

  result.completed = normalizeTextConfidenceEvidenceArray(obj.completed);
  result.decisions = normalizeTextConfidenceEvidenceArray(obj.decisions);
  result.risks = normalizeTextConfidenceEvidenceArray(obj.risks);
  result.nextWeekSuggestions = normalizeStringArray(obj.nextWeekSuggestions ?? obj.suggestions);

  return result;
}

/**
 * 周报输出 schema（来自 02 文档 Flow 8）
 *
 * 周报输出字段：
 * - weekStart / weekEnd：本周起止日期
 * - headline：本周标题
 * - overview：本周概览
 * - projectUpdates：按项目分组的进展（包含 progress 字段表达本周推进状态）
 * - completed：本周完成事项
 * - decisions：本周关键决策
 * - risks：本周风险和阻塞
 * - nextWeekSuggestions：下周建议
 *
 * 重要约束（与日报一致）：
 * - 重要条目必须保留 evidenceFactIds 或 evidenceSceneIds
 * - 不直接根据截图编写报告，必须基于 facts/scenes/reports
 * - 低置信内容应放入 risks 并降低 confidence
 */
const WeeklyReportOutputCoreSchema = z.object({
  weekStart: z.string(),
  weekEnd: z.string(),
  headline: z.string().max(200),
  overview: z.string().max(TEXT_LIMITS.reportOverview),
  projectUpdates: z.array(
    z.object({
      projectId: z.string().optional(),
      projectName: TitleSchema,
      summary: SummarySchema,
      progress: z.string().max(TEXT_LIMITS.summary),
      evidenceFactIds: z.array(z.string()),
      evidenceSceneIds: z.array(z.string()),
    })
  ),
  completed: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  decisions: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  risks: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidenceFactIds: z.array(z.string()),
    })
  ),
  nextWeekSuggestions: z.array(z.string().max(TEXT_LIMITS.factContent)),
});

export const WeeklyReportOutputSchema = z.preprocess(
  normalizeWeeklyReportOutput,
  WeeklyReportOutputCoreSchema
);

/**
 * 月报输出归一化函数。
 *
 * 月报沿用周报的项目/成果/决策/风险结构，但周期字段和下一阶段建议必须
 * 使用月报语义。对模型偶尔返回的 weekStart/weekEnd/nextWeekSuggestions 做
 * 兼容映射，最终只允许月报字段进入 schema。
 */
function normalizeMonthlyReportOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const monthStart =
    typeof obj.monthStart === "string"
      ? obj.monthStart
      : typeof obj.weekStart === "string"
      ? obj.weekStart
      : "";
  const monthEnd =
    typeof obj.monthEnd === "string"
      ? obj.monthEnd
      : typeof obj.weekEnd === "string"
      ? obj.weekEnd
      : "";
  const nextMonthSuggestions = normalizeStringArray(
    obj.nextMonthSuggestions ?? obj.nextWeekSuggestions ?? obj.suggestions
  );

  const normalized = normalizeWeeklyReportOutput({
    ...obj,
    weekStart: monthStart,
    weekEnd: monthEnd,
    nextWeekSuggestions: nextMonthSuggestions,
  });
  if (!normalized || typeof normalized !== "object") return normalized;

  const result = { ...(normalized as Record<string, unknown>) };
  delete result.weekStart;
  delete result.weekEnd;
  delete result.nextWeekSuggestions;
  result.monthStart = monthStart;
  result.monthEnd = monthEnd;
  result.nextMonthSuggestions = nextMonthSuggestions;
  return result;
}

/**
 * 月报输出 schema。
 *
 * 内容板块与周报保持一致，周期和下一阶段字段明确使用月报语义，避免模型
 * 继续沿用“本周 / 下周”的输出契约。
 */
const MonthlyReportOutputCoreSchema = WeeklyReportOutputCoreSchema
  .omit({
    weekStart: true,
    weekEnd: true,
    nextWeekSuggestions: true,
  })
  .extend({
    monthStart: z.string(),
    monthEnd: z.string(),
    nextMonthSuggestions: z.array(z.string().max(TEXT_LIMITS.factContent)),
  });

export const MonthlyReportOutputSchema = z.preprocess(
  normalizeMonthlyReportOutput,
  MonthlyReportOutputCoreSchema
);

// ============================================================================
// Phase 2 新增 Schema（doc 19 / doc 20 / spec.md Phase 2）
// ============================================================================
// 体验升级引入 6 个新模型输出 schema：
// - ObserverOutputV2Schema（视觉观察 V2，新增体验字段）
// - ExtractorOutputV2Schema（事实提取 V2，新增 displayUse/reportable/privateRisk/userValue）
// - TimelineBuilderOutputSchema（今日时间轴）
// - PersonalReviewOutputSchema（自用复盘）
// - WorkReportOutputSchema（工作日报）
// - JudgeOutputV2Schema（待收尾判断 V2，新增 unfinishedThreads）
//
// 所有 schema 都用 z.preprocess 包装，处理模型字段名变体（snake_case / 复数 / 缺失 / 枚举变体）。
// 即使 prompt 已明确字段定义，模型偶尔仍会返回变体，preprocess 作为安全网兜底。
// ============================================================================

/**
 * Phase 2 reportableSignal 枚举变体归一化
 *
 * 模型可能返回：yes / maybe / no / true / false / work / personal / break / ambiguous
 * spec 期望：yes / maybe / no
 */
const REPORTABLE_SIGNAL_NORMALIZE: Record<string, string> = {
  yes: "yes",
  y: "yes",
  true: "yes",
  work: "yes",
  work_related: "yes",
  workrelated: "yes",
  "work-related": "yes",
  maybe: "maybe",
  uncertain: "maybe",
  unclear: "maybe",
  ambiguous: "maybe",
  personal: "maybe",
  break: "no",
  no: "no",
  n: "no",
  false: "no",
  private: "no",
  irrelevant: "no",
};

/**
 * Phase 2 privacyRisk 枚举变体归一化
 *
 * 模型可能返回：low / medium / high / normal / sensitive / private / public
 * spec 期望：low / medium / high
 */
const PRIVACY_RISK_NORMALIZE: Record<string, string> = {
  low: "low",
  normal: "low",
  public: "low",
  medium: "medium",
  moderate: "medium",
  high: "high",
  sensitive: "high",
  private: "high",
  critical: "high",
};

/**
 * Phase 2 userValue 枚举变体归一化
 *
 * 模型可能返回：low / medium / high / 无价值 / 一般 / 重要
 * spec 期望：low / medium / high
 */
const USER_VALUE_NORMALIZE: Record<string, string> = {
  low: "low",
  none: "low",
  minimal: "low",
  medium: "medium",
  normal: "medium",
  moderate: "medium",
  high: "high",
  important: "high",
  critical: "high",
};

/**
 * Phase 2 sensitivity 枚举变体归一化
 *
 * 模型可能返回：normal / possibly_sensitive / high_sensitive / sensitive / private
 * spec 期望：normal / possibly_sensitive / high_sensitive
 */
const SENSITIVITY_NORMALIZE: Record<string, string> = {
  normal: "normal",
  public: "normal",
  possibly_sensitive: "possibly_sensitive",
  possiblysensitive: "possibly_sensitive",
  "possibly-sensitive": "possibly_sensitive",
  medium: "possibly_sensitive",
  high_sensitive: "high_sensitive",
  highsensitive: "high_sensitive",
  "high-sensitive": "high_sensitive",
  sensitive: "high_sensitive",
  high: "high_sensitive",
  private: "high_sensitive",
};

/**
 * Phase 2 TimelineBlock category 枚举变体归一化
 *
 * 模型可能返回：focus_work / communication / research / writing / coding /
 * design / meeting / admin / break / mixed / unknown / 其他变体
 */
const TIMELINE_BLOCK_CATEGORY_NORMALIZE: Record<string, string> = {
  focus_work: "focus_work",
  focuswork: "focus_work",
  "focus-work": "focus_work",
  focus: "focus_work",
  work: "focus_work",
  communication: "communication",
  communications: "communication",
  chat: "communication",
  messaging: "communication",
  research: "research",
  researching: "research",
  writing: "writing",
  document: "writing",
  coding: "coding",
  code: "coding",
  programming: "coding",
  development: "coding",
  design: "design",
  designing: "design",
  meeting: "meeting",
  meetings: "meeting",
  admin: "admin",
  administrative: "admin",
  break: "break",
  breaks: "break",
  rest: "break",
  idle: "break",
  mixed: "mixed",
  unknown: "unknown",
  other: "unknown",
};

/**
 * Phase 2 fact displayUse 枚举归一化
 *
 * 模型可能返回：timeline / personal_review / work_report / memory / task_list
 * 或：personal / review / work / report / long_term / task
 */
const DISPLAY_USE_NORMALIZE: Record<string, string> = {
  timeline: "timeline",
  personal_review: "personal_review",
  personalreview: "personal_review",
  "personal-review": "personal_review",
  personal: "personal_review",
  review: "personal_review",
  work_report: "work_report",
  workreport: "work_report",
  "work-report": "work_report",
  work: "work_report",
  report: "work_report",
  memory: "memory",
  long_term: "memory",
  longterm: "memory",
  task_list: "task_list",
  tasklist: "task_list",
  "task-list": "task_list",
  task: "task_list",
};

/**
 * Phase 2 unfinishedThread priority 枚举归一化
 *
 * 模型可能返回：high / medium / low / 0/1/2 / 重要/一般/低
 */
const THREAD_PRIORITY_NORMALIZE: Record<string, string> = {
  high: "high",
  h: "high",
  important: "high",
  critical: "high",
  urgent: "high",
  "2": "high",
  medium: "medium",
  m: "medium",
  normal: "medium",
  moderate: "medium",
  "1": "medium",
  low: "low",
  l: "low",
  minor: "low",
  "0": "low",
};

/**
 * Phase 2 proactiveItem surface 枚举归一化
 */
const PROACTIVE_SURFACE_NORMALIZE: Record<string, string> = {
  in_app: "in_app",
  inapp: "in_app",
  "in-app": "in_app",
  app: "in_app",
  daily_report: "daily_report",
  dailyreport: "daily_report",
  "daily-report": "daily_report",
  report: "daily_report",
  desktop_notification_candidate: "desktop_notification_candidate",
  desktopnotificationcandidate: "desktop_notification_candidate",
  notification: "desktop_notification_candidate",
  desktop_notification: "desktop_notification_candidate",
};

/**
 * Phase 2 proactiveItem type 枚举归一化
 */
const PROACTIVE_TYPE_V2_NORMALIZE: Record<string, string> = {
  task_reminder: "task_reminder",
  taskreminder: "task_reminder",
  "task-reminder": "task_reminder",
  reminder: "task_reminder",
  risk_warning: "risk_warning",
  riskwarning: "risk_warning",
  "risk-warning": "risk_warning",
  risk: "risk_warning",
  warning: "risk_warning",
  decision_review: "decision_review",
  decisionreview: "decision_review",
  "decision-review": "decision_review",
  tomorrow_suggestion: "tomorrow_suggestion",
  tomorrowsuggestion: "tomorrow_suggestion",
  "tomorrow-suggestion": "tomorrow_suggestion",
  suggestion: "tomorrow_suggestion",
  needs_confirmation: "needs_confirmation",
  needsconfirmation: "needs_confirmation",
  "needs-confirmation": "needs_confirmation",
  confirm: "needs_confirmation",
};

/**
 * 通用：把 snake_case 字符串转为 camelCase
 * 仅用于字段名归一化，不处理嵌套对象。
 */
function snakeToCamel(s: string): string {
  if (!s.includes("_") && !s.includes("-")) return s;
  return s.replace(/[-_]([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * 通用：把对象的所有 key 从 snake_case 转为 camelCase（递归一层，不深递归）
 *
 * 用于 LLM 输出归一化：模型偶尔返回 snake_case 字段名（private_risk 而非 privateRisk），
 * 此函数统一转为 camelCase，避免 schema 校验失败。
 *
 * 注意：仅转 key，不修改 value。嵌套对象/数组内的 key 不处理（由各 normalize 函数单独处理）。
 */
function normalizeKeysToCamel(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return obj as Record<string, unknown>;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[snakeToCamel(k)] = v;
  }
  return result;
}

/**
 * 通用：从对象中按优先级取字段值
 *
 * 用于处理字段名变体：例如 privateRisk / private_risk / privacyRisk / privacy_risk 都映射到 privateRisk。
 */
function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined) return obj[k];
  }
  return undefined;
}

/**
 * ObserverOutputV2 归一化函数
 *
 * 处理：
 * - snake_case → camelCase（scene_summary → sceneSummary 等）
 * - 复用 normalizeDetectedEntities / normalizeTaskLikeItems 处理嵌套数组
 * - reportableSignal / privacyRisk / sensitivity 枚举变体归一化
 * - 缺失数组字段默认 []
 */
function normalizeObserverOutputV2(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // 嵌套数组归一化（复用 V1 逻辑）
  if (obj.detectedEntities !== undefined) {
    result.detectedEntities = normalizeDetectedEntities(obj.detectedEntities);
  }
  if (obj.possibleTasks !== undefined) {
    result.possibleTasks = normalizeTaskLikeItems(obj.possibleTasks);
  }
  if (obj.possibleDecisions !== undefined) {
    result.possibleDecisions = normalizeTaskLikeItems(obj.possibleDecisions);
  }
  if (obj.possibleProjectProgress !== undefined) {
    result.possibleProjectProgress = normalizeTaskLikeItems(obj.possibleProjectProgress);
  } else {
    result.possibleProjectProgress = [];
  }
  if (obj.visibleContent !== undefined) {
    result.visibleContent = Array.isArray(obj.visibleContent)
      ? (obj.visibleContent as unknown[]).map((item) => {
          if (!item || typeof item !== "object") return item;
          const content = normalizeKeysToCamel(item);
          const rawType = typeof content.type === "string" ? content.type.toLowerCase() : "unknown";
          const type =
            rawType === "image" || rawType === "screenshot" || rawType === "photo"
              ? "unknown"
              : rawType === "system_dialog" || rawType === "dialog" || rawType === "other"
              ? "unknown"
              : rawType;
          return {
            ...content,
            type: [
              "webpage",
              "document",
              "chat",
              "code",
              "spreadsheet",
              "design",
              "email",
              "terminal",
              "unknown",
            ].includes(type)
              ? type
              : "unknown",
            keyTextSnippets: normalizeStringArray(content.keyTextSnippets),
          };
        })
      : [];
  } else {
    result.visibleContent = [];
  }

  // 字段名变体归一化
  const sceneSummary = pickFirst(obj, ["sceneSummary", "scene_summary", "sceneTitle"]);
  if (typeof sceneSummary === "string") result.sceneSummary = sceneSummary;

  const userFacingSummary = pickFirst(obj, [
    "userFacingSummary",
    "user_facing_summary",
    "userSummary",
  ]);
  if (typeof userFacingSummary === "string") result.userFacingSummary = userFacingSummary;
  else if (typeof result.sceneSummary === "string") result.userFacingSummary = result.sceneSummary;

  const likelyWorkPurpose = pickFirst(obj, [
    "likelyWorkPurpose",
    "likely_work_purpose",
    "workPurpose",
  ]);
  if (typeof likelyWorkPurpose === "string") result.likelyWorkPurpose = likelyWorkPurpose;
  else if (typeof result.possibleUserIntent === "string") result.likelyWorkPurpose = result.possibleUserIntent;

  const possibleUserIntent = pickFirst(obj, [
    "possibleUserIntent",
    "possible_user_intent",
    "userIntent",
  ]);
  if (typeof possibleUserIntent === "string") result.possibleUserIntent = possibleUserIntent;
  else if (typeof result.likelyWorkPurpose === "string") result.possibleUserIntent = result.likelyWorkPurpose;

  // 枚举归一化
  const rawPrivacyRisk = pickFirst(obj, ["privacyRisk", "privacy_risk", "privateRisk"]);
  if (typeof rawPrivacyRisk === "string") {
    const norm = PRIVACY_RISK_NORMALIZE[rawPrivacyRisk.toLowerCase()];
    if (norm) result.privacyRisk = norm;
  }
  if (typeof result.privacyRisk !== "string") result.privacyRisk = "low";

  const privacyRiskReason = pickFirst(obj, [
    "privacyRiskReason",
    "privacy_risk_reason",
    "privateRiskReason",
    "sensitivityReason",
  ]);
  if (typeof privacyRiskReason === "string") result.privacyRiskReason = privacyRiskReason;
  else result.privacyRiskReason = result.privacyRisk === "high" ? "可能包含敏感内容" : "未发现明显隐私风险";

  const rawReportableSignal = pickFirst(obj, [
    "reportableSignal",
    "reportable_signal",
    "reportable",
  ]);
  if (typeof rawReportableSignal === "string") {
    const norm = REPORTABLE_SIGNAL_NORMALIZE[rawReportableSignal.toLowerCase()];
    if (norm) result.reportableSignal = norm;
  } else if (typeof rawReportableSignal === "boolean") {
    result.reportableSignal = rawReportableSignal ? "yes" : "no";
  }
  if (typeof result.reportableSignal !== "string") result.reportableSignal = "maybe";

  const reportableReason = pickFirst(obj, [
    "reportableReason",
    "reportable_reason",
    "workReportReason",
  ]);
  if (typeof reportableReason === "string") result.reportableReason = reportableReason;
  else result.reportableReason = result.reportableSignal === "no" ? "不适合进入工作日报" : "可能对后续回顾有价值";

  const rawSensitivity = pickFirst(obj, ["sensitivity"]);
  if (typeof rawSensitivity === "string") {
    const norm = SENSITIVITY_NORMALIZE[rawSensitivity.toLowerCase()];
    if (norm) result.sensitivity = norm;
  }
  if (typeof result.sensitivity !== "string") result.sensitivity = "normal";

  // 缺失数组默认 []
  if (!Array.isArray(result.uncertainties)) result.uncertainties = [];
  if (!Array.isArray(result.detectedEntities)) result.detectedEntities = [];
  if (!Array.isArray(result.possibleTasks)) result.possibleTasks = [];
  if (!Array.isArray(result.possibleDecisions)) result.possibleDecisions = [];

  if (typeof result.sceneSummary !== "string") result.sceneSummary = "无法清晰识别当前画面";
  if (typeof result.userFacingSummary !== "string") result.userFacingSummary = result.sceneSummary;
  if (typeof result.likelyWorkPurpose !== "string") result.likelyWorkPurpose = "当前工作目的不明确";
  if (typeof result.possibleUserIntent !== "string") result.possibleUserIntent = result.likelyWorkPurpose;

  return result;
}

/**
 * ObserverOutputV2 CoreSchema（用于类型推导）
 */
const ObserverOutputV2CoreSchema = z.object({
  frameIndex: z.coerce.number().int().positive().optional(),
  sceneSummary: SummarySchema,
  userFacingSummary: z.string().max(TEXT_LIMITS.summary),
  likelyWorkPurpose: z.string().max(TEXT_LIMITS.title),
  visibleContent: z.array(
    z.object({
      type: z.enum([
        "webpage",
        "document",
        "chat",
        "code",
        "spreadsheet",
        "design",
        "email",
        "terminal",
        "unknown",
      ]),
      summary: SummarySchema,
      fullText: z.string(),
      keyTextSnippets: z.array(z.string().max(TEXT_LIMITS.evidenceText)),
    })
  ),
  detectedEntities: z.array(
    z.object({
      name: TitleSchema,
      type: z.enum([
        "person",
        "product",
        "project",
        "company",
        "file",
        "url",
        "concept",
        "other",
      ]),
      evidence: EvidenceTextSchema,
      confidence: ConfidenceSchema,
    })
  ),
  possibleUserIntent: z.string().max(TEXT_LIMITS.factContent),
  possibleTasks: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  possibleDecisions: z.array(
    z.object({
      text: FactContentSchema,
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  possibleProjectProgress: z.array(
    z.object({
      text: FactContentSchema,
      projectHint: TitleSchema.optional(),
      confidence: ConfidenceSchema,
      evidence: EvidenceTextSchema,
    })
  ),
  privacyRisk: z.enum(["low", "medium", "high"]),
  privacyRiskReason: z.string().max(TEXT_LIMITS.reason),
  reportableSignal: z.enum(["yes", "maybe", "no"]),
  reportableReason: z.string().max(TEXT_LIMITS.reason),
  sensitivity: z.enum(["normal", "possibly_sensitive", "high_sensitive"]),
  confidence: ConfidenceSchema,
  uncertainties: z.array(z.string().max(TEXT_LIMITS.factContent)),
});

/**
 * 导出的 ObserverOutputV2 schema（已用 preprocess 包装，自动归一化模型输出）
 */
export const ObserverOutputV2Schema = z.preprocess(
  normalizeObserverOutputV2,
  ObserverOutputV2CoreSchema
);

/**
 * ExtractorOutputV2 facts 归一化
 *
 * 在 normalizeFacts（V1）基础上新增 V2 字段：
 * - displayUse：默认 []（缺失时给空数组）
 * - reportable：默认 false
 * - privateRisk：默认 "low"，枚举变体归一化
 * - userValue：默认 "medium"，枚举变体归一化
 */
function normalizeFactsV2(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const camelObj = normalizeKeysToCamel(item);
    const obj = camelObj as Record<string, unknown>;

    // content 是核心字段，缺失则跳过
    const content =
      typeof obj.content === "string"
        ? obj.content
        : typeof obj.text === "string"
        ? obj.text
        : typeof obj.description === "string"
        ? obj.description
        : "";
    if (!content.trim()) continue;

    // type 归一化（复用 V1 映射）
    const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : "note";
    const normalizedType = FACT_TYPE_NORMALIZE[rawType] ?? "note";

    // status 归一化
    let normalizedStatus: string | undefined;
    if (typeof obj.status === "string") {
      normalizedStatus = FACT_STATUS_NORMALIZE[obj.status.toLowerCase()];
    }

    // importance/confidence 归一化
    const importance = normalizeNumber(obj.importance, 0.5);
    const confidence = normalizeNumber(obj.confidence, 0.5);

    // inferred 归一化
    let inferred: boolean;
    if (typeof obj.inferred === "boolean") {
      inferred = obj.inferred;
    } else if (typeof obj.inferred === "string") {
      inferred = obj.inferred.toLowerCase() === "true" || obj.inferred.toLowerCase() === "1";
    } else {
      inferred = false;
    }

    // 数组字段归一化
    const peopleHints = normalizeStringArray(obj.peopleHints);
    const sourceObservationIds = normalizeStringArray(obj.sourceObservationIds);
    const tags = normalizeStringArray(obj.tags);

    // evidenceText 归一化
    const evidenceText =
      typeof obj.evidenceText === "string"
        ? obj.evidenceText
        : typeof obj.evidence === "string"
        ? obj.evidence
        : typeof obj.reason === "string"
        ? obj.reason
        : "";

    // V2 新增字段：displayUse
    let displayUse: string[] = [];
    const rawDisplayUse = obj.displayUse;
    if (Array.isArray(rawDisplayUse)) {
      displayUse = rawDisplayUse
        .map((d) => {
          if (typeof d !== "string") return "";
          const norm = DISPLAY_USE_NORMALIZE[d.toLowerCase()];
          return norm || "";
        })
        .filter((s) => s.length > 0);
    } else if (typeof rawDisplayUse === "string") {
      const norm = DISPLAY_USE_NORMALIZE[rawDisplayUse.toLowerCase()];
      if (norm) displayUse = [norm];
    }

    // V2 新增字段：reportable
    let reportable: boolean;
    if (typeof obj.reportable === "boolean") {
      reportable = obj.reportable;
    } else if (typeof obj.reportable === "string") {
      reportable =
        obj.reportable.toLowerCase() === "true" ||
        obj.reportable.toLowerCase() === "yes" ||
        obj.reportable.toLowerCase() === "1";
    } else {
      reportable = false;
    }

    // V2 新增字段：privateRisk
    let privateRisk = "low";
    const rawPrivateRisk = obj.privateRisk;
    if (typeof rawPrivateRisk === "string") {
      const norm = PRIVACY_RISK_NORMALIZE[rawPrivateRisk.toLowerCase()];
      if (norm) privateRisk = norm;
    }

    // V2 新增字段：userValue
    let userValue = "medium";
    const rawUserValue = obj.userValue;
    if (typeof rawUserValue === "string") {
      const norm = USER_VALUE_NORMALIZE[rawUserValue.toLowerCase()];
      if (norm) userValue = norm;
    }

    const normalized: Record<string, unknown> = {
      type: normalizedType,
      content: content.slice(0, TEXT_LIMITS.factContent),
      importance: Math.max(0, Math.min(1, importance)),
      confidence: Math.max(0, Math.min(1, confidence)),
      inferred,
      evidenceText: evidenceText.slice(0, TEXT_LIMITS.evidenceText),
      peopleHints: peopleHints.map((s) => s.slice(0, TEXT_LIMITS.title)),
      sourceObservationIds,
      tags: tags.map((s) => s.slice(0, TEXT_LIMITS.title)),
      displayUse: displayUse as ["timeline" | "personal_review" | "work_report" | "memory" | "task_list"],
      reportable,
      privateRisk: privateRisk as "low" | "medium" | "high",
      userValue: userValue as "low" | "medium" | "high",
    };

    if (normalizedStatus) {
      normalized.status = normalizedStatus;
    }
    if (typeof obj.projectHint === "string" && obj.projectHint.trim()) {
      normalized.projectHint = obj.projectHint.slice(0, TEXT_LIMITS.title);
    } else if (typeof obj.project === "string" && obj.project.trim()) {
      normalized.projectHint = obj.project.slice(0, TEXT_LIMITS.title);
    }

    result.push(normalized);
  }
  return result;
}

/**
 * ExtractorOutputV2 归一化函数
 *
 * 2026-07-07 容错改造：
 * - 新增裸数组兜底：LLM 偶尔输出 [{...}, {...}] 而非 {facts: [...]}
 *   之前 normalizeKeysToCamel 对数组直接返回原数组，{...obj} 展开为 {0:{...},1:{...},length:2}
 *   导致 schema fail。修复：检测到数组时包装为 {facts: data}
 */
function normalizeExtractorOutputV2(data: unknown): unknown {
  // 裸数组兜底：LLM 偶尔直接输出 fact 数组而非 {facts: [...]}
  if (Array.isArray(data)) {
    return { facts: normalizeFactsV2(data), discardedNoise: [] };
  }
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  if (obj.facts !== undefined) {
    result.facts = normalizeFactsV2(obj.facts);
  }
  if (obj.discardedNoise !== undefined) {
    result.discardedNoise = normalizeDiscardedNoise(obj.discardedNoise);
  } else {
    result.discardedNoise = [];
  }

  return result;
}

/**
 * ExtractorOutputV2 CoreSchema
 */
const ExtractorOutputV2CoreSchema = z.object({
  facts: z.array(
    z.object({
      type: z.enum([
        "task",
        "decision",
        "project_progress",
        "person",
        "preference",
        "knowledge",
        "risk",
        "question",
        "note",
      ]),
      content: FactContentSchema,
      status: z
        .enum(["open", "in_progress", "likely_done", "done", "blocked", "unknown"])
        .optional(),
      projectHint: TitleSchema.optional(),
      peopleHints: z.array(TitleSchema),
      importance: ImportanceSchema,
      confidence: ConfidenceSchema,
      inferred: z.boolean(),
      evidenceText: EvidenceTextSchema,
      sourceObservationIds: z.array(z.string()),
      tags: z.array(TitleSchema),
      displayUse: z.array(
        z.enum(["timeline", "personal_review", "work_report", "memory", "task_list"])
      ),
      reportable: z.boolean(),
      privateRisk: z.enum(["low", "medium", "high"]),
      userValue: z.enum(["low", "medium", "high"]),
    })
  ),
  discardedNoise: z.array(
    z.object({
      reason: ReasonSchema,
      text: FactContentSchema,
    })
  ),
});

/**
 * 导出的 ExtractorOutputV2 schema
 */
export const ExtractorOutputV2Schema = z.preprocess(
  normalizeExtractorOutputV2,
  ExtractorOutputV2CoreSchema
);

const EpisodeActivityCategorySchema = z.enum([
  "focus_work",
  "communication",
  "research",
  "writing",
  "coding",
  "design",
  "meeting",
  "admin",
  "break",
  "mixed",
  "unknown",
]);

function normalizeEpisodeActivities(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;
    const sceneIdRaw = obj.sceneId ?? obj.episodeId ?? obj.id;
    if (typeof sceneIdRaw !== "string" || !sceneIdRaw.trim()) continue;
    const rawCategory = typeof obj.category === "string"
      ? obj.category.trim().toLowerCase()
      : "unknown";
    result.push({
      sceneId: sceneIdRaw.trim(),
      category: TIMELINE_BLOCK_CATEGORY_NORMALIZE[rawCategory] ?? "unknown",
      confidence: Math.max(0, Math.min(1, normalizeNumber(obj.confidence, 0.5))),
    });
  }
  return result;
}

function normalizeEpisodeFactExtractorOutput(data: unknown): unknown {
  const normalized = normalizeExtractorOutputV2(data);
  if (!normalized || typeof normalized !== "object") return normalized;
  const source = data && typeof data === "object" && !Array.isArray(data)
    ? normalizeKeysToCamel(data) as Record<string, unknown>
    : {};
  return {
    ...(normalized as Record<string, unknown>),
    episodeActivities: normalizeEpisodeActivities(
      source.episodeActivities ?? source.activities ?? source.episodeClassifications
    ),
  };
}

const EpisodeFactExtractorOutputCoreSchema = ExtractorOutputV2CoreSchema.extend({
  episodeActivities: z.array(z.object({
    sceneId: z.string().min(1),
    category: EpisodeActivityCategorySchema,
    confidence: ConfidenceSchema,
  })),
});

export const EpisodeFactExtractorOutputSchema = z.preprocess(
  normalizeEpisodeFactExtractorOutput,
  EpisodeFactExtractorOutputCoreSchema
);

/**
 * TimelineBuilderOutput blocks 归一化
 *
 * 2026-07-07 容错改造：
 * - 之前 startAt/endAt 缺失时填 ""，IsoDateTimeWithOffsetSchema 正则不匹配 ""，
 *   导致单个 block 失败 → 整个 blocks 数组失败 → 整个 timeline_builder 任务失败（234/29）
 * - 修复：startAt/endAt 缺失或非法时跳过该 block（与 title 缺失跳过一致），
 *   保留合法 block，避免一个坏 block 拖垮整批
 */
function normalizeTimelineBlocks(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;

    // title/summary 是核心字段，缺失则跳过
    const title =
      typeof obj.title === "string"
        ? obj.title
        : typeof obj.name === "string"
        ? obj.name
        : "";
    if (!title.trim()) continue;

    // Model times are compatibility-only; backend source observations are authoritative.
    const startAtRaw = typeof obj.startAt === "string" ? obj.startAt : "";
    const endAtRaw = typeof obj.endAt === "string" ? obj.endAt : "";

    const summary =
      typeof obj.summary === "string"
        ? obj.summary
        : typeof obj.description === "string"
        ? obj.description
        : "";

    // category 归一化
    const rawCategory = typeof obj.category === "string" ? obj.category.toLowerCase() : "unknown";
    const category = TIMELINE_BLOCK_CATEGORY_NORMALIZE[rawCategory] ?? "unknown";

    // 数组字段归一化
    const projectIds = normalizeStringArray(obj.projectIds);
    const projectNames = normalizeStringArray(obj.projectNames);
    const highlights = normalizeStringArray(obj.highlights);
    const generatedTasks = normalizeStringArray(obj.generatedTasks);
    const sourceSceneIds = normalizeStringArray(obj.sourceSceneIds);
    const sourceFactIds = normalizeStringArray(obj.sourceFactIds);
    const sourceObservationIds = normalizeStringArray(obj.sourceObservationIds);

    // generatedDecisions 可能缺失
    const generatedDecisions = normalizeStringArray(obj.generatedDecisions);

    // reportable 归一化
    let reportable: boolean;
    if (typeof obj.reportable === "boolean") {
      reportable = obj.reportable;
    } else if (typeof obj.reportable === "string") {
      reportable =
        obj.reportable.toLowerCase() === "true" ||
        obj.reportable.toLowerCase() === "yes" ||
        obj.reportable.toLowerCase() === "1";
    } else {
      reportable = false;
    }

    // privateRisk 归一化
    let privateRisk = "low";
    const rawPrivateRisk = obj.privateRisk ?? obj.privacyRisk;
    if (typeof rawPrivateRisk === "string") {
      const norm = PRIVACY_RISK_NORMALIZE[rawPrivateRisk.toLowerCase()];
      if (norm) privateRisk = norm;
    }

    const privateRiskReason =
      typeof obj.privateRiskReason === "string"
        ? obj.privateRiskReason
        : typeof obj.privacyRiskReason === "string"
        ? obj.privacyRiskReason
        : "";

    const confidence = normalizeNumber(obj.confidence, 0.5);

    const normalized: Record<string, unknown> = {
      startAt: isValidIsoish(startAtRaw) ? startAtRaw : undefined,
      endAt: isValidIsoish(endAtRaw) ? endAtRaw : undefined,
      title: title.slice(0, TEXT_LIMITS.title),
      summary: summary.slice(0, TEXT_LIMITS.summary),
      category,
      projectIds,
      projectNames,
      highlights,
      generatedTasks,
      generatedDecisions,
      reportable,
      privateRisk,
      privateRiskReason: privateRiskReason.slice(0, TEXT_LIMITS.reason),
      sourceSceneIds,
      sourceFactIds,
      sourceObservationIds,
      confidence: Math.max(0, Math.min(1, confidence)),
    };

    if (typeof obj.id === "string") {
      normalized.id = obj.id;
    }

    result.push(normalized);
  }
  return result;
}

/**
 * 判断字符串是否是"看起来合法"的 ISO 时间
 *
 * 用于 normalizeTimelineBlocks 跳过时间字段非法的 block。
 * 判断标准：new Date() 能解析出有效时间。
 * 这样能过滤掉 ""、"上午 9 点"、"08:30"（无日期）等非法值。
 */
function isValidIsoish(value: string): boolean {
  if (!value || typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // 必须包含日期部分（YYYY-MM-DD）
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
  const d = new Date(trimmed);
  return !Number.isNaN(d.getTime());
}

/**
 * TimelineBuilderOutput 归一化函数
 *
 * 2026-07-07 容错改造：
 * - 顶层 dayStartSummary/dayMainThread 缺失时填空字符串（之前缺失会导致 schema fail）
 * - 顶层字段做长度截断（之前 LLM 输出超 1000 字会 schema fail）
 * - dateKey 缺失时填空字符串（worker 已知 dateKey，schema 不应因 LLM 漏填 dateKey 而整张失败）
 */
function normalizeTimelineBuilderOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  if (obj.blocks !== undefined) {
    result.blocks = normalizeTimelineBlocks(obj.blocks);
  } else {
    result.blocks = [];
  }

  // dateKey 字段名变体 + 缺失兜底
  const dateKey = pickFirst(obj, ["dateKey", "date_key", "date"]);
  result.dateKey = typeof dateKey === "string" ? dateKey : "";

  // dayStartSummary 字段名变体 + 缺失兜底 + 长度截断
  const dayStartSummary = pickFirst(obj, [
    "dayStartSummary",
    "day_start_summary",
    "daySummary",
  ]);
  result.dayStartSummary =
    typeof dayStartSummary === "string" ? dayStartSummary.slice(0, TEXT_LIMITS.summary) : "";

  // dayMainThread 字段名变体 + 缺失兜底 + 长度截断
  const dayMainThread = pickFirst(obj, [
    "dayMainThread",
    "day_main_thread",
    "mainThread",
  ]);
  result.dayMainThread =
    typeof dayMainThread === "string" ? dayMainThread.slice(0, TEXT_LIMITS.summary) : "";

  return result;
}

/**
 * TimelineBuilderOutput CoreSchema
 *
 * - startAt/endAt 强约束必须带时区（IsoDateTimeWithOffsetSchema）
 * - 修复：之前 z.string() 放过无时区字符串，渲染端 new Date() 解析为本地时间，导致错位
 */
const TimelineBuilderOutputCoreSchema = z.object({
  dateKey: z.string(),
  dayStartSummary: z.string().max(TEXT_LIMITS.summary),
  dayMainThread: z.string().max(TEXT_LIMITS.summary),
  blocks: z.array(
    z.object({
      id: z.string().optional(),
      startAt: IsoDateTimeWithOffsetSchema.optional(),
      endAt: IsoDateTimeWithOffsetSchema.optional(),
      title: TitleSchema,
      summary: SummarySchema,
      category: z.enum([
        "focus_work",
        "communication",
        "research",
        "writing",
        "coding",
        "design",
        "meeting",
        "admin",
        "break",
        "mixed",
        "unknown",
      ]),
      projectIds: z.array(z.string()),
      projectNames: z.array(z.string()),
      highlights: z.array(z.string()),
      generatedTasks: z.array(z.string()),
      generatedDecisions: z.array(z.string()),
      reportable: z.boolean(),
      privateRisk: z.enum(["low", "medium", "high"]),
      privateRiskReason: z.string().max(TEXT_LIMITS.reason),
      sourceSceneIds: z.array(z.string()),
      sourceFactIds: z.array(z.string()),
      sourceObservationIds: z.array(z.string()),
      confidence: ConfidenceSchema,
    })
  ),
});

/**
 * 导出的 TimelineBuilderOutput schema
 */
export const TimelineBuilderOutputSchema = z.preprocess(
  normalizeTimelineBuilderOutput,
  TimelineBuilderOutputCoreSchema
);

/**
 * PersonalReviewOutput 归一化函数
 *
 * 处理：
 * - snake_case → camelCase
 * - mainThreads / meaningfulProgress / tomorrowStartHere：字符串数组归一化
 * - unfinished：可能为对象数组或字符串数组（fallback 时包装为对象）
 * - worthRemembering：可能为对象数组或字符串数组
 */
function normalizePersonalReviewOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // dateKey 字段名变体
  const dateKey = pickFirst(obj, ["dateKey", "date_key", "date"]);
  if (typeof dateKey === "string") result.dateKey = dateKey;

  // 字符串数组字段
  result.mainThreads = normalizeStringArray(obj.mainThreads);
  result.meaningfulProgress = normalizeStringArray(obj.meaningfulProgress);
  result.tomorrowStartHere = normalizeStringArray(obj.tomorrowStartHere);

  // unfinished 归一化（对象数组或字符串数组）
  const unfinishedRaw = obj.unfinished;
  if (Array.isArray(unfinishedRaw)) {
    result.unfinished = unfinishedRaw
      .map((item) => {
        if (typeof item === "string") {
          return {
            text: item.slice(0, TEXT_LIMITS.factContent),
            suggestedNextAction: "",
            sourceTimelineBlockIds: [],
            sourceFactIds: [],
          };
        }
        if (!item || typeof item !== "object") return null;
        const it = normalizeKeysToCamel(item) as Record<string, unknown>;
        const text =
          typeof it.text === "string"
            ? it.text
            : typeof it.content === "string"
            ? it.content
            : typeof it.title === "string"
            ? it.title
            : "";
        if (!text.trim()) return null;
        return {
          text: text.slice(0, TEXT_LIMITS.factContent),
          suggestedNextAction:
            (typeof it.suggestedNextAction === "string"
              ? it.suggestedNextAction
              : typeof it.nextAction === "string"
              ? it.nextAction
              : ""
            ).slice(0, TEXT_LIMITS.reason),
          sourceTimelineBlockIds: normalizeStringArray(it.sourceTimelineBlockIds),
          sourceFactIds: normalizeStringArray(it.sourceFactIds),
        };
      })
      .filter((x) => x !== null);
  } else {
    result.unfinished = [];
  }

  // worthRemembering 归一化（对象数组或字符串数组）
  const worthRaw = obj.worthRemembering;
  if (Array.isArray(worthRaw)) {
    result.worthRemembering = worthRaw
      .map((item) => {
        if (typeof item === "string") {
          return {
            text: item.slice(0, TEXT_LIMITS.factContent),
            reason: "",
            sourceFactIds: [],
          };
        }
        if (!item || typeof item !== "object") return null;
        const it = normalizeKeysToCamel(item) as Record<string, unknown>;
        const text =
          typeof it.text === "string"
            ? it.text
            : typeof it.content === "string"
            ? it.content
            : "";
        if (!text.trim()) return null;
        return {
          text: text.slice(0, TEXT_LIMITS.factContent),
          reason:
            (typeof it.reason === "string" ? it.reason : "").slice(0, TEXT_LIMITS.reason),
          sourceFactIds: normalizeStringArray(it.sourceFactIds),
        };
      })
      .filter((x) => x !== null);
  } else {
    result.worthRemembering = [];
  }

  return result;
}

/**
 * PersonalReviewOutput CoreSchema
 */
const PersonalReviewOutputCoreSchema = z.object({
  dateKey: z.string(),
  title: TitleSchema,
  overview: z.string().max(TEXT_LIMITS.reportOverview),
  mainThreads: z.array(z.string()),
  meaningfulProgress: z.array(z.string()),
  unfinished: z.array(
    z.object({
      text: FactContentSchema,
      suggestedNextAction: z.string().max(TEXT_LIMITS.reason),
      sourceTimelineBlockIds: z.array(z.string()),
      sourceFactIds: z.array(z.string()),
    })
  ),
  worthRemembering: z.array(
    z.object({
      text: FactContentSchema,
      reason: z.string().max(TEXT_LIMITS.reason),
      sourceFactIds: z.array(z.string()),
    })
  ),
  tomorrowStartHere: z.array(z.string()),
});

/**
 * 导出的 PersonalReviewOutput schema
 */
export const PersonalReviewOutputSchema = z.preprocess(
  normalizePersonalReviewOutput,
  PersonalReviewOutputCoreSchema
);

/**
 * WorkReportOutput sections 归一化
 *
 * 模型可能返回 sections 为对象 {completed, projectProgress, risks, tomorrowPlan}
 * 或其他变体字段名。本函数统一字段名。
 */
function normalizeWorkReportSections(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") {
    return {
      completed: [],
      projectProgress: [],
      risks: [],
      tomorrowPlan: [],
    };
  }
  const obj = normalizeKeysToCamel(raw) as Record<string, unknown>;
  return {
    completed: normalizeStringArray(
      pickFirst(obj, ["completed", "completion", "done", "finished"])
    ),
    projectProgress: normalizeStringArray(
      pickFirst(obj, ["projectProgress", "project_progress", "progress", "projects"])
    ),
    risks: normalizeStringArray(pickFirst(obj, ["risks", "risk", "problems", "issues"])),
    tomorrowPlan: normalizeStringArray(
      pickFirst(obj, ["tomorrowPlan", "tomorrow_plan", "nextPlan", "next_plan", "tomorrow"])
    ),
  };
}

/**
 * WorkReportOutput 归一化函数
 */
function normalizeWorkReportOutput(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // dateKey 字段名变体
  const dateKey = pickFirst(obj, ["dateKey", "date_key", "date"]);
  if (typeof dateKey === "string") result.dateKey = dateKey;

  // title 字段名变体
  const title = pickFirst(obj, ["title", "headline"]);
  if (typeof title === "string") result.title = title;

  // plainText 字段名变体
  const plainText = pickFirst(obj, ["plainText", "plain_text", "text", "content"]);
  if (typeof plainText === "string") result.plainText = plainText;

  // sections 归一化
  result.sections = normalizeWorkReportSections(obj.sections);

  // 数组字段归一化
  result.sourceTimelineBlockIds = normalizeStringArray(
    pickFirst(obj, ["sourceTimelineBlockIds", "source_timeline_block_ids"])
  );
  result.sourceFactIds = normalizeStringArray(
    pickFirst(obj, ["sourceFactIds", "source_fact_ids"])
  );
  result.warnings = normalizeStringArray(obj.warnings);

  // omittedForPrivacy 数值归一化
  const omittedRaw = pickFirst(obj, ["omittedForPrivacy", "omitted_for_privacy", "omitted"]);
  result.omittedForPrivacy = normalizeNumber(omittedRaw, 0);

  return result;
}

/**
 * WorkReportOutput CoreSchema
 */
const WorkReportOutputCoreSchema = z.object({
  dateKey: z.string(),
  title: TitleSchema,
  plainText: z.string(),
  sections: z.object({
    completed: z.array(z.string()),
    projectProgress: z.array(z.string()),
    risks: z.array(z.string()),
    tomorrowPlan: z.array(z.string()),
  }),
  sourceTimelineBlockIds: z.array(z.string()),
  sourceFactIds: z.array(z.string()),
  omittedForPrivacy: z.number().int().min(0),
  warnings: z.array(z.string()),
});

/**
 * 导出的 WorkReportOutput schema
 */
export const WorkReportOutputSchema = z.preprocess(
  normalizeWorkReportOutput,
  WorkReportOutputCoreSchema
);

/**
 * JudgeOutputV2 unfinishedThreads 归一化
 */
function normalizeUnfinishedThreads(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;

    const title =
      typeof obj.title === "string"
        ? obj.title
        : typeof obj.text === "string"
        ? obj.text
        : "";
    if (!title.trim()) continue;

    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.why === "string"
        ? obj.why
        : "";
    const suggestedNextAction =
      typeof obj.suggestedNextAction === "string"
        ? obj.suggestedNextAction
        : typeof obj.nextAction === "string"
        ? obj.nextAction
        : typeof obj.suggestion === "string"
        ? obj.suggestion
        : "";

    // priority 归一化（枚举变体）
    let priority = "medium";
    const rawPriority = obj.priority;
    if (typeof rawPriority === "string") {
      const norm = THREAD_PRIORITY_NORMALIZE[rawPriority.toLowerCase()];
      if (norm) priority = norm;
    } else if (typeof rawPriority === "number") {
      // 数值映射：0 → low, 1 → medium, 2 → high
      if (rawPriority >= 2) priority = "high";
      else if (rawPriority >= 1) priority = "medium";
      else priority = "low";
    }

    const confidence = normalizeNumber(obj.confidence, 0.5);

    result.push({
      title: title.slice(0, TEXT_LIMITS.title),
      reason: reason.slice(0, TEXT_LIMITS.reason),
      suggestedNextAction: suggestedNextAction.slice(0, TEXT_LIMITS.reason),
      priority,
      sourceFactIds: normalizeStringArray(obj.sourceFactIds),
      sourceTimelineBlockIds: normalizeStringArray(obj.sourceTimelineBlockIds),
      confidence: Math.max(0, Math.min(1, confidence)),
    });
  }
  return result;
}

/**
 * JudgeOutputV2 proactiveItems 归一化
 *
 * proactiveItems.priority 是 number（[0,1]），与 unfinishedThreads.priority（enum）不同
 */
function normalizeProactiveItemsV2(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const result: unknown[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = normalizeKeysToCamel(item) as Record<string, unknown>;

    const title =
      typeof obj.title === "string"
        ? obj.title
        : typeof obj.text === "string"
        ? obj.text
        : "";
    if (!title.trim()) continue;

    const body =
      typeof obj.body === "string"
        ? obj.body
        : typeof obj.content === "string"
        ? obj.content
        : typeof obj.summary === "string"
        ? obj.summary
        : "";
    const reason =
      typeof obj.reason === "string"
        ? obj.reason
        : typeof obj.why === "string"
        ? obj.why
        : "";

    // type 归一化
    const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : "task_reminder";
    const type = PROACTIVE_TYPE_V2_NORMALIZE[rawType] ?? "task_reminder";

    // priority 归一化（数值）
    const priority = normalizeNumber(obj.priority, 0.5);

    // surface 归一化
    const rawSurface = typeof obj.surface === "string" ? obj.surface.toLowerCase() : "in_app";
    const surface = PROACTIVE_SURFACE_NORMALIZE[rawSurface] ?? "in_app";

    // requiresUserConfirmation 归一化
    let requiresUserConfirmation: boolean;
    if (typeof obj.requiresUserConfirmation === "boolean") {
      requiresUserConfirmation = obj.requiresUserConfirmation;
    } else if (typeof obj.requiresUserConfirmation === "string") {
      requiresUserConfirmation =
        obj.requiresUserConfirmation.toLowerCase() === "true" ||
        obj.requiresUserConfirmation.toLowerCase() === "yes";
    } else {
      requiresUserConfirmation = false;
    }

    result.push({
      type,
      title: title.slice(0, TEXT_LIMITS.title),
      body: body.slice(0, TEXT_LIMITS.summary),
      reason: reason.slice(0, TEXT_LIMITS.reason),
      priority: Math.max(0, Math.min(1, priority)),
      surface,
      requiresUserConfirmation,
      sourceFactIds: normalizeStringArray(obj.sourceFactIds),
      sourceSceneIds: normalizeStringArray(obj.sourceSceneIds),
    });
  }
  return result;
}

/**
 * JudgeOutputV2 归一化函数
 *
 * 2026-07-07 容错改造：
 * - 新增裸数组兜底：LLM 偶尔输出 [{...}] 而非 {unfinishedThreads: [...]}
 *   修复：检测到数组时包装为 {unfinishedThreads: data, proactiveItems: []}
 */
function normalizeJudgeOutputV2(data: unknown): unknown {
  // 裸数组兜底：LLM 偶尔直接输出 threads 数组
  if (Array.isArray(data)) {
    return {
      unfinishedThreads: normalizeUnfinishedThreads(data),
      proactiveItems: [],
    };
  }
  if (!data || typeof data !== "object") return data;
  const obj = normalizeKeysToCamel(data);
  const result: Record<string, unknown> = { ...obj };

  // 字段名变体：unfinishedThreads 可能叫 threads / unfinished
  const threadsRaw =
    obj.unfinishedThreads ?? obj.threads ?? obj.unfinished ?? obj.unfinishedThreadsList;
  result.unfinishedThreads = normalizeUnfinishedThreads(threadsRaw);

  // 字段名变体：proactiveItems 可能叫 items / proactive / reminders
  const itemsRaw =
    obj.proactiveItems ?? obj.items ?? obj.proactive ?? obj.reminders ?? obj.proactiveItemsList;
  result.proactiveItems = normalizeProactiveItemsV2(itemsRaw);

  return result;
}

/**
 * JudgeOutputV2 CoreSchema
 */
const JudgeOutputV2CoreSchema = z.object({
  unfinishedThreads: z.array(
    z.object({
      title: TitleSchema,
      reason: ReasonSchema,
      suggestedNextAction: z.string().max(TEXT_LIMITS.reason),
      priority: z.enum(["low", "medium", "high"]),
      sourceFactIds: z.array(z.string()),
      sourceTimelineBlockIds: z.array(z.string()),
      confidence: ConfidenceSchema,
    })
  ),
  proactiveItems: z.array(
    z.object({
      type: z.enum([
        "task_reminder",
        "risk_warning",
        "decision_review",
        "tomorrow_suggestion",
        "needs_confirmation",
      ]),
      title: TitleSchema,
      body: SummarySchema,
      reason: ReasonSchema,
      priority: PrioritySchema,
      surface: z.enum(["in_app", "daily_report", "desktop_notification_candidate"]),
      requiresUserConfirmation: z.boolean(),
      sourceFactIds: z.array(z.string()),
      sourceSceneIds: z.array(z.string()),
    })
  ),
});

/**
 * 导出的 JudgeOutputV2 schema
 */
export const JudgeOutputV2Schema = z.preprocess(
  normalizeJudgeOutputV2,
  JudgeOutputV2CoreSchema
);

/**
 * 全部模型输出 schema 注册表
 * 用于 JSON repair prompt 生成与运行时校验
 *
 * Phase 2 新增：
 * - observer_v2 / extractor_v2 / timeline_builder / personal_review / work_report / judge_v2
 */
export const MODEL_OUTPUT_SCHEMAS = {
  vision_observation: VisionObservationOutputSchema,
  /** @deprecated 使用 extractor_v2（ExtractorOutputV2Schema） */
  extractor: ExtractorOutputSchema,
  linker: LinkerOutputSchema,
  scene_builder: SceneBuilderOutputSchema,
  /** @deprecated 使用 judge_v2（JudgeOutputV2Schema） */
  judge: JudgeOutputSchema,
  daily_report: DailyReportOutputSchema,
  weekly_report: WeeklyReportOutputSchema,
  monthly_report: MonthlyReportOutputSchema,
  // Phase 2 新增
  observer_v2: ObserverOutputV2Schema,
  extractor_v2: ExtractorOutputV2Schema,
  timeline_builder: TimelineBuilderOutputSchema,
  personal_review: PersonalReviewOutputSchema,
  work_report: WorkReportOutputSchema,
  judge_v2: JudgeOutputV2Schema,
} as const;

export type ModelOutputSchemaName = keyof typeof MODEL_OUTPUT_SCHEMAS;

/**
 * VisionObservationOutput 类型推导
 *
 * 注意：基于 CoreSchema 而非 preprocess 包装后的 schema 推导类型。
 * preprocess 只在校验前归一化输入，输出类型与 CoreSchema 一致。
 * 如果基于 preprocess schema 推导，TypeScript 可能会包含 unknown 中间类型。
 */
export type VisionObservationOutput = z.infer<typeof VisionObservationOutputCoreSchema>;
/**
 * ExtractorOutput 类型推导
 *
 * 注意：基于 CoreSchema 而非 preprocess 包装后的 schema 推导类型，
 * 避免 TypeScript 推导出 unknown 中间类型。
 */
export type ExtractorOutput = z.infer<typeof ExtractorOutputCoreSchema>;
export type LinkerOutput = z.infer<typeof LinkerOutputCoreSchema>;
export type SceneBuilderOutput = z.infer<typeof SceneBuilderOutputSchema>;
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
export type DailyReportOutput = z.infer<typeof DailyReportOutputSchema>;
export type WeeklyReportOutput = z.infer<typeof WeeklyReportOutputSchema>;
export type MonthlyReportOutput = z.infer<typeof MonthlyReportOutputSchema>;

/**
 * Phase 2 类型说明
 *
 * Phase 2 的输出类型（ObserverOutputV2 / ExtractorOutputV2 / TimelineBuilderOutput /
 * PersonalReviewOutput / WorkReportOutput / JudgeOutputV2）在 src/main/models/types.ts
 * 中以 interface 形式定义，作为 main 端的规范类型。
 *
 * 这里不重复导出 z.infer 类型，避免与 types.ts 的 interface 同名冲突。
 * 如需校验后的类型，可从 types.ts 引入对应 interface；如需运行时校验，使用上面对应的 Schema。
 *
 * CoreSchema 仍保留为内部常量，用于 preprocess 包装和未来潜在的类型推导需求。
 */

// ============================================================================
// 多模态统一架构改造：合并 schema
// ============================================================================

/**
 * ObserverExtractor 合并输出 CoreSchema
 *
 * 合并 ObserverOutputV2 + ExtractorOutputV2，一次多模态调用同时产出 L0 Observation 和 L1 Facts。
 * 输出格式：{ observation: {...}, facts: [...], discardedNoise: [...] }
 */
const ObserverExtractorOutputCoreSchema = z.object({
  observation: ObserverOutputV2CoreSchema,
  facts: ExtractorOutputV2CoreSchema.shape.facts,
  discardedNoise: ExtractorOutputV2CoreSchema.shape.discardedNoise,
});

/**
 * ObserverExtractor 合并输出归一化
 */
function normalizeObserverExtractorOutput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };
  if (obj.observation) {
    result.observation = normalizeObserverOutputV2(obj.observation);
  }
  if (obj.facts !== undefined) {
    result.facts = normalizeFactsV2(obj.facts);
  } else {
    result.facts = [];
  }
  if (obj.discardedNoise !== undefined) {
    result.discardedNoise = normalizeDiscardedNoise(obj.discardedNoise);
  } else {
    result.discardedNoise = [];
  }
  return result;
}

/**
 * 导出的 ObserverExtractor 合并 schema
 */
export const ObserverExtractorOutputSchema = z.preprocess(
  normalizeObserverExtractorOutput,
  ObserverExtractorOutputCoreSchema
);

/**
 * ObserverExtractor 合并输出类型
 */
export type ObserverExtractorOutput = z.infer<typeof ObserverExtractorOutputCoreSchema>;

/**
 * 批次 ObserverExtractor 合并输出 CoreSchema
 *
 * 攒批多帧合并提交时使用，一次多模态调用同时产出多条 L0 Observation 和 L1 Facts。
 * 输出格式：{ observations: [{...}, ...], facts: [...], discardedNoise: [...] }
 *
 * 模型输出的 observations 数组长度应等于输入的帧数，
 * 每条 observation 对应一帧截图，通过 frames[i].frameIndex 对齐。
 */
const BatchObserverExtractorOutputCoreSchema = z.object({
  observations: z.array(ObserverOutputV2CoreSchema).min(1).max(20),
  facts: ExtractorOutputV2CoreSchema.shape.facts,
  discardedNoise: ExtractorOutputV2CoreSchema.shape.discardedNoise,
});

/**
 * 批次 ObserverExtractor 合并输出归一化
 *
 * 处理模型可能返回单 observation 而非数组的边界情况：
 * - 如果返回 observation（单数）而非 observations（数组），包装成数组
 * - 对每个 observation 调用 normalizeObserverOutputV2
 * - 对 facts 和 discardedNoise 调用现有归一化函数
 */
function normalizeBatchObserverExtractorOutput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  // 兼容：模型返回单 observation 而非 observations 数组
  if (!obj.observations && obj.observation) {
    result.observations = [obj.observation];
    delete result.observation;
  }

  // 对每个 observation 调用归一化
  if (Array.isArray(result.observations)) {
    result.observations = result.observations.map(
      (o) => normalizeObserverOutputV2(o) ?? o
    );
  }

  if (obj.facts !== undefined) {
    result.facts = normalizeFactsV2(obj.facts);
  } else {
    result.facts = [];
  }
  if (obj.discardedNoise !== undefined) {
    result.discardedNoise = normalizeDiscardedNoise(obj.discardedNoise);
  } else {
    result.discardedNoise = [];
  }
  return result;
}

/**
 * 导出的批次 ObserverExtractor 合并 schema
 */
export const BatchObserverExtractorOutputSchema = z.preprocess(
  normalizeBatchObserverExtractorOutput,
  BatchObserverExtractorOutputCoreSchema
);

/**
 * 批次 ObserverExtractor 合并输出类型
 */
export type BatchObserverExtractorOutput = z.infer<
  typeof BatchObserverExtractorOutputCoreSchema
>;

/**
 * 批次 Observer-only 输出 CoreSchema
 *
 * 记忆系统重构第一刀：批次多帧调用只产出 L0 Moment/Observation，不再同步产出
 * L1/L2 事实。后续 Episode/Atom 由独立 worker 从已落库 observations 重建。
 */
const BatchObserverOutputCoreSchema = z.object({
  observations: z.array(ObserverOutputV2CoreSchema).min(1).max(20),
});

function normalizeBatchObserverOutput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = input as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };

  if (!obj.observations && obj.observation) {
    result.observations = [obj.observation];
    delete result.observation;
  }

  if (Array.isArray(result.observations)) {
    result.observations = result.observations.map(
      (o) => normalizeObserverOutputV2(o) ?? o
    );
  }

  return result;
}

export const BatchObserverOutputSchema = z.preprocess(
  normalizeBatchObserverOutput,
  BatchObserverOutputCoreSchema
);

export type BatchObserverOutput = z.infer<typeof BatchObserverOutputCoreSchema>;

/**
 * LinkerSceneJudge 合并输出 CoreSchema
 *
 * 合并 LinkerOutput + SceneBuilderOutput + JudgeOutputV2，一次多模态调用同时产出
 * 关联结果 + Scenes（条件触发）+ proactiveItems + unfinishedThreads。
 *
 * 字段重命名（与合并 prompt 对齐）：
 * - LinkerOutput.links → linkedFacts
 * - LinkerOutput.mergeSuggestions → mergedObjects
 */
const LinkerSceneJudgeOutputCoreSchema = z.object({
  linkedFacts: LinkerOutputCoreSchema.shape.links,
  newObjects: LinkerOutputCoreSchema.shape.newObjects,
  mergedObjects: LinkerOutputCoreSchema.shape.mergeSuggestions,
  scenes: SceneBuilderOutputCoreSchema.shape.scenes,
  unfinishedThreads: JudgeOutputV2CoreSchema.shape.unfinishedThreads,
  proactiveItems: JudgeOutputV2CoreSchema.shape.proactiveItems,
});

/**
 * LinkerSceneJudge 合并输出归一化
 */
function normalizeLinkerSceneJudgeOutput(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const obj = normalizeKeysToCamel(input) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...obj };
  if (obj.links !== undefined && obj.linkedFacts === undefined) {
    result.linkedFacts = obj.links;
  }
  if (obj.mergeSuggestions !== undefined && obj.mergedObjects === undefined) {
    result.mergedObjects = obj.mergeSuggestions;
  }
  result.linkedFacts = normalizeLinkerLinks(result.linkedFacts);
  result.newObjects = normalizeLinkerNewObjects(result.newObjects);
  result.mergedObjects = normalizeLinkerMergeSuggestions(result.mergedObjects);
  result.scenes = normalizeSceneBuilderScenes(result.scenes);
  result.unfinishedThreads = normalizeUnfinishedThreads(result.unfinishedThreads);
  result.proactiveItems = normalizeProactiveItemsV2(result.proactiveItems);
  return result;
}

/**
 * 导出的 LinkerSceneJudge 合并 schema
 */
export const LinkerSceneJudgeOutputSchema = z.preprocess(
  normalizeLinkerSceneJudgeOutput,
  LinkerSceneJudgeOutputCoreSchema
);

/**
 * LinkerSceneJudge 合并输出类型
 */
export type LinkerSceneJudgeOutput = z.infer<typeof LinkerSceneJudgeOutputCoreSchema>;

// ==================== Debug Schemas ====================

export const DebugListJobsInputSchema = z.object({
  startAt: z.string(),
  endAt: z.string(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const DebugRelatedRecordsInputSchema = z.object({
  createdAt: z.string(),
  windowSeconds: z.number().int().min(1).max(300).optional(),
});
