// src/renderer/state/store.ts
// 全局状态管理（Zustand）
//
// M0：维护 AppStatus、当前激活页面、首次启动标志
// M5：扩展 todayData（今日记忆数据）、reminders（提醒列表）、加载动作
// M7：扩展 tasks/projects/search/ask/projectDetail 状态和动作
// M8：扩展 modelConfigs/privacyRules/settings 状态与 CRUD 动作、数据导出/清空

import { create } from "zustand";
import type {
  AppStatus,
  TodayPageData,
  PersonalReview,
  WorkReport,
  UnfinishedThread,
  ReportGeneratedEvent,
} from "../../shared/types";
import type { UpdateStatus, DownloadProgress } from "../../shared/updateTypes";
import type { ReportRequirements } from "../../shared/reportRequirements";
import { getIpc, fetchTodayPageData } from "./ipc";
import { dailyReportRecordToWorkReport } from "./reportAdapters";
import { isCurrentTodayPageRequest, shouldRollOverTodayDate } from "./todayNavigation";
import { clearAllDataAction, clearScreenshotsOnlyAction, exportDataAction, forgetRecentAction, getCacheSizeAction, searchMemoryAction } from "./searchDataActions";

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

const EMPTY_TODAY: TodayData = {
  observations: [],
  facts: [],
  scenes: [],
  tasks: [],
  decisions: [],
  people: [],
  projects: [],
};

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

const UNREAD_REPORTS_STORAGE_KEY = "recall.unread-reports.v1";

function readStoredUnreadReports(): ReportGeneratedEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UNREAD_REPORTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReportGeneratedEvent => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return (
        typeof value.reportId === "string" &&
        typeof value.type === "string" &&
        typeof value.title === "string" &&
        typeof value.dateKey === "string"
      );
    }).slice(0, 50);
  } catch {
    return [];
  }
}

function persistUnreadReports(reports: ReportGeneratedEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UNREAD_REPORTS_STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // localStorage 不可用时不影响报告生成和页面展示。
  }
}

/**
 * 报告页 Tab key（Phase 4，doc 23）
 */
export type ReportsTabKey =
  | "personal"
  | "work"
  | "weekly"
  | "monthly"
  | "history";

interface AppState {
  // 状态
  appStatus: AppStatus;
  currentPage: PageKey;
  isReady: boolean; // AppStatus 是否已通过 IPC 加载完成
  error: string | null;

  // 跨页面跳转：源记录 ID 和类型（用于搜索结果跳转到今日页等场景）
  pendingJumpId: string | null;
  pendingJumpType: string | null;

  // 今日数据
  todayData: TodayData;
  todayLoading: boolean;
  todayError: string | null;
  todayLoadedAt: number | null;

  // 提醒数据
  reminders: ReminderItem[];
  remindersLoading: boolean;
  remindersError: string | null;
  remindersLoadedAt: number | null;

  // M7 新增：搜索结果
  searchQuery: string;
  searchResults: SearchResultItem[];
  searchTotal: number;
  searchQuality: "strong" | "weak" | "none";
  searchQueryTerms: string[];
  searchFilters: SearchFilters;
  searchExpandedTerms: string[];
  searchExpandLoading: boolean;
  searchExpandError: string | null;
  searchLoading: boolean;
  searchError: string | null;
  searchSearched: boolean; // 是否已执行过搜索

  followupQuestion: string;
  aiMode: "summary" | "answer" | null;
  aiResult: AskResult | null;
  aiLoading: boolean;
  aiError: string | null;

  // M7 新增：项目详情
  projectDetail: ProjectDetail | null;
  projectDetailLoading: boolean;
  projectDetailError: string | null;

  // M8 新增：模型配置
  modelConfigs: ModelConfigItem[];
  modelConfigsLoading: boolean;
  modelConfigsError: string | null;

  // M8 新增：隐私规则
  privacyRules: PrivacyRuleItem[];
  privacyRulesLoading: boolean;
  privacyRulesError: string | null;

  // M8 新增：应用设置
  settings: AppSettingsState | null;
  settingsLoading: boolean;
  settingsError: string | null;

  // 版本更新
  updateStatus: UpdateStatus;
  currentVersion: string;

  // Phase 3 新增：今日页（doc 21）完整数据与工作日报选择模式
  todayPageData: TodayPageData | null;
  todayPageLoading: boolean;
  todayPageError: string | null;
  timelineBuildingDateKey: string | null;
  lastTimelineBuildAt: number;
  todayPageDateKey: string;
  todayPageFollowingToday: boolean;
  workReportSelectionMode: boolean;
  selectedBlockIds: string[];
  ignoredBlockIds: string[];
  workReportGenerating: boolean;
  workReportError: string | null;
  workReportStyle: "brief" | "standard" | "formal";
  workReportGenerationRequirement: string;
  previewModalOpen: boolean;
  personalReviewGenerating: boolean;
  personalReviewError: string | null;
  sidePanelDrawerOpen: boolean;

  // Phase 7 新增：设置页 / 信任中心 UI 状态
  /** 设置页当前激活的分区 tab（all | model | observation | screenshot | blacklist | notification | data） */
  settingsTab: string;
  /** 数据管理操作执行中（用于禁用按钮 + loading） */
  clearingData: boolean;
  /** 危险操作二次确认对话框是否显示 */
  showConfirmDialog: boolean;
  /** 确认对话框标题 */
  confirmDialogTitle: string;
  /** 确认对话框正文 */
  confirmDialogMessage: string;
  /** 确认对话框按钮文案（默认"确认"） */
  confirmDialogConfirmText: string;
  /** 用户确认后执行的回调 */
  confirmAction: (() => void) | null;

  // Phase 5 新增：待收尾页状态（doc 24）
  unfinishedThreads: UnfinishedThread[];
  unfinishedLoading: boolean;
  unfinishedError: string | null;

  // Phase 4 新增：报告页状态（doc 23）
  /** 报告页当前 Tab：我的复盘 / 工作日报 / 周报 / 月报 / 历史 */
  reportsTab: ReportsTabKey;
  /** 报告页当前选中的日期 key（YYYY-MM-DD） */
  reportsDateKey: string;
  /**
   * 报告页 dateKey 是否被用户主动设置（prev/next/date-input）
   * - true：跨日回滚不会覆盖（保留用户选择的历史日期）
   * - false：跨日回滚可以触发（自动滚动到今天）
   * - load 成功且 current === today 时 reset 为 false（让"打开应用后跨日回滚能工作"）
   */
  reportsDateKeySetByUser: boolean;
  /** 报告页周报 Tab 选中的周起始 dateKey（YYYY-MM-DD，周一） */
  reportsWeekStart: string;
  /** 报告页月报 Tab 选中的月份 key（YYYY-MM） */
  reportsMonthKey: string;
  /** 当前查看的个人复盘（与 todayPageData.personalReview 区分，专供报告页使用） */
  personalReview: PersonalReview | null;
  /** 当前查看的工作日报（与 todayPageData.workReport 区分，专供报告页使用） */
  workReport: WorkReport | null;
  /** 正式报告生成后尚未进入报告页查看的报告。 */
  unreadReports: ReportGeneratedEvent[];
  /** 历史 Tab 的报告列表 */
  reportsList: ReportItem[];
  /** 报告页加载状态 */
  reportsLoading: boolean;
  /** 报告页错误信息 */
  reportsError: string | null;
  /** 报告编辑器是否处于编辑模式 */
  reportEditing: boolean;
  /** 报告编辑器草稿内容（plain text） */
  reportDraft: string;
  /** 历史报告列表过滤：类型（"all" | "daily" | "weekly" | "monthly" | "retrospective"） */
  reportsHistoryTypeFilter: string;
  /** 历史报告列表过滤：起始 dateKey */
  reportsHistoryDateFrom: string;
  /** 历史报告列表过滤：结束 dateKey */
  reportsHistoryDateTo: string;
  /** 历史报告列表过滤：项目 ID（"all" 或具体 projectId） */
  reportsHistoryProjectFilter: string;

  /** 项目页筛选：关键词 / 状态 / 排序 */
  projectsFilters: {
    keyword: string;
    status: "all" | "active" | "archived";
    sortBy: "lastActiveAt" | "createdAt" | "name";
  };
  /** 人物页筛选：关键词 / 关联项目 / 排序 */
  peopleFilters: {
    keyword: string;
    projectId: string;
    sortBy: "updatedAt" | "createdAt" | "name";
  };

  // 调试模式：DebugPage 数据
  debugJobs: DebugJobSummary[] | null;
  debugJobsLoading: boolean;
  debugJobsError: string | null;
  debugJobDetails: DebugJobDetails | null;
  debugJobDetailsLoading: boolean;
  debugRelatedRecords: DebugRelatedRecords | null;
  debugRelatedRecordsLoading: boolean;
  debugFilters: {
    startAt: string;
    endAt: string;
    jobType: string;
    status: string;
  };

  // 动作
  setAppStatus: (status: AppStatus) => void;
  setPage: (page: PageKey) => void;
  setReady: (ready: boolean) => void;
  setError: (error: string | null) => void;

  // 跨页面跳转动作
  setPendingJump: (id: string, type: string) => void;
  clearPendingJump: () => void;

  loadToday: () => Promise<void>;
  loadReminders: () => Promise<void>;
  updateReminderStatus: (id: string, status: string) => Promise<void>;

  // M7 新增：搜索 / 问答 / 项目详情 / 任务更新 / 删除 / 纠错 / 合并 / 忘掉最近
  searchMemory: (query: string, limit?: number, offset?: number, filters?: SearchFilters) => Promise<void>;
  expandSearch: (query: string, filters?: SearchFilters) => Promise<void>;
  setFollowupQuestion: (question: string) => void;
  analyzeMemory: (mode: "summary" | "answer", candidates: Array<{ id: string; type: SearchResultItem["type"] }>, question?: string) => Promise<void>;
  loadProjectDetail: (id: string) => Promise<void>;
  clearProjectDetail: () => void;
  updateTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
  updatePerson: (id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteObject: (id: string, type: string) => Promise<void>;
  createUserFeedback: (input: {
    targetType: FeedbackTargetType;
    targetId: string;
    feedbackType: FeedbackType;
    note?: string;
    patch?: Record<string, unknown>;
  }) => Promise<void>;
  mergeObjects: (input: {
    objectType: "project" | "task" | "person" | "decision";
    fromId: string;
    toId: string;
    reason?: string;
  }) => Promise<{
    rewrittenFactsCount: number;
    rewrittenScenesCount: number;
    mergedAliases: string[];
  }>;

  // 012/013 新增：合并建议（来自 Linker）
  mergeSuggestions: unknown[];
  mergeSuggestionsLoading: boolean;
  loadMergeSuggestions: () => Promise<void>;
  rejectMergeSuggestion: (id: string) => Promise<void>;
  // 012/013 新增：别名映射
  loadAllAliases: () => Promise<void>;
  allAliases: {
    projects: Array<{ id: string; name: string; aliases: string[] }>;
    people: Array<{ id: string; name: string; aliases: string[] }>;
  } | null;
  forgetRecent: (duration: "15m" | "30m" | "1h" | "today") => Promise<{
    deletedObservations: number;
    deletedScreenshots: number;
  }>;

  // M8 新增：模型配置 CRUD
  loadModelConfigs: () => Promise<void>;
  saveModelConfig: (input: {
    id?: string;
    kind: "vision" | "language" | "multimodal";
    providerName: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    enabled?: boolean;
    // Phase 7：可选字段，留空时使用模型默认值（后端写入 options_json）
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ ok: boolean; warning?: string; error?: string }>;
  deleteModelConfig: (id: string) => Promise<{ ok: boolean; error?: string }>;
  testModelConnection: (input: {
    kind: "vision" | "language" | "multimodal";
    endpoint: string;
    model: string;
    apiKey: string;
  }) => Promise<{ ok: boolean; code?: string; message?: string }>;

  // M8 新增：隐私规则 CRUD
  loadPrivacyRules: () => Promise<void>;
  addPrivacyRule: (input: {
    type: PrivacyRuleItem["type"];
    pattern: string;
    action: PrivacyRuleItem["action"];
    enabled?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  updatePrivacyRule: (
    id: string,
    patch: Partial<Pick<PrivacyRuleItem, "pattern" | "action" | "enabled">>
  ) => Promise<{ ok: boolean; error?: string }>;
  deletePrivacyRule: (id: string) => Promise<{ ok: boolean; error?: string }>;

  // M8 新增：应用设置
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettingsState>) => Promise<{ ok: boolean; error?: string }>;

  // 版本更新
  loadUpdateStatus: () => Promise<void>;
  loadCurrentVersion: () => Promise<void>;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdateVersion: (version: string) => Promise<void>;
  setUpdateStatus: (status: UpdateStatus) => void;
  setDownloadProgress: (progress: DownloadProgress) => void;

  // M8 新增：数据导出 / 清空 / 缓存大小
  exportData: (input: { includeScreenshots?: boolean }) => Promise<{
    ok: boolean;
    data?: DataExportResult;
    error?: string;
  }>;
  clearAllData: () => Promise<{ ok: boolean; deletedScreenshots?: number; error?: string }>;
  /** 仅清空截图文件，不删除结构化记忆（调用 screenshot:clear IPC） */
  clearScreenshotsOnly: () => Promise<{ ok: boolean; deletedScreenshots?: number; error?: string }>;
  getCacheSize: () => Promise<{ ok: boolean; bytes: number; fileCount: number }>;

  // Phase 3 新增：今日页 actions
  loadTodayPageData: (dateKey: string) => Promise<void>;
  refreshTodayPageData: () => Promise<void>;
  setTodayPageDateKey: (dateKey: string) => void;
  /**
   * 跨日检测：dateKey 不是今天时自动滚动到今天 + 重新加载
   * 返回 true 表示发生了滚动
   */
  rollOverTodayDateKeyIfNeeded: () => boolean;
  buildTimeline: (dateKey: string) => Promise<void>;
  reorganizeTimelineDay: (dateKey: string) => Promise<void>;
  generatePersonalReview: (
    dateKey: string,
    generationRequirement?: string
  ) => Promise<boolean>;
  generateWorkReport: (params: {
    dateKey: string;
    selectedBlockIds: string[];
    style: "brief" | "standard" | "formal";
    recipientHint?: "manager" | "team" | "client" | "self";
    generationRequirement?: string;
  }) => Promise<boolean>;
  saveReportSelection: (params: {
    dateKey: string;
    selectedBlockIds: string[];
    excludedBlockIds: string[];
  }) => Promise<void>;
  setWorkReportSelectionMode: (enabled: boolean) => void;
  enterSelectionWithBlock: (blockId: string) => void;
  toggleBlockSelection: (blockId: string) => void;
  selectAllWorkBlocks: () => void;
  clearSelection: () => void;
  setWorkReportStyle: (style: "brief" | "standard" | "formal") => void;
  setWorkReportGenerationRequirement: (requirement: string) => void;
  setPreviewModalOpen: (open: boolean) => void;
  setSidePanelDrawerOpen: (open: boolean) => void;
  ignoreTimelineBlock: (id: string) => void;
  updateUnfinishedThreadStatus: (
    id: string,
    status: "open" | "done" | "snoozed" | "ignored"
  ) => Promise<void>;

  // Phase 5 新增：待收尾页 actions
  loadUnfinishedThreads: () => Promise<void>;
  updateUnfinishedStatus: (
    id: string,
    status: "open" | "done" | "snoozed" | "ignored"
  ) => Promise<void>;

  // Phase 4 新增：报告页 actions（doc 23）
  /** 切换报告页 Tab */
  setReportsTab: (tab: ReportsTabKey) => void;
  /** 设置报告页当前日期 */
  setReportsDateKey: (dateKey: string) => void;
  /**
   * 跨日检测：reportsDateKey 跨过零点时自动滚动到今天并重新加载当前 Tab 数据
   * - 仅当 reportsDateKeySetByUser = false 时才回滚（避免覆盖用户主动选择的历史日期）
   */
  rollOverReportsDateKeyIfNeeded: () => boolean;
  /**
   * 标记 dateKey 已被用户主动设置（prev/next/date-input）
   */
  markReportsDateKeySetByUser: () => void;
  /**
   * 清除 user-changed 标记
   * - load 成功后 + current === today 时调用（让跨日回滚能正常工作）
   */
  resetReportsDateKeyUserFlag: () => void;
  /**
   * "默认显示最近一份有的复盘"：
   * - 如果当前 dateKey 没有复盘/日报，自动切到 ≤ today 的最近一份
   * - 如果用户主动改过 dateKey，不强制回退
   */
  fallbackToLatestReportIfMissing: () => Promise<void>;
  /** 设置报告页周起始 */
  setReportsWeekStart: (dateKey: string) => void;
  /** 设置报告页月份 key */
  setReportsMonthKey: (monthKey: string) => void;
  /** 收到新的正式报告事件，更新右上角未读提醒。 */
  addUnreadReport: (report: ReportGeneratedEvent) => void;
  /** 用户进入报告页或点击提醒后清除未读报告。 */
  markUnreadReportsRead: () => void;
  /** 加载指定日期的个人复盘（专供报告页使用，写入 state.personalReview） */
  loadPersonalReview: (dateKey: string) => Promise<void>;
  /** 加载指定日期的工作日报（专供报告页使用，写入 state.workReport） */
  loadWorkReport: (dateKey: string) => Promise<void>;
  /** 加载历史报告列表（支持类型/日期范围过滤） */
  loadReportsList: (filters?: {
    type?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }) => Promise<void>;
  /** 更新报告内容（编辑后保存，content 为 plain text，内部包装为 contentJson） */
  updateReport: (id: string, content: string) => Promise<void>;
  /** 物理删除报告（调用 reports:delete IPC） */
  deleteReport: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 进入/退出报告编辑模式 */
  setReportEditing: (editing: boolean) => void;
  /** 设置报告编辑草稿 */
  setReportDraft: (draft: string) => void;
  /** 设置历史报告过滤：类型 */
  setReportsHistoryTypeFilter: (type: string) => void;
  /** 设置历史报告过滤：起始日期 */
  setReportsHistoryDateFrom: (dateKey: string) => void;
  /** 设置历史报告过滤：结束日期 */
  setReportsHistoryDateTo: (dateKey: string) => void;
  /** 设置历史报告过滤：项目 */
  setReportsHistoryProjectFilter: (projectId: string) => void;
  /** 设置项目页筛选（部分更新） */
  setProjectsFilters: (patch: Partial<{ keyword: string; status: "all" | "active" | "archived"; sortBy: "lastActiveAt" | "createdAt" | "name" }>) => void;
  /** 设置人物页筛选（部分更新） */
  setPeopleFilters: (patch: Partial<{ keyword: string; projectId: string; sortBy: "updatedAt" | "createdAt" | "name" }>) => void;

  // Phase 7 新增：设置页 / 信任中心 UI actions
  /** 切换设置页激活分区 */
  setSettingsTab: (tab: string) => void;
  /** 标记数据管理操作执行中 / 完成 */
  setClearingData: (clearing: boolean) => void;
  /**
   * 发起危险操作二次确认。
   * 调用后弹出确认对话框，用户点击确认时执行 onConfirm，取消则关闭对话框。
   */
  requestConfirm: (input: {
    title: string;
    message: string;
    confirmText?: string;
    onConfirm: () => void;
  }) => void;
  /** 关闭确认对话框（取消） */
  closeConfirmDialog: () => void;
  /** 执行确认对话框的确认动作 */
  executeConfirm: () => void;

  // 调试模式 actions
  loadDebugJobs: () => Promise<void>;
  loadDebugJobDetails: (jobId: string) => Promise<void>;
  loadDebugRelatedRecords: (createdAt: string) => Promise<void>;
  setDebugFilters: (patch: Partial<{ startAt: string; endAt: string; jobType: string; status: string }>) => void;
  clearDebugState: () => void;
}

let latestTodayPageRequestId = 0;

/**
 * 默认 AppStatus（与 main 进程 createInitialAppStatus 保持一致）
 */
const DEFAULT_APP_STATUS: AppStatus = {
  observing: false,
  paused: false,
  pipelineState: "idle",
};

/**
 * 默认更新状态
 */
const DEFAULT_UPDATE_STATUS: UpdateStatus = { state: "idle" };

/**
 * 生成当今日 dateKey（YYYY-MM-DD，本地时区）
 */
function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 将 Date 格式化为 dateKey（YYYY-MM-DD，本地时区）
 */
function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 获取本周一 dateKey（YYYY-MM-DD，本地时区）
 */
function currentWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  return formatDateKey(monday);
}

/**
 * 获取本月 monthKey（YYYY-MM，本地时区）
 */
function currentMonthKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

export const useAppStore = create<AppState>((set, get) => ({
  appStatus: DEFAULT_APP_STATUS,
  currentPage: "today",
  isReady: false,
  error: null,

  // 跨页面跳转初始状态
  pendingJumpId: null,
  pendingJumpType: null,

  todayData: EMPTY_TODAY,
  todayLoading: false,
  todayError: null,
  todayLoadedAt: null,

  reminders: [],
  remindersLoading: false,
  remindersError: null,
  remindersLoadedAt: null,

  // M7 新增：搜索状态
  searchQuery: "",
  searchResults: [],
  searchTotal: 0,
  searchQuality: "none",
  searchQueryTerms: [],
  searchFilters: {},
  searchExpandedTerms: [],
  searchExpandLoading: false,
  searchExpandError: null,
  searchLoading: false,
  searchError: null,
  searchSearched: false,

  followupQuestion: "",
  aiMode: null,
  aiResult: null,
  aiLoading: false,
  aiError: null,

  // M7 新增：项目详情
  projectDetail: null,
  projectDetailLoading: false,
  projectDetailError: null,

  // M8 新增：模型配置初始状态
  modelConfigs: [],
  modelConfigsLoading: false,
  modelConfigsError: null,

  // M8 新增：隐私规则初始状态
  privacyRules: [],
  privacyRulesLoading: false,
  privacyRulesError: null,

  // M8 新增：应用设置初始状态
  settings: null,
  settingsLoading: false,
  settingsError: null,

  // 版本更新
  updateStatus: DEFAULT_UPDATE_STATUS,
  currentVersion: "",

  // Phase 3 新增：今日页初始状态
  todayPageData: null,
  todayPageLoading: false,
  todayPageError: null,
  timelineBuildingDateKey: null,
  lastTimelineBuildAt: 0,
  todayPageDateKey: todayDateKey(),
  todayPageFollowingToday: true,
  workReportSelectionMode: false,
  selectedBlockIds: [],
  ignoredBlockIds: [],
  workReportGenerating: false,
  workReportError: null,
  workReportStyle: "standard",
  workReportGenerationRequirement: "",
  previewModalOpen: false,
  personalReviewGenerating: false,
  personalReviewError: null,
  sidePanelDrawerOpen: false,

  // Phase 7 新增：设置页 / 信任中心 UI 初始状态
  settingsTab: "all",
  clearingData: false,
  showConfirmDialog: false,
  confirmDialogTitle: "",
  confirmDialogMessage: "",
  confirmDialogConfirmText: "确认",
  confirmAction: null,

  // Phase 5 新增：待收尾页初始状态
  unfinishedThreads: [],
  unfinishedLoading: false,
  unfinishedError: null,

  // Phase 4 新增：报告页初始状态（doc 23）
  reportsTab: "personal",
  reportsDateKey: todayDateKey(),
  reportsDateKeySetByUser: false,
  reportsWeekStart: currentWeekStart(),
  reportsMonthKey: currentMonthKey(),
  personalReview: null,
  workReport: null,
  unreadReports: readStoredUnreadReports(),
  reportsList: [],
  reportsLoading: false,
  reportsError: null,
  reportEditing: false,
  reportDraft: "",
  reportsHistoryTypeFilter: "all",
  reportsHistoryDateFrom: "",
  reportsHistoryDateTo: "",
  reportsHistoryProjectFilter: "all",

  projectsFilters: {
    keyword: "",
    status: "active",
    sortBy: "lastActiveAt",
  },
  peopleFilters: {
    keyword: "",
    projectId: "",
    sortBy: "updatedAt",
  },

  // 调试模式初始状态
  debugJobs: null,
  debugJobsLoading: false,
  debugJobsError: null,
  debugJobDetails: null,
  debugJobDetailsLoading: false,
  debugRelatedRecords: null,
  debugRelatedRecordsLoading: false,
  debugFilters: {
    startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endAt: new Date().toISOString(),
    jobType: "all",
    status: "all",
  },

  // 012/013 新增：合并建议 + 别名映射
  mergeSuggestions: [],
  mergeSuggestionsLoading: false,
  allAliases: null,

  setAppStatus: (status) => set({ appStatus: status }),
  setPage: (page) => set({ currentPage: page }),
  setReady: (ready) => set({ isReady: ready }),
  setError: (error) => set({ error }),

  // 跨页面跳转动作：设置/清除待跳转的源记录 ID 和类型
  setPendingJump: (id, type) => set({ pendingJumpId: id, pendingJumpType: type }),
  clearPendingJump: () => set({ pendingJumpId: null, pendingJumpType: null }),

  /**
   * 加载今日记忆数据（调用 memory:listToday IPC）
   */
  loadToday: async () => {
    if (get().todayLoading) return;
    set({ todayLoading: true, todayError: null });
    try {
      const data = await getIpc().memory.listToday<TodayData>();
      set({
        todayData: data ?? EMPTY_TODAY,
        todayLoading: false,
        todayLoadedAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ todayLoading: false, todayError: message });
    }
  },

  /**
   * 加载提醒列表（调用 reminders:list IPC）
   */
  loadReminders: async () => {
    if (get().remindersLoading) return;
    set({ remindersLoading: true, remindersError: null });
    try {
      const list = await getIpc().reminders.list<ReminderItem>();
      set({
        reminders: list ?? [],
        remindersLoading: false,
        remindersLoadedAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ remindersLoading: false, remindersError: message });
    }
  },

  /**
   * 更新提醒状态（调用 reminders:updateStatus IPC）
   * 标记完成后任务状态更新
   * 乐观更新：先更新本地状态，失败时回滚到快照
   */
  updateReminderStatus: async (id: string, status: string) => {
    const prev = get().reminders; // 保存快照，用于失败时回滚
    try {
      // 乐观更新本地列表（先于 IPC 调用）
      set({
        reminders: prev.map((r) => (r.id === id ? { ...r, status } : r)),
      });
      await getIpc().reminders.updateStatus({ id, status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 回滚到更新前的快照
      set({ reminders: prev, remindersError: message });
      throw err;
    }
  },

  // ============================================================================
  // M7 新增动作
  // ============================================================================

  /**
   * 搜索记忆（调用 memory:search IPC）
   * 来自 spec.md "记忆库搜索"：
   * - 搜索结果类型：Fact/Scene/Task/Project/Decision/Report
   * - 每条结果显示：类型/标题摘要/时间/项目/来源跳转
   */
  searchMemory: async (query: string, limit = 50, offset = 0, filters = {}) => {
    await searchMemoryAction(set as never, query, limit, offset, filters);
  },

  /**
   * 轻量问答（调用 memory:ask IPC）
   * 来自 spec.md "历史查询与轻量问答"：
   * - 自然语言输入
   * - 检索相关 facts/scenes/reports
   * - LLM 基于检索结果回答
   * - 回答必须列出来源对象
   * - 聊天只是查询入口，不作为主界面
   */
  expandSearch: async (query: string, filters = {}) => {
    if (!query.trim()) return;
    set({ searchExpandLoading: true, searchExpandError: null, aiMode: null, aiResult: null, aiError: null });
    try {
      const result = await getIpc().memory.expandSearch({ query: query.trim(), filters });
      if (!result.ok) {
        set({ searchExpandLoading: false, searchExpandError: result.message });
        return;
      }
      set({ searchResults: result.results, searchTotal: result.total, searchQuality: result.quality, searchExpandedTerms: result.expandedTerms, searchExpandLoading: false, searchSearched: true });
    } catch (err) {
      set({ searchExpandLoading: false, searchExpandError: err instanceof Error ? err.message : String(err) });
    }
  },

  setFollowupQuestion: (question) => set({ followupQuestion: question }),

  analyzeMemory: async (mode, candidates, question) => {
    const normalizedQuestion = question?.trim();
    if (mode === "answer" && !normalizedQuestion) return;
    set({
      aiLoading: true,
      aiError: null,
      aiMode: mode,
      aiResult: null,
      followupQuestion: mode === "answer" ? normalizedQuestion ?? "" : get().followupQuestion,
    });
    try {
      const result = await getIpc().memory.ask({ mode, question: normalizedQuestion, candidates });
      set({
        aiResult: result,
        aiLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        aiLoading: false,
        aiError: message,
        aiResult: { ok: false, code: "unknown_error", message },
      });
    }
  },

  /**
   * 加载项目详情（调用 memory:getProjectDetail IPC）
   * 返回项目主线 + 最近场景 + 任务 + 决策 + 人物 + 报告片段
   */
  loadProjectDetail: async (id: string) => {
    set({ projectDetailLoading: true, projectDetailError: null, projectDetail: null });
    try {
      const detail = await getIpc().memory.getProjectDetail({ id });
      set({
        projectDetail: detail as ProjectDetail,
        projectDetailLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ projectDetailLoading: false, projectDetailError: message });
    }
  },

  /**
   * 清除当前查看的项目详情
   */
  clearProjectDetail: () => {
    set({ projectDetail: null, projectDetailError: null });
  },

  /**
   * 更新任务（调用 memory:updateTask IPC）
   * 重要约束：不覆盖 source ids（由 main 端 handler 控制）
   */
  updateTask: async (id: string, patch: Record<string, unknown>) => {
    try {
      await getIpc().memory.updateTask({ id, ...patch });
      // 乐观更新本地状态（todayData.tasks + projectDetail.tasks）
      const updateTaskInList = (task: TaskItem) =>
        task.id === id ? { ...task, ...patch } : task;
      const today = get().todayData;
      set({
        todayData: {
          ...today,
          tasks: today.tasks.map(updateTaskInList),
        },
      });
      const detail = get().projectDetail;
      if (detail) {
        set({
          projectDetail: {
            ...detail,
            tasks: detail.tasks.map(updateTaskInList),
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 更新人物（调用 memory:updatePerson IPC）
   * 重要约束：不覆盖 source ids（由 main 端 handler 控制）
   */
  updatePerson: async (id: string, patch: Record<string, unknown>) => {
    try {
      await getIpc().memory.updatePerson({ id, ...patch });
      // 乐观更新本地状态（todayData.people）
      const updatePersonInList = (person: PersonItem) =>
        person.id === id ? { ...person, ...patch } : person;
      const today = get().todayData;
      set({
        todayData: {
          ...today,
          people: today.people.map(updatePersonInList),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 删除对象（调用 memory:deleteObject IPC）
   * soft delete 优先（由 main 端 handler 实现）
   */
  deleteObject: async (id: string, type: string) => {
    try {
      await getIpc().memory.deleteObject({ id, type });
      // 乐观更新本地状态（从列表中移除）
      const today = get().todayData;
      const removeFromList = <T extends { id: string; deletedAt?: string | null }>(item: T) =>
        item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item;
      if (type === "fact") {
        set({
          todayData: { ...today, facts: today.facts.map(removeFromList) },
        });
      } else if (type === "scene") {
        set({
          todayData: { ...today, scenes: today.scenes.map(removeFromList) },
        });
      } else if (type === "task") {
        set({
          todayData: { ...today, tasks: today.tasks.map(removeFromList) },
        });
      } else if (type === "decision") {
        set({
          todayData: { ...today, decisions: today.decisions.map(removeFromList) },
        });
      } else if (type === "person") {
        set({
          todayData: { ...today, people: today.people.map(removeFromList) },
        });
      } else if (type === "project") {
        // 项目使用 archive，从列表中过滤掉
        set({
          todayData: { ...today, projects: today.projects.filter((p) => p.id !== id) },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 用户纠错（调用 memory:createUserFeedback IPC）
   * - 保存 edit history
   * - 更新对应对象（不覆盖 source ids）
   * - 写入 user_feedback
   */
  createUserFeedback: async (input) => {
    try {
      await getIpc().memory.createUserFeedback(input);
      // 纠错后重新加载今日数据，确保 UI 同步
      // 不抛错，让调用方决定是否刷新
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 合并对象（调用 memory:mergeObjects IPC）
   * - 把 fromId 对象的 sourceFactIds 合并到 toId
   * - soft delete fromId
   * - 012 增强：返回改写统计（rewrittenFactsCount / rewrittenScenesCount / mergedAliases）
   * - 合并完成后立即刷新今日数据 + 合并建议列表
   */
  mergeObjects: async (input) => {
    try {
      const result = await getIpc().memory.mergeObjects(input);
      // 合并后重新加载今日数据
      await get().loadToday();
      // 重新加载合并建议（如该建议被确认）
      if (get().mergeSuggestions.length > 0) {
        void get().loadMergeSuggestions();
      }
      const merged = (result as { merged: {
        rewrittenFactsCount: number;
        rewrittenScenesCount: number;
        mergedAliases: string[];
      } }).merged;
      return {
        rewrittenFactsCount: merged.rewrittenFactsCount,
        rewrittenScenesCount: merged.rewrittenScenesCount,
        mergedAliases: merged.mergedAliases,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  // 012/013 新增：加载合并建议（Linker 输出的 mergeSuggestions）
  loadMergeSuggestions: async () => {
    set({ mergeSuggestionsLoading: true });
    try {
      const result = await getIpc().memory.listMergeSuggestions({ status: "new", limit: 200 });
      set({ mergeSuggestions: result.items, mergeSuggestionsLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message, mergeSuggestionsLoading: false });
    }
  },

  // 012/013 新增：拒绝某个合并建议
  rejectMergeSuggestion: async (id) => {
    try {
      await getIpc().memory.rejectMergeSuggestion({ id });
      // 重新加载列表
      await get().loadMergeSuggestions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  // 012/013 新增：加载所有已知别名映射（供 UI 提示 + LLM prompt 注入）
  loadAllAliases: async () => {
    try {
      const result = await getIpc().memory.listAllAliases();
      set({
        allAliases: {
          projects: result.projects,
          people: result.people,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  /**
   * 忘掉最近（调用 capture:forgetRecent IPC）
   * - 删除对应时间范围内截图缓存（硬删除）
   * - 删除对应 observation
   * - 删除或 soft delete 关联 facts/scenes（由 main 端实现）
   */
  forgetRecent: async (duration) => {
    return forgetRecentAction(set as never, get as never, EMPTY_TODAY, duration);
  },

  // ============================================================================
  // M8 新增动作：模型配置 / 隐私规则 / 设置 / 数据导出
  // ============================================================================

  /**
   * 加载模型配置列表（不返回 API Key）
   */
  loadModelConfigs: async () => {
    if (get().modelConfigsLoading) return;
    set({ modelConfigsLoading: true, modelConfigsError: null });
    try {
      const list = await getIpc().model.listConfigs<ModelConfigItem>();
      set({
        modelConfigs: list ?? [],
        modelConfigsLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ modelConfigsLoading: false, modelConfigsError: message });
    }
  },

  /**
   * 保存模型配置（创建或更新）
   * - 输入 id：更新现有配置
   * - 不输入 id：创建新配置
   * - 输入 apiKey：写入 SecretService（覆盖原有 key）
   * - 不输入 apiKey：保留原有 key
   *
   * 安全约束：apiKey 不进 SQLite / 不进日志 / 不返回 renderer
   */
  saveModelConfig: async (input) => {
    try {
      const result = await getIpc().model.saveConfig(input);
      if (result.ok) {
        // 保存成功后重新加载列表
        await get().loadModelConfigs();
        return { ok: true, warning: result.warning };
      }
      return {
        ok: false,
        error: result.message ?? "保存失败",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 删除模型配置
   * 后端会同时删除 SecretService 中的 API Key
   */
  deleteModelConfig: async (id) => {
    try {
      const result = await getIpc().model.deleteConfig({ id });
      if (result.ok) {
        // 乐观更新本地列表
        const current = get().modelConfigs;
        set({ modelConfigs: current.filter((c) => c.id !== id) });
      }
      return { ok: result.ok };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 测试模型连接
   * 安全约束：失败时不显示完整 API Key（由 main 端 sanitize）
   */
  testModelConnection: async (input) => {
    try {
      return await getIpc().model.testConnection(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "unknown_error", message };
    }
  },

  /**
   * 加载隐私规则列表
   */
  loadPrivacyRules: async () => {
    if (get().privacyRulesLoading) return;
    set({ privacyRulesLoading: true, privacyRulesError: null });
    try {
      const list = await getIpc().privacy.listRules<PrivacyRuleItem>();
      set({
        privacyRules: list ?? [],
        privacyRulesLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ privacyRulesLoading: false, privacyRulesError: message });
    }
  },

  /**
   * 添加隐私规则
   */
  addPrivacyRule: async (input) => {
    try {
      await getIpc().privacy.addRule(input);
      // 添加后重新加载列表
      await get().loadPrivacyRules();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 更新隐私规则（pattern / action / enabled）
   */
  updatePrivacyRule: async (id, patch) => {
    try {
      await getIpc().privacy.updateRule({ id, ...patch });
      // 乐观更新本地列表
      const current = get().privacyRules;
      set({
        privacyRules: current.map((r) =>
          r.id === id
            ? {
                ...r,
                ...(patch.pattern !== undefined ? { pattern: patch.pattern } : {}),
                ...(patch.action !== undefined ? { action: patch.action } : {}),
                ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
              }
            : r
        ),
      });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 删除隐私规则
   */
  deletePrivacyRule: async (id) => {
    try {
      await getIpc().privacy.deleteRule({ id });
      // 乐观更新本地列表
      const current = get().privacyRules;
      set({ privacyRules: current.filter((r) => r.id !== id) });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 加载应用设置（从 settings.json）
   */
  loadSettings: async () => {
    if (get().settingsLoading) return;
    set({ settingsLoading: true, settingsError: null });
    try {
      const settings = await getIpc().settings.get<AppSettingsState>();
      set({
        settings,
        settingsLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ settingsLoading: false, settingsError: message });
    }
  },

  /**
   * 更新应用设置（浅合并：observation/screenshot/notification/dailyReport/onboardingCompleted）
   */
  updateSettings: async (patch) => {
    const previous = get().settings;
    if (previous) {
      set({
        settings: {
          observation: patch.observation ?? previous.observation,
          screenshot: patch.screenshot ?? previous.screenshot,
          notification: patch.notification ?? previous.notification,
          endOfDayReview: patch.endOfDayReview ?? previous.endOfDayReview,
          dailyReport: patch.dailyReport ?? previous.dailyReport,
          personalReview: patch.personalReview ?? previous.personalReview,
          reportRequirements:
            patch.reportRequirements ?? previous.reportRequirements,
          defaultModelService:
            patch.defaultModelService ?? previous.defaultModelService,
          onboardingCompleted: patch.onboardingCompleted ?? previous.onboardingCompleted,
          debug: patch.debug ?? previous.debug,
        },
        settingsError: null,
      });
    }
    try {
      const result = await getIpc().settings.update<AppSettingsState>(patch);
      set({ settings: result.settings, settingsError: null });
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ settings: previous, settingsError: message });
      return { ok: false, error: message };
    }
  },

  // -------------------- 版本更新 --------------------

  /**
   * 加载当前更新状态（应用启动时调用）
   */
  loadUpdateStatus: async () => {
    try {
      const status = (await getIpc().update.getStatus()) as UpdateStatus;
      set({ updateStatus: status });
    } catch {
      // 静默失败
    }
  },

  /**
   * 加载当前应用版本号
   */
  loadCurrentVersion: async () => {
    try {
      const { version } = await getIpc().app.getVersion();
      set({ currentVersion: version });
    } catch {
      // 静默失败
    }
  },

  /**
   * 检查更新（手动触发）
   */
  checkForUpdate: async () => {
    try {
      await getIpc().update.check({ force: true });
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 下载更新
   */
  downloadUpdate: async () => {
    try {
      await getIpc().update.download();
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 安装并退出
   */
  installUpdate: async () => {
    const { updateStatus } = get();
    if (updateStatus.state !== "downloaded") return;
    try {
      await getIpc().update.installAndQuit({ installerPath: updateStatus.installerPath });
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 忽略某版本
   */
  dismissUpdateVersion: async (version: string) => {
    try {
      await getIpc().update.dismissVersion({ version });
    } catch {
      // 静默失败
    }
  },

  /**
   * 设置更新状态（IPC push 回调）
   */
  setUpdateStatus: (status: UpdateStatus) => set({ updateStatus: status }),

  /**
   * 设置下载进度（IPC push 回调）
   */
  setDownloadProgress: (progress: DownloadProgress) => {
    set({ updateStatus: { state: "downloading", progress } });
  },

  /**
   * 数据导出（JSON，默认不含截图）
   */
  exportData: async (input) => {
    return exportDataAction(input);
  },

  /**
   * 清空所有结构化记忆数据 + 截图缓存
   * 保留 settings / model_configs / privacy_rules / user_feedback
   */
  clearAllData: async () => {
    const result = await clearAllDataAction(set as never);
    if (result.ok) set({ todayData: EMPTY_TODAY });
    return result;
  },

  /**
   * 仅清空截图文件（调用 screenshot:clear IPC）
   * 不删除结构化记忆（观察/线索/工作片段等保留）。
   */
  clearScreenshotsOnly: async () => {
    return clearScreenshotsOnlyAction();
  },

  /**
   * 查询截图缓存当前大小（字节数和文件数）
   */
  getCacheSize: async () => {
    return getCacheSizeAction();
  },

  // ============================================================================
  // Phase 3 新增 actions（doc 21 今日页）
  // ============================================================================

  /**
   * 加载今日页完整数据（并行 4 个 IPC + 派生 dayMainThread/highlights/decisions/tomorrowStartHere）
   */
  loadTodayPageData: async (dateKey: string) => {
    const requestId = ++latestTodayPageRequestId;
    set({ todayPageLoading: true, todayPageError: null, todayPageDateKey: dateKey });
    try {
      const appStatus = get().appStatus;
      const data = await fetchTodayPageData(dateKey, appStatus);
      if (!isCurrentTodayPageRequest(requestId, latestTodayPageRequestId, dateKey, get().todayPageDateKey)) return;
      // 进入时清理上一次的选择模式与忽略列表
      set({
        todayPageData: data,
        todayPageLoading: false,
        ignoredBlockIds: [],
        workReportSelectionMode: false,
        selectedBlockIds: [],
        previewModalOpen: false,
      });
    } catch (err) {
      if (!isCurrentTodayPageRequest(requestId, latestTodayPageRequestId, dateKey, get().todayPageDateKey)) return;
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageLoading: false, todayPageError: message });
    }
  },

  /**
   * 用当前 dateKey 重新加载今日页数据
   */
  refreshTodayPageData: async () => {
    const dateKey = get().todayPageDateKey;
    await get().loadTodayPageData(dateKey);
    const state = get();
    const data = state.todayPageData;
    // 触发增量 build 的条件：
    // 1. 完全无 blocks（首次生成）
    // 2. 距上次 build 超过 10 分钟且正在观察（增量补充新片段）
    const hasNoBlocks = data && data.timelineBlocks.length === 0;
    const staleBuild =
      Date.now() - state.lastTimelineBuildAt > 10 * 60 * 1000;
    const shouldTriggerBuild =
      data &&
      data.dateKey === dateKey &&
      dateKey === todayDateKey() &&
      (hasNoBlocks || staleBuild) &&
      state.appStatus.observing &&
      !state.appStatus.paused &&
      state.timelineBuildingDateKey !== dateKey;
    if (shouldTriggerBuild) {
      set({
        timelineBuildingDateKey: dateKey,
        todayPageLoading: true,
        todayPageError: null,
        lastTimelineBuildAt: Date.now(),
      });
      try {
        const res = await getIpc().timeline.build(dateKey);
        if (!res.ok && res.code !== "insufficient_data") {
          throw new Error(res.error ?? "时间轴生成失败");
        }
        set({ todayPageLoading: false });
        await get().loadTodayPageData(dateKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ todayPageLoading: false, todayPageError: message });
      } finally {
        if (get().timelineBuildingDateKey === dateKey) {
          set({ timelineBuildingDateKey: null });
        }
      }
    }
  },

  setTodayPageDateKey: (dateKey: string) => set({
    todayPageDateKey: dateKey,
    todayPageFollowingToday: dateKey === todayDateKey(),
  }),

  /**
   * 跨日检测：如果当前 todayPageDateKey 已经不再是"今天"（本地时区），
   * 自动滚动到今天并重新加载数据。
   * 修复：renderer 长期开着跨过零点，dateKey 不会自动刷新，导致右侧一直显示昨天。
   * 调用方：TodayPage 挂载时、window focus 时、定时（每 30 分钟）调用。
   */
  rollOverTodayDateKeyIfNeeded: () => {
    const current = get().todayPageDateKey;
    const today = todayDateKey();
    if (shouldRollOverTodayDate(current, today, get().todayPageFollowingToday)) {
      set({ todayPageDateKey: today, todayPageFollowingToday: true });
      return true;
    }
    return false;
  },

  /**
   * 触发 TimelineBuilder 生成当天时间轴（调用 LLM），完成后重新加载
   */
  buildTimeline: async (dateKey: string) => {
    if (get().timelineBuildingDateKey === dateKey) return;
    set({ todayPageLoading: true, todayPageError: null, timelineBuildingDateKey: dateKey });
    try {
      const res = await getIpc().timeline.build(dateKey);
      if (!res.ok) throw new Error(res.error ?? "时间轴生成失败");
      set({ todayPageLoading: false });
      await get().loadTodayPageData(dateKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageLoading: false, todayPageError: message });
    } finally {
      if (get().timelineBuildingDateKey === dateKey) {
        set({ timelineBuildingDateKey: null });
      }
    }
  },

  reorganizeTimelineDay: async (dateKey: string) => {
    if (get().timelineBuildingDateKey === dateKey) return;
    set({ todayPageLoading: true, todayPageError: null, timelineBuildingDateKey: dateKey });
    try {
      const res = await getIpc().timeline.reorganizeDay(dateKey);
      if (!res.ok) throw new Error(res.error ?? "时间轴重整失败");
      await get().loadTodayPageData(dateKey);
    } catch (err) {
      set({ todayPageError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ todayPageLoading: false });
      if (get().timelineBuildingDateKey === dateKey) set({ timelineBuildingDateKey: null });
    }
  },

  /**
   * 生成个人复盘（调用 LLM），完成后重新加载
   */
  generatePersonalReview: async (
    dateKey: string,
    generationRequirement?: string
  ) => {
    set({ personalReviewGenerating: true, personalReviewError: null });
    try {
      const res = await getIpc().personalReview.generate({
        dateKey,
        ...(generationRequirement ? { generationRequirement } : {}),
      });
      if (!res.ok) throw new Error(res.error ?? "复盘生成失败");
      await get().loadTodayPageData(dateKey);
      set({ personalReviewGenerating: false });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ personalReviewGenerating: false, personalReviewError: message });
      return false;
    }
  },

  /**
   * 生成工作日报（基于用户选中的 TimelineBlock），完成后退出选择模式并重新加载
   */
  generateWorkReport: async (params) => {
    set({ workReportGenerating: true, workReportError: null });
    try {
      const res = await getIpc().workReport.generate(params);
      if (!res.ok) throw new Error(res.error ?? "日报生成失败");
      await get().loadTodayPageData(params.dateKey);
      set({
        workReportGenerating: false,
        workReportSelectionMode: false,
        previewModalOpen: false,
        workReportGenerationRequirement: "",
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ workReportGenerating: false, workReportError: message });
      return false;
    }
  },

  /**
   * 保存用户选区（不生成日报），best effort
   */
  saveReportSelection: async (params) => {
    try {
      await getIpc().workReport.saveSelection(params);
    } catch (err) {
      console.error("保存日报选区失败:", err);
    }
  },

  /**
   * 进入/退出工作日报选择模式
   * 进入时默认选中 reportable=true && privateRisk=low 的片段
   */
  setWorkReportSelectionMode: (enabled) => {
    if (enabled) {
      const data = get().todayPageData;
      const defaultSelected = data
        ? data.timelineBlocks
            .filter((b) => b.reportable && b.privateRisk === "low")
            .map((b) => b.id)
        : [];
      set({
        workReportSelectionMode: true,
        selectedBlockIds: defaultSelected,
        workReportError: null,
        previewModalOpen: false,
      });
    } else {
      set({
        workReportSelectionMode: false,
        selectedBlockIds: [],
        previewModalOpen: false,
        workReportError: null,
        workReportGenerationRequirement: "",
      });
    }
  },

  /**
   * 从某张卡片"加入日报"按钮进入选择模式，确保该 block 被选中
   */
  enterSelectionWithBlock: (blockId) => {
    const data = get().todayPageData;
    const defaultSelected = data
      ? data.timelineBlocks
          .filter((b) => b.reportable && b.privateRisk === "low")
          .map((b) => b.id)
      : [];
    const selected = defaultSelected.includes(blockId)
      ? defaultSelected
      : [...defaultSelected, blockId];
    set({
      workReportSelectionMode: true,
      selectedBlockIds: selected,
      workReportError: null,
      previewModalOpen: false,
    });
  },

  toggleBlockSelection: (blockId) => {
    const current = get().selectedBlockIds;
    if (current.includes(blockId)) {
      set({ selectedBlockIds: current.filter((id) => id !== blockId) });
    } else {
      set({ selectedBlockIds: [...current, blockId] });
    }
  },

  /**
   * 选中所有 reportable 且 privateRisk !== "high" 的工作片段
   */
  selectAllWorkBlocks: () => {
    const data = get().todayPageData;
    if (!data) return;
    const workBlockIds = data.timelineBlocks
      .filter((b) => b.reportable && b.privateRisk !== "high")
      .map((b) => b.id);
    set({ selectedBlockIds: workBlockIds });
  },

  clearSelection: () => set({ selectedBlockIds: [] }),

  setWorkReportStyle: (style) => set({ workReportStyle: style }),

  setWorkReportGenerationRequirement: (requirement) =>
    set({ workReportGenerationRequirement: requirement }),

  setPreviewModalOpen: (open) => set({ previewModalOpen: open }),

  setSidePanelDrawerOpen: (open) => set({ sidePanelDrawerOpen: open }),

  /**
   * 忽略时间轴片段（仅本地过滤，不持久化；重新加载时恢复）
   */
  ignoreTimelineBlock: (id) =>
    set((state) => ({
      ignoredBlockIds: state.ignoredBlockIds.includes(id)
        ? state.ignoredBlockIds
        : [...state.ignoredBlockIds, id],
    })),

  /**
   * 更新待收尾事项状态（乐观更新本地 todayPageData）
   */
  updateUnfinishedThreadStatus: async (id, status) => {
    const prev = get().todayPageData;
    // 乐观更新
    if (prev) {
      set({
        todayPageData: {
          ...prev,
          unfinishedThreads: prev.unfinishedThreads.map((t) =>
            t.id === id ? { ...t, status } : t
          ),
        },
      });
    }
    try {
      const result = await getIpc().unfinishedThreads.updateStatus({ id, status });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      // 回滚
      set({ todayPageData: prev });
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageError: message });
    }
  },

  // ============================================================================
  // Phase 5 新增：待收尾页 actions（doc 24）
  // ============================================================================

  /**
   * 加载仍需处理的待收尾列表，仅拉取 open 状态。
   */
  loadUnfinishedThreads: async () => {
    if (get().unfinishedLoading) return;
    set({ unfinishedLoading: true, unfinishedError: null });
    try {
      const result = await getIpc().unfinishedThreads.list({ status: "open" });
      if (!result.ok) throw new Error(result.error);
      set({ unfinishedThreads: result.data as UnfinishedThread[], unfinishedLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ unfinishedError: message, unfinishedLoading: false });
    }
  },

  /**
   * 更新待收尾状态（乐观更新本地 unfinishedThreads）
   */
  updateUnfinishedStatus: async (id, status) => {
    const prev = get().unfinishedThreads;
    set({ unfinishedThreads: status === "open" ? prev.map((thread) => thread.id === id ? { ...thread, status } : thread) : prev.filter((thread) => thread.id !== id) });
    try {
      const result = await getIpc().unfinishedThreads.updateStatus({ id, status });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      // 回滚
      set({ unfinishedThreads: prev });
      const message = err instanceof Error ? err.message : String(err);
      set({ unfinishedError: message });
    }
  },

  // ============================================================================
  // Phase 4 新增 actions（报告页，doc 23）
  // ============================================================================

  setReportsTab: (tab) => set({ reportsTab: tab }),

  setReportsDateKey: (dateKey) => set({ reportsDateKey: dateKey, reportsDateKeySetByUser: true }),

  /**
   * 跨日检测：reportsDateKey 跨过零点时自动滚动到今天 + 重新加载当前 Tab
   * **重要**：仅当用户没有主动改过日期时才回滚（防止"点前一天看历史"被错误回滚）
   * - user-changed flag 在 setReportsDateKey 时被设为 true
   * - 任何 reloadPersonalReview/loadWorkReport 成功后会 reset flag
   *   （这样明天重新打开时跨日回滚能正常工作）
   *
   * 调用方：ReportsPage 挂载时 / window focus / 30 分钟定时
   * 调用方**不**应在 dateKey 变化的 effect 里调用本方法（会形成循环）
   */
  rollOverReportsDateKeyIfNeeded: () => {
    // 用户主动改过日期 → 不回滚（保留用户的选择）
    if (get().reportsDateKeySetByUser) return false;
    const current = get().reportsDateKey;
    const today = todayDateKey();
    // 只有当 current 严格小于 today 时（说明跨过了一天）才滚动
    if (current && current < today) {
      set({ reportsDateKey: today, reportsDateKeySetByUser: false });
      // 重新加载当前 Tab（与 ReportsPage useEffect 触发逻辑一致）
      const tab = get().reportsTab;
      if (tab === "personal") {
        void get().loadPersonalReview(today);
      } else if (tab === "work") {
        void get().loadWorkReport(today);
      }
      return true;
    }
    return false;
  },

  /**
   * 标记 dateKey 已被用户主动设置（用于 rollOver 跳过逻辑）
   * - ReportsPage 在 prev/next/date-input onChange 时显式调用
   * - 加载成功后 resetReportsDateKeyUserFlag() 会清除标记
   */
  markReportsDateKeySetByUser: () => set({ reportsDateKeySetByUser: true }),

  /**
   * 清除 user-changed 标记
   * - load 成功且 current === today 时调用（让"用户刚切回今天"也允许后续跨日回滚）
   * - 切换 tab 时不调用（保留用户对该 tab 的日期选择）
   */
  resetReportsDateKeyUserFlag: () => set({ reportsDateKeySetByUser: false }),

  /**
   * "默认显示最近一份有的复盘"：
   * - 如果当前 dateKey 没有复盘，自动切到 ≤ today 的最近一份
   * - 工作日报 Tab 同理
   * - 调用方：ReportsPage 加载完成后
   * - 如果是用户主动切的 dateKey（user-changed=true），不强制回退
   */
  fallbackToLatestReportIfMissing: async () => {
    const state = get();
    const today = todayDateKey();
    const currentDateKey = state.reportsDateKey;
    const tab = state.reportsTab;
    // 仅当 currentDateKey ≥ today 时才回退（用户主动看过去的不动）
    if (currentDateKey < today) return;
    // 仅当 user 没改过时自动回退
    if (state.reportsDateKeySetByUser) return;

    if (tab === "personal") {
      if (state.personalReview) return; // 当前已有，不动
      const list = await getIpc().reports.list<{ dateKey: string }>({
        type: "personal_daily_review",
        dateTo: today,
        limit: 1,
      });
      if (list.length > 0 && list[0]?.dateKey && list[0].dateKey !== currentDateKey) {
        set({ reportsDateKey: list[0].dateKey });
        await get().loadPersonalReview(list[0].dateKey);
      }
    } else if (tab === "work") {
      if (state.workReport) return;
      const [manualReports, dailyReports] = await Promise.all([
        getIpc().reports.list<{ dateKey: string; updatedAt?: string }>({
          type: "work_daily_report",
          dateTo: today,
          limit: 1,
        }),
        getIpc().reports.list<{ dateKey: string; updatedAt?: string }>({
          type: "daily",
          dateTo: today,
          limit: 1,
        }),
      ]);
      const latest = [...manualReports, ...dailyReports]
        .filter((report) => report.dateKey)
        .sort((left, right) => {
          const dateOrder = right.dateKey.localeCompare(left.dateKey);
          if (dateOrder !== 0) return dateOrder;
          return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
        })[0];
      if (latest?.dateKey && latest.dateKey !== currentDateKey) {
        set({ reportsDateKey: latest.dateKey });
        await get().loadWorkReport(latest.dateKey);
      }
    }
  },

  setReportsWeekStart: (dateKey) => set({ reportsWeekStart: dateKey }),

  setReportsMonthKey: (monthKey) => set({ reportsMonthKey: monthKey }),

  addUnreadReport: (report) => {
    const next = [
      report,
      ...get().unreadReports.filter((item) => item.reportId !== report.reportId),
    ].slice(0, 50);
    persistUnreadReports(next);
    set({ unreadReports: next });
  },

  markUnreadReportsRead: () => {
    persistUnreadReports([]);
    set({ unreadReports: [] });
  },

  /**
   * 加载指定日期的个人复盘（调用 personalReview:get IPC，写入 state.personalReview）
   * 与 todayPageData.personalReview 区分：本字段专供报告页"我的复盘"Tab 使用。
   */
  loadPersonalReview: async (dateKey) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const res = await getIpc().personalReview.get(dateKey);
      if (res.ok) {
        const data = res.data as PersonalReview | null | undefined;
        // 加载成功 + 当前是今天 → 清除 user-changed 标记（让跨日回滚能工作）
        // 注：切到历史日期时不重置（保留"用户在看历史"意图）
        if (dateKey >= todayDateKey()) {
          set({ reportsDateKeySetByUser: false });
        }
        set({
          personalReview: data ?? null,
          reportsLoading: false,
        });
      } else {
        set({
          personalReview: null,
          reportsLoading: false,
          reportsError: res.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 加载指定日期的工作日报（调用 workReport:get IPC，写入 state.workReport）
   * 与 todayPageData.workReport 区分：本字段专供报告页"工作日报"Tab 使用。
   */
  loadWorkReport: async (dateKey) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const res = await getIpc().workReport.get(dateKey);
      if (res.ok) {
        let data = res.data as WorkReport | null | undefined;
        // 定时自动日报使用 type=daily；工作日报 Tab 在没有人工选片段报告时兼容展示它。
        if (!data) {
          const dailyReports = await getIpc().reports.list<ReportItem>({
            type: "daily",
            dateFrom: dateKey,
            dateTo: dateKey,
            limit: 1,
          });
          data = dailyReportRecordToWorkReport(dailyReports[0]);
        }
        if (dateKey >= todayDateKey()) {
          set({ reportsDateKeySetByUser: false });
        }
        set({
          workReport: data ?? null,
          reportsLoading: false,
        });
      } else {
        set({
          workReport: null,
          reportsLoading: false,
          reportsError: res.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 加载历史报告列表（调用 reports:list IPC）
   * 支持 type/dateFrom/dateTo/limit 过滤。
   */
  loadReportsList: async (filters) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const input: Record<string, unknown> = {};
      if (filters?.type && filters.type !== "all") input.type = filters.type;
      if (filters?.dateFrom) input.dateFrom = filters.dateFrom;
      if (filters?.dateTo) input.dateTo = filters.dateTo;
      if (filters?.limit) input.limit = filters.limit;
      const list = await getIpc().reports.list<ReportItem>(input);
      set({
        reportsList: list ?? [],
        reportsLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 更新报告内容（编辑后保存）
   * content 为 plain text，内部包装为 {plainText, edited:true} 的 contentJson 后调用 reports:update。
   * 保存后同步更新本地 personalReview / workReport / reportsList。
   */
  updateReport: async (id, content) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const contentJson = JSON.stringify({ plainText: content, edited: true });
      await getIpc().reports.update({ id, contentJson });
      const now = new Date().toISOString();
      // 同步更新本地 personalReview
      const pr = get().personalReview;
      if (pr && pr.id === id) {
        set({ personalReview: { ...pr, updatedAt: now } });
      }
      // 同步更新本地 workReport（plainText 字段直接替换）
      const wr = get().workReport;
      if (wr && wr.id === id) {
        set({ workReport: { ...wr, plainText: content, updatedAt: now } });
      }
      // 同步更新 reportsList 中的对应项
      const list = get().reportsList;
      if (list.some((r) => r.id === id)) {
        set({
          reportsList: list.map((r) =>
            r.id === id ? { ...r, contentJson, updatedAt: now } : r
          ),
        });
      }
      set({ reportsLoading: false, reportEditing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 物理删除报告（调用 reports:delete IPC）
   * 删除后同步从 reportsList 中移除该项。
   */
  deleteReport: async (id) => {
    try {
      const deleted = await getIpc().reports.delete({ id });
      if (deleted) {
        // 同步从本地列表中移除
        const list = get().reportsList;
        if (list.some((r) => r.id === id)) {
          set({ reportsList: list.filter((r) => r.id !== id) });
        }
      }
      return { ok: deleted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsError: message });
      return { ok: false, error: message };
    }
  },

  setReportEditing: (editing) => set({ reportEditing: editing }),

  setReportDraft: (draft) => set({ reportDraft: draft }),

  setReportsHistoryTypeFilter: (type) => set({ reportsHistoryTypeFilter: type }),

  setReportsHistoryDateFrom: (dateKey) => set({ reportsHistoryDateFrom: dateKey }),

  setReportsHistoryDateTo: (dateKey) => set({ reportsHistoryDateTo: dateKey }),

  setReportsHistoryProjectFilter: (projectId) =>
    set({ reportsHistoryProjectFilter: projectId }),

  setProjectsFilters: (patch) =>
    set((state) => ({ projectsFilters: { ...state.projectsFilters, ...patch } })),

  setPeopleFilters: (patch) =>
    set((state) => ({ peopleFilters: { ...state.peopleFilters, ...patch } })),

  // ============================================================================
  // Phase 7 新增 actions（设置页 / 信任中心 UI）
  // ============================================================================

  setSettingsTab: (tab) => set({ settingsTab: tab }),

  setClearingData: (clearing) => set({ clearingData: clearing }),

  /**
   * 发起危险操作二次确认。
   * 弹出确认对话框，用户确认时执行 onConfirm，取消则关闭。
   * 调用方负责在 onConfirm 内部处理 loading / 错误提示。
   */
  requestConfirm: ({ title, message, confirmText, onConfirm }) =>
    set({
      showConfirmDialog: true,
      confirmDialogTitle: title,
      confirmDialogMessage: message,
      confirmDialogConfirmText: confirmText ?? "确认",
      confirmAction: onConfirm,
    }),

  /** 用户取消：关闭对话框并清空回调 */
  closeConfirmDialog: () =>
    set({
      showConfirmDialog: false,
      confirmDialogTitle: "",
      confirmDialogMessage: "",
      confirmDialogConfirmText: "确认",
      confirmAction: null,
    }),

  /**
   * 用户点击确认按钮：执行回调并关闭对话框。
   * 在回调内部抛错时由调用方自行处理；这里只负责关闭对话框。
   */
  executeConfirm: () => {
    const action = get().confirmAction;
    set({
      showConfirmDialog: false,
      confirmDialogTitle: "",
      confirmDialogMessage: "",
      confirmDialogConfirmText: "确认",
      confirmAction: null,
    });
    if (action) {
      action();
    }
  },

  // -------------------- debug actions --------------------
  loadDebugJobs: async () => {
    const filters = get().debugFilters;
    set({ debugJobsLoading: true, debugJobsError: null });
    try {
      const result = await getIpc().debug.listJobs({
        startAt: filters.startAt,
        endAt: filters.endAt,
        limit: 500,
      });
      if (result.ok) {
        const jobs: DebugJobSummary[] = (result.data as Array<Record<string, unknown>>).map((j) => {
          let debugEventCount = 0;
          if (typeof j.debugEventsJson === "string" && j.debugEventsJson) {
            try {
              const events = JSON.parse(j.debugEventsJson);
              if (Array.isArray(events)) debugEventCount = events.length;
            } catch {
              // ignore parse error
            }
          }
          return {
            id: String(j.id),
            type: String(j.type),
            status: String(j.status),
            attempts: Number(j.attempts ?? 0),
            createdAt: String(j.createdAt ?? j.created_at ?? ""),
            updatedAt: String(j.updatedAt ?? j.updated_at ?? ""),
            errorCode: (j.errorCode ?? j.error_code ?? null) as string | null,
            errorMessage: (j.errorMessage ?? j.error_message ?? null) as string | null,
            debugEventCount,
            inputJson: typeof j.inputJson === "string" ? j.inputJson : (typeof j.input_json === "string" ? j.input_json : ""),
          };
        });
        set({ debugJobs: jobs, debugJobsLoading: false });
      } else {
        set({ debugJobsLoading: false, debugJobsError: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ debugJobsLoading: false, debugJobsError: message });
    }
  },

  loadDebugJobDetails: async (jobId: string) => {
    set({ debugJobDetailsLoading: true, debugJobDetails: null });
    try {
      const result = await getIpc().debug.getJobDetails(jobId);
      if (result.ok && result.data) {
        const j = result.data as Record<string, unknown>;
        const details: DebugJobDetails = {
          id: String(j.id),
          type: String(j.type),
          status: String(j.status),
          inputJson: String(j.inputJson ?? j.input_json ?? ""),
          outputJson: (j.outputJson ?? j.output_json ?? null) as string | null,
          errorCode: (j.errorCode ?? j.error_code ?? null) as string | null,
          errorMessage: (j.errorMessage ?? j.error_message ?? null) as string | null,
          attempts: Number(j.attempts ?? 0),
          createdAt: String(j.createdAt ?? j.created_at ?? ""),
          updatedAt: String(j.updatedAt ?? j.updated_at ?? ""),
          rawInputJson: (j.rawInputJson ?? j.raw_input_json ?? null) as string | null,
          debugEventsJson: (j.debugEventsJson ?? j.debug_events_json ?? null) as string | null,
        };
        set({ debugJobDetails: details, debugJobDetailsLoading: false });
      } else {
        set({ debugJobDetailsLoading: false, debugJobDetails: null });
      }
    } catch (err) {
      set({ debugJobDetailsLoading: false, debugJobDetails: null });
      console.error("loadDebugJobDetails failed:", err);
    }
  },

  loadDebugRelatedRecords: async (createdAt: string) => {
    set({ debugRelatedRecordsLoading: true, debugRelatedRecords: null });
    try {
      const result = await getIpc().debug.getRelatedRecords({ createdAt, windowSeconds: 60 });
      if (result.ok) {
        set({ debugRelatedRecords: result.data as DebugRelatedRecords, debugRelatedRecordsLoading: false });
      } else {
        set({ debugRelatedRecordsLoading: false, debugRelatedRecords: null });
      }
    } catch (err) {
      set({ debugRelatedRecordsLoading: false, debugRelatedRecords: null });
      console.error("loadDebugRelatedRecords failed:", err);
    }
  },

  setDebugFilters: (patch) => {
    set({ debugFilters: { ...get().debugFilters, ...patch } });
  },

  clearDebugState: () => {
    set({
      debugJobs: null,
      debugJobsError: null,
      debugJobDetails: null,
      debugRelatedRecords: null,
    });
  },
}));
