// src/renderer/state/types.ts
// Renderer 端领域类型与 AppState 组合类型。
//
// 这些类型原先和 store 实现挤在同一个文件里。拆出来是为了让 slices/* 都能
// import 而不产生环：slice 只依赖 types，types 不依赖任何 slice。
import type { UnfinishedThread } from "../../shared/types";
import type { ReportRequirements } from "../../shared/reportRequirements";

export type PageKey =
  | "today"
  | "reminders"
  | "tasks"
  | "projects"
  | "reports"
  | "memory"
  | "people"
  | "settings"
  | "trust"
  | "debug";

// ============================================================================
// Renderer 端领域类型（与 main/models/types.ts 结构保持一致）
// 不直接 import main 类型，保持进程边界
// ============================================================================

export interface ObservationItem {
  id: string;
  captureId: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  urlOrDomain: string | null;
  captureReason: string;
  sceneSummary: string;
  sensitivity: string;
  confidence: number;
  createdAt: string;
}

export interface FactItem {
  id: string;
  type: string;
  content: string;
  status: string | null;
  projectId: string | null;
  projectHint: string | null;
  importance: number;
  confidence: number;
  inferred: boolean;
  evidenceText: string | null;
  sourceObservationIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface SceneItem {
  id: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  confidence: number;
  factIds: string[];
  observationIds: string[];
  entityNames: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface TaskItem {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  summary: string | null;
  dueHint: string | null;
  priority: number;
  confidence: number;
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  /** 003 字段：标记仅由被删 facts 支撑的对象 */
  orphanStatus?: string | null;
}

export interface DecisionItem {
  id: string;
  title: string;
  decision: string;
  projectId: string | null;
  rationale: string | null;
  confidence: number;
  sourceFactIds: string[];
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** 003 字段：标记仅由被删 facts 支撑的对象 */
  orphanStatus?: string | null;
}

export interface ProjectItem {
  id: string;
  name: string;
  summary: string;
  status: string;
  lastActiveAt: string | null;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** 003 字段：标记仅由被删 facts 支撑的对象 */
  orphanStatus?: string | null;
  /** 012 字段：别名列表（合并过的旧名字） */
  aliases?: string[];
  admissionStatus?: "promoted" | "candidate" | "rejected";
  admissionReason?: string | null;
  admissionEvidence?: Array<{
    factId: string;
    kind: string;
    episodeIds: string[];
  }>;
  admissionDecidedBy?: "legacy" | "auto" | "user";
  admissionReviewedAt?: string | null;
}

export interface PersonItem {
  id: string;
  name: string;
  role: string | null;
  organization: string | null;
  summary: string;
  relatedProjectIds: string[];
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** 022 字段：用户与该人物的关系（手动编辑，如"同事""客户""朋友"） */
  relationship: string | null;
  /** 012 字段：别名列表（合并过的旧名字） */
  aliases?: string[];
  admissionStatus?: "promoted" | "candidate" | "rejected";
  admissionReason?: string | null;
  admissionEvidence?: Array<{
    factId: string;
    kind: string;
    episodeIds: string[];
  }>;
  admissionDecidedBy?: "legacy" | "auto" | "user";
  admissionReviewedAt?: string | null;
}

export interface ReminderItem {
  id: string;
  type: string;
  title: string;
  body: string;
  reason: string;
  priority: number;
  surface: string;
  requiresUserConfirmation: boolean;
  status: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 今日记忆数据（来自 memory:listToday IPC 返回）
 */
export interface TodayData {
  observations: ObservationItem[];
  facts: FactItem[];
  scenes: SceneItem[];
  tasks: TaskItem[];
  decisions: DecisionItem[];
  people: PersonItem[];
  projects: ProjectItem[];
}

// ============================================================================
// M7 新增类型：搜索结果 / 问答结果 / 项目详情 / 用户纠错
// ============================================================================

/**
 * 搜索结果类型（与 main 端 MemorySearchResult 一致）
 */
export interface SearchResultItem {
  id: string;
  type: "fact" | "scene" | "task" | "project" | "decision" | "report" | "person" | "record";
  title: string;
  summary?: string;
  createdAt: string;
  projectName?: string;
  projectId?: string | null;
  sourceType?: "observation" | "fact" | "scene" | "project" | "report";
  sourceId?: string | null;
  relevance?: number;
  matchReasons: string[];
  sourceCount: number;
}

export interface SearchFilters {
  timePreset?: "all" | "today" | "week" | "month";
  timeFrom?: string;
  timeTo?: string;
  projectId?: string;
  type?: SearchResultItem["type"];
  personId?: string;
}

export interface MemoryDetailSource {
  id: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  url: string | null;
  summary: string;
  visibleContent: Array<{ type: string; summary: string; fullText: string; keyTextSnippets: string[] }>;
  screenshotState: "available" | "expired" | "none";
  screenshotCount: number;
}

export interface MemoryDetail {
  id: string;
  type: SearchResultItem["type"] | "timeline";
  title: string;
  summary: string;
  createdAt: string;
  projectId: string | null;
  projectName: string | null;
  fields: Array<{ label: string; value: string }>;
  contentSections: Array<{ title: string; text: string; items: string[] }>;
  sources: MemoryDetailSource[];
  relations: Array<{ id: string; type: SearchResultItem["type"]; title: string; summary?: string }>;
  correctionType: FeedbackTargetType | null;
}

/**
 * 轻量问答来源对象
 */
export interface AskSourceItem {
  id: string;
  type: SearchResultItem["type"];
  title: string;
  summary?: string;
  createdAt: string;
  projectName?: string;
  projectId?: string | null;
  sourceType?: SearchResultItem["sourceType"];
  sourceId?: string | null;
  relevance?: number;
  matchReasons: string[];
  sourceCount: number;
}

/**
 * 轻量问答结果
 */
export interface AskResult {
  ok: boolean;
  mode?: "summary" | "answer";
  answer?: string;
  caveat?: string;
  sources?: AskSourceItem[];
  candidateCount?: number;
  code?: string;
  message?: string;
}

/**
 * 项目详情（聚合 project + facts + scenes + tasks + decisions + people + recentReports）
 */
export interface ProjectDetail {
  project: ProjectItem;
  facts: FactItem[];
  scenes: SceneItem[];
  tasks: TaskItem[];
  decisions: DecisionItem[];
  people: PersonItem[];
  recentReports: Array<{
    id: string;
    type: string;
    dateKey: string;
    title: string;
    contentJson: string;
    sourceFactIds: string[];
    sourceSceneIds: string[];
    createdAt: string;
    updatedAt: string;
    /** 003 字段：是否需要重新生成 */
    isStale?: number;
    /** 003 字段：stale 原因 */
    staleReason?: string | null;
    /** 003 字段：stale 标记时间 */
    staleAt?: string | null;
  }>;
  /** Dedicated unfinished threads, when the IPC aggregate provides them. */
  unfinishedThreads?: UnfinishedThread[];
}

/**
 * 用户纠错类型（与 main 端 UserFeedbackInputSchema 一致）
 */
export type FeedbackType =
  | "content_wrong"
  | "not_important"
  | "wrong_project"
  | "task_done"
  | "not_a_task"
  | "do_not_record"
  | "sensitive_delete";

/**
 * 用户纠错目标类型
 */
export type FeedbackTargetType =
  | "fact"
  | "task"
  | "scene"
  | "project"
  | "person"
  | "decision"
  | "reminder";

// ============================================================================
// M8 新增类型：模型配置 / 隐私规则 / 应用设置 / 数据导出
// ============================================================================

/**
 * 模型配置（renderer 端类型，不含 API Key）
 */
export interface ModelConfigItem {
  id: string;
  kind: "vision" | "language" | "multimodal";
  providerName: string;
  endpoint: string;
  model: string;
  optionsJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 隐私规则
 */
export interface PrivacyRuleItem {
  id: string;
  type: "app_name" | "window_title_keyword" | "domain_keyword";
  pattern: string;
  action: "exclude" | "ask_before_capture" | "blur_sensitive";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 截图保留策略
 */
export type ScreenshotRetentionPolicy =
  | "delete_immediately"
  | "1h"
  | "6h"
  | "today"
  | "3d"
  | "7d";

/**
 * 应用设置（renderer 端镜像，与 main/models/types.ts AppSettings 一致）
 */
export interface AppSettingsState {
  observation: {
    enabled: boolean;
    activeWindowStableSeconds: number;
    contentChangeMinIntervalSeconds: number;
    longSessionIntervalMinutes: number;
    idleThresholdSeconds: number;
  };
  screenshot: {
    retentionPolicy: ScreenshotRetentionPolicy;
  };
  notification: {
    inAppReminders: boolean;
    desktopNotifications: boolean;
    dailyReportTime: string;
    weeklyReportTime: string;
  };
  endOfDayReview: {
    enabled: boolean;
    firstTime: string;
    secondTime: string;
  };
  dailyReport: {
    autoGenerate: boolean;
    time: string;
  };
  personalReview: {
    autoGenerate: boolean;
    time: string;
  };
  reportRequirements: ReportRequirements;
  defaultModelService: {
    consent: "pending" | "accepted" | "declined";
    acceptedAt: string | null;
  };
  onboardingCompleted: boolean;
  debug: {
    enabled: boolean;
    verboseModelIO: boolean;
  };
}

/**
 * DebugPage：model_jobs 列表项摘要（与 main ModelJob 对齐，renderer 端镜像）
 */
export interface DebugJobSummary {
  id: string;
  type: string;
  status: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  /** 丢弃事件数量（从 debugEventsJson 解析，null/无事件为 0） */
  debugEventCount: number;
  /** 脱敏后的输入摘要 JSON（含 imageCount/frameCount/hasStitchedImage 等），用于统计图片数和 OCR 状态 */
  inputJson: string;
}

/**
 * DebugPage：model_job 详情（含完整 rawInputJson / debugEventsJson / outputJson）
 */
export interface DebugJobDetails {
  id: string;
  type: string;
  status: string;
  inputJson: string;
  outputJson: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  rawInputJson: string | null;
  debugEventsJson: string | null;
}

/**
 * DebugPage：关联落库记录
 */
export interface DebugRelatedRecords {
  observations: unknown[];
  facts: unknown[];
  scenes: unknown[];
  proactiveItems: unknown[];
}

/**
 * Debug 丢弃事件（与 main DebugEvent 对齐）
 */
export interface DebugEventItem {
  layer: "L0" | "L1" | "L2" | "L3" | "proactive";
  action: "discard" | "skip" | "dedup" | "downgrade" | "fallback";
  reason: string;
  itemId?: string;
  frameIndex?: number;
  targetType?: string;
}

/**
 * 数据导出结果
 */
export interface DataExportResult {
  meta: {
    schemaVersion: string;
    appVersion: string;
    exportedAt: string;
    includeScreenshots: boolean;
    screenshotSemantics: "references" | "excluded";
    counts: Record<string, number>;
  };
  observations: unknown[];
  facts: unknown[];
  scenes: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  people: unknown[];
  projects: unknown[];
  reports: unknown[];
  proactiveItems: unknown[];
  timelineBlocks: unknown[];
  unfinishedThreads: unknown[];
  reportSelections: unknown[];
  objectMerges: unknown[];
  memoryEdges: unknown[];
}

/**
 * 报告条目（reports 表的 renderer 端镜像，与 main/models/types.ts Report 结构一致）
 * 涵盖 daily / weekly / monthly / retrospective 等所有 type。
 */
export interface ReportItem {
  id: string;
  type: string;
  dateKey: string;
  title: string;
  contentJson: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
  /** 12.5/22.11：报告来源被 soft delete 后标记为 stale（1=失效） */
  isStale?: number;
  staleReason?: string | null;
  staleAt?: string | null;
  /** 010 字段：关联项目 ID（用于历史报告按项目过滤） */
  projectId?: string | null;
}

export type ReportsTabKey =
  | "personal"
  | "work"
  | "weekly"
  | "monthly"
  | "history";

// ============================================================================
// AppState：各 slice 接口的并集
//
// 对外仍是一个扁平的 store —— 页面照旧 useAppStore((s) => s.loadToday)，
// 不需要知道成员来自哪个 slice。切片只是实现层的组织方式。
// ============================================================================

import type { ShellSlice } from "./slices/shell";
import type { TodaySlice } from "./slices/today";
import type { RemindersSlice } from "./slices/reminders";
import type { SearchSlice } from "./slices/search";
import type { ObjectsSlice } from "./slices/objects";
import type { SettingsSlice } from "./slices/settings";
import type { ReportsSlice } from "./slices/reports";
import type { DebugSlice } from "./slices/debug";

export type AppState = ShellSlice &
  TodaySlice &
  RemindersSlice &
  SearchSlice &
  ObjectsSlice &
  SettingsSlice &
  ReportsSlice &
  DebugSlice;

/**
 * slice 创建函数的签名。
 *
 * 第二个类型参数固定为完整 AppState：这样每个 slice 里的 get() 都能读到别的域，
 * 而 set() 依然是浅合并整个 store。zustand 的标准 slice 模式。
 */
import type { StateCreator } from "zustand";
export type AppSliceCreator<T> = StateCreator<AppState, [], [], T>;
