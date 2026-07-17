// src/shared/types.ts
// 跨进程共享的类型定义（main 与 renderer 都可引用）
// 重要：本文件不得引入 Node-only 或 DOM-only API，保持纯类型导出

/**
 * 全局 App Status（来自 06_TECHNICAL_ARCHITECTURE.md）
 *
 * 用户必须始终能看到当前状态：
 * 观察中 / 已暂停 / 黑名单跳过 / 敏感内容跳过 / 模型错误 / 正在整理。
 */
export interface AppStatus {
  observing: boolean;
  paused: boolean;
  currentWindow?: {
    appName: string;
    windowTitle: string;
    privacyState: "allowed" | "blocked" | "sensitive" | "unknown";
  };
  pipelineState:
    | "idle"
    | "capturing"
    | "observing"
    | "extracting"
    | "linking"
    | "judging"
    | "reporting"
    | "error";
  lastError?: string;
}

/**
 * 隐私规则（M0 仅占位，M3 PrivacyGuard 实现完整逻辑）
 */
export interface PrivacyRule {
  id: string;
  type: "app_name" | "window_title_keyword" | "domain_keyword";
  pattern: string;
  action: "exclude" | "ask_before_capture" | "blur_sensitive";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 模型配置（API Key 不在本结构中，存于 SecretService）
 */
export interface ModelConfig {
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
 * 渲染进程通过 IPC 调用的状态变化回调
 */
export type StatusListener = (status: AppStatus) => void;

/**
 * 通用 IPC 调用结果封装（可选）
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

// ============================================================================
// Phase 2 前端共享类型（doc 19 / doc 20 / spec.md Phase 2）
// ============================================================================
// 这些类型同时被 main 进程和 renderer 进程引用：
// - main 端通过 src/main/models/types.ts re-export 引用
// - renderer 端直接从 src/shared/types 引用
//
// 重要：本文件不得引入 Node-only 或 DOM-only API，保持纯类型导出。
// 持久化字段（createdAt / updatedAt）设为可选，便于 renderer 接收部分字段。
// ============================================================================

/**
 * TimelineBlock category 枚举（doc 20 第 5 节 / spec.md 行 728-739）
 */
export type TimelineBlockCategory =
  | "focus_work"
  | "communication"
  | "research"
  | "writing"
  | "coding"
  | "design"
  | "meeting"
  | "admin"
  | "break"
  | "mixed"
  | "unknown";

/**
 * TodayTimelineProjection：由 Episode / Atom / Moment 派生的今日时间轴投影。
 *
 * 持久化在 timeline_blocks 表（003 迁移）。
 * 同一 dateKey 重复生成时由应用层先删除旧 blocks 再写入新 blocks。
 *
 * createdAt / updatedAt 设为可选：renderer 接收时可能未填充（例如 LLM 刚输出还未落库）。
 */
export interface TodayTimelineProjection {
  id: string;
  dateKey: string;
  startAt: string;
  endAt: string;
  title: string;
  summary: string;
  category: TimelineBlockCategory;
  projectIds: string[];
  projectNames: string[];
  highlights: string[];
  generatedTasks: string[];
  generatedDecisions: string[];
  reportable: boolean;
  privateRisk: "low" | "medium" | "high";
  /**
   * 隐私风险原因说明（LLM 输出，持久化时可选保留）
   * 注意：timeline_blocks 表未单独建列，可序列化到 highlights 或忽略。
   */
  privateRiskReason?: string;
  sourceSceneIds: string[];
  sourceFactIds: string[];
  sourceObservationIds: string[];
  /**
   * LLM 输出的置信度，持久化时可选保留
   */
  confidence?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** @deprecated Use TodayTimelineProjection for new renderer and IPC code. */
export type TimelineBlock = TodayTimelineProjection;

/**
 * UnfinishedThread：未收尾事项（doc 20 第 6 节 / spec.md 行 813-821）
 *
 * 由 Judge worker 输出，持久化在应用层（可复用 proactive_items 表或新增表）。
 * 每个待收尾必须有来源（sourceFactIds / sourceTimelineBlockIds）。
 */
export interface UnfinishedThread {
  id: string;
  title: string;
  reason: string;
  suggestedNextAction: string;
  priority: "high" | "medium" | "low";
  projectName?: string;
  lastSeenAt?: string;
  sourceFactIds: string[];
  sourceTimelineBlockIds: string[];
  confidence: number;
  status: "open" | "done" | "snoozed" | "ignored";
  createdAt?: string;
  updatedAt?: string;
}

export interface EndOfDayReviewItem {
  id: string;
  text: string;
  sourceType: "timeline_block" | "unfinished_thread";
}

export interface EndOfDayReview {
  dateKey: string;
  completed: EndOfDayReviewItem[];
  attention: EndOfDayReviewItem[];
  empty: boolean;
}

/**
 * PersonalReview：自用复盘持久化实体（doc 20 第 7 节 / spec.md 行 909-927）
 *
 * 与 main 端 PersonalReviewOutput 区别：
 * - PersonalReviewOutput 是 LLM 输出结构（含 dateKey / title，无 id / createdAt）
 * - PersonalReview 是持久化后的实体（含 id / createdAt / updatedAt）
 *
 * renderer 通过 IPC 拿到 PersonalReview（已落库），main 端 LLM 输出 PersonalReviewOutput 后落库。
 */
export interface PersonalReview {
  id: string;
  dateKey: string;
  title: string;
  overview: string;
  mainThreads: string[];
  meaningfulProgress: string[];
  unfinished: Array<{
    text: string;
    suggestedNextAction: string;
    sourceTimelineBlockIds: string[];
    sourceFactIds: string[];
  }>;
  worthRemembering: Array<{
    text: string;
    reason: string;
    sourceFactIds: string[];
  }>;
  tomorrowStartHere: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * WorkReport：工作日报持久化实体（doc 20 第 8 节 / spec.md 行 1012-1026）
 *
 * 与 main 端 WorkReportOutput 区别：
 * - WorkReportOutput 是 LLM 输出结构（含 dateKey / title，无 id / createdAt）
 * - WorkReport 是持久化后的实体（含 id / createdAt / updatedAt）
 */
export interface WorkReport {
  id: string;
  dateKey: string;
  title: string;
  plainText: string;
  sections: {
    completed: string[];
    projectProgress: string[];
    risks: string[];
    tomorrowPlan: string[];
  };
  sourceTimelineBlockIds: string[];
  sourceFactIds: string[];
  omittedForPrivacy: number;
  warnings: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * TodayPageData：今日页一次性加载所需的数据（doc 21 Phase 3）
 *
 * Phase 2 预先定义此类型，Phase 3 今日页 IPC 直接返回此结构。
 * 包含：
 * - 当日时间轴 blocks
 * - 未收尾事项（unfinishedThreads）
 * - 高亮事项（highlights，来自 facts 中 importance 高的）
 * - 当日决策（decisions）
 * - 个人复盘（personalReview，可选，未生成时为 undefined）
 * - 工作日报（workReport，可选，未生成时为 undefined）
 * - 明日起点（tomorrowStartHere，来自 personalReview 或 LLM 单独生成）
 */
export interface TodayPageData {
  dateKey: string;
  appStatus: AppStatus;
  dayMainThread: string;
  /** 派生展示投影，不是新的记忆层级或来源记录。 */
  timelineBlocks: TodayTimelineProjection[];
  activityOverview: TodayActivityOverview;
  unfinishedThreads: UnfinishedThread[];
  highlights: Array<{ id: string; content: string }>;
  decisions: Array<{ id: string; content: string }>;
  personalReview?: PersonalReview;
  workReport?: WorkReport;
  tomorrowStartHere: string[];
}

export interface TodayActivityStats {
  totalObservedMinutes: number;
  categorizedMinutes: Partial<Record<TimelineBlockCategory, number>>;
  pendingMinutes: number;
  sampleCount: number;
}

export interface TodayActivityEpisode {
  id: string;
  startAt: string;
  endAt: string;
  title: string;
  summary: string;
  category: TimelineBlockCategory;
  categoryConfidence: number;
  sourceObservationIds: string[];
  projectNames: string[];
  topicTexts: string[];
}

export interface TodayActivityOverview {
  stats: TodayActivityStats;
  episodes: TodayActivityEpisode[];
}
