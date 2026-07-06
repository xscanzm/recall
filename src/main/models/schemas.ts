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

/**
 * 设置更新 IPC 参数 schema（宽松结构，运行时再细化）
 */
export const SettingsUpdateSchema = z.record(z.string(), z.unknown());

/**
 * 模型配置测试 IPC 参数 schema
 */
export const ModelTestConnectionInputSchema = z.object({
  kind: z.enum(["vision", "language"]),
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
  kind: z.enum(["vision", "language"]),
  providerName: z.string().min(1).max(120),
  endpoint: z.string().url(),
  model: z.string().min(1).max(120),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
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
 * - includeScreenshots：是否包含截图（默认 false）
 *   注意：截图以文件路径形式导出，不会嵌入 JSON；包含截图时仅导出 observation.screenshotPaths
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
  type: z.enum(["daily", "weekly", "retrospective"]),
  dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

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
  sources: z.array(
    z.object({
      id: z.string(),
      type: z.enum(["fact", "scene", "task", "project", "decision", "report", "person"]),
      title: z.string(),
      summary: z.string().optional(),
    })
  ),
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
export const LinkerOutputSchema = z.object({
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

/**
 * L2 SceneBuilderOutput：场景聚合模型输出
 */
export const SceneBuilderOutputSchema = z.object({
  scenes: z.array(
    z.object({
      title: TitleSchema,
      summary: SummarySchema,
      startAt: z.string(),
      endAt: z.string(),
      projectHint: TitleSchema.optional(),
      factIds: z.array(z.string()),
      entityNames: z.array(TitleSchema),
      taskIds: z.array(z.string()),
      decisionIds: z.array(z.string()),
      confidence: ConfidenceSchema,
    })
  ),
});

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
 */
export const DailyReportOutputSchema = z.object({
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
export const WeeklyReportOutputSchema = z.object({
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

/**
 * 全部模型输出 schema 注册表
 * 用于 JSON repair prompt 生成与运行时校验
 */
export const MODEL_OUTPUT_SCHEMAS = {
  vision_observation: VisionObservationOutputSchema,
  extractor: ExtractorOutputSchema,
  linker: LinkerOutputSchema,
  scene_builder: SceneBuilderOutputSchema,
  judge: JudgeOutputSchema,
  daily_report: DailyReportOutputSchema,
  weekly_report: WeeklyReportOutputSchema,
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
export type LinkerOutput = z.infer<typeof LinkerOutputSchema>;
export type SceneBuilderOutput = z.infer<typeof SceneBuilderOutputSchema>;
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
export type DailyReportOutput = z.infer<typeof DailyReportOutputSchema>;
export type WeeklyReportOutput = z.infer<typeof WeeklyReportOutputSchema>;
