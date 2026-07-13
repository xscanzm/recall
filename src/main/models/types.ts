// src/main/models/types.ts
// Main 进程内部使用的类型定义
// 注意：跨进程共享的类型应放在 src/shared/types.ts

import type {
  AppStatus,
  ModelConfig,
  PrivacyRule,
  TimelineBlock,
  UnfinishedThread,
  PersonalReview,
  WorkReport,
  TodayPageData,
} from "../../shared/types";

/**
 * Re-export 共享类型，便于 main 内部统一从 @/models/types 引用
 *
 * Phase 2 新增共享类型（TimelineBlock / UnfinishedThread / PersonalReview /
 * WorkReport / TodayPageData）也在 shared/types.ts 定义，main 端通过 re-export 引用。
 */
export type {
  AppStatus,
  ModelConfig,
  PrivacyRule,
  TimelineBlock,
  UnfinishedThread,
  PersonalReview,
  WorkReport,
  TodayPageData,
};

/**
 * M0 内部 AppStatusHolder：在 main 进程中维护可变 status
 * M3+ 之后由 CaptureService/ActivityService/Pipeline 更新
 */
export interface AppStatusHolder {
  current: AppStatus;
  set(patch: Partial<AppStatus>): void;
  subscribe(listener: (status: AppStatus) => void): () => void;
}

/**
 * 应用设置（M0 仅占位结构，M1 在 SettingsRepository 持久化）
 *
 * M8 新增 onboardingCompleted：标记首次启动引导是否已完成
 * - 默认 false（首次启动时显示引导）
 * - 用户完成或跳过引导后置为 true
 */
export interface AppSettings {
  observation: {
    enabled: boolean;
    activeWindowStableSeconds: number;
    contentChangeMinIntervalSeconds: number;
    longSessionIntervalMinutes: number;
    idleThresholdSeconds: number;
  };
  screenshot: {
    retentionPolicy:
      | "delete_immediately"
      | "1h"
      | "6h"
      | "today"
      | "3d"
      | "7d";
  };
  notification: {
    inAppReminders: boolean;
    desktopNotifications: boolean;
    dailyReportTime: string; // HH:mm
    weeklyReportTime: string; // HH:mm，每周日触发
  };
  endOfDayReview: {
    enabled: boolean;
    firstTime: string; // HH:mm
    secondTime: string; // HH:mm
  };
  dailyReport: {
    autoGenerate: boolean;
    time: string; // HH:mm
  };
  /**
   * 个人复盘定时设置（与 dailyReport 镜像，UI 后续可加）
   * - autoGenerate: 用户是否开启每天自动生成复盘
   * - time: 每天此时间（HH:mm）触发
   * - 默认 22:00（一天工作结束后回顾）
   */
  personalReview: {
    autoGenerate: boolean;
    time: string; // HH:mm
  };
  /**
   * 调度器持久化状态（不直接暴露给用户 UI）
   * - 应用重启后用来判断哪些周期的报告/复盘/周报还没生成（补跑）
   * - lastDailyReportDate: 上次成功生成 work_daily_report 的 dateKey
   * - lastWeeklyReportWeekStart: 上次成功生成 weekly 的 weekStart
   * - lastPersonalReviewDate: 上次成功生成 personal_daily_review 的 dateKey
   * - 修复：之前是内存变量（ReportScheduler.lastDailyReportDate），应用重启就丢
   *   → 应用没在 18:30 开着那一天就永远漏报
   */
  schedule: {
    lastDailyReportDate: string | null;
    lastWeeklyReportWeekStart: string | null;
    lastPersonalReviewDate: string | null;
  };
  /**
   * 首次启动引导是否已完成
   * - false：显示 Onboarding 组件
   * - true：进入正常主界面
   */
  onboardingCompleted: boolean;
  /**
   * 调试模式（供开发者排查数据流问题）
   * - enabled：总开关，开启后主导航出现「调试」入口，Logger devDebug 生效，各层收集丢弃事件
   * - verboseModelIO：额外记录完整模型输入输出到 model_jobs.raw_input_json（开销较大，单独控制）
   * 默认关闭，普通用户不可见
   */
  debug: {
    enabled: boolean;
    verboseModelIO: boolean;
  };
}

/**
 * 默认设置
 */
export const DEFAULT_SETTINGS: AppSettings = {
  observation: {
    enabled: false,
    activeWindowStableSeconds: 30,
    contentChangeMinIntervalSeconds: 60,
    longSessionIntervalMinutes: 5,
    idleThresholdSeconds: 120,
  },
  screenshot: {
    retentionPolicy: "today",
  },
  notification: {
    inAppReminders: true,
    desktopNotifications: false,
    dailyReportTime: "19:00",
    weeklyReportTime: "20:00",
  },
  endOfDayReview: {
    enabled: true,
    firstTime: "17:30",
    secondTime: "18:00",
  },
  dailyReport: {
    autoGenerate: false,
    time: "19:00",
  },
  personalReview: {
    autoGenerate: false,
    time: "23:00",
  },
  schedule: {
    lastDailyReportDate: null,
    lastWeeklyReportWeekStart: null,
    lastPersonalReviewDate: null,
  },
  onboardingCompleted: false,
  debug: {
    enabled: false,
    verboseModelIO: false,
  },
};

/**
 * 调试事件（管道各层丢弃/跳过记录）
 *
 * 仅在调试模式开启时由各 Worker 收集，最终写入 model_jobs.debug_events_json。
 * 用于 DebugPage 展示「数据卡在哪一层」的逐项原因。
 */
export interface DebugEvent {
  /** 发生丢弃的层级 */
  layer: "L0" | "L1" | "L2" | "L3" | "proactive";
  /** 丢弃动作类型 */
  action: "discard" | "skip" | "dedup" | "downgrade" | "fallback";
  /** 人类可读原因（英文短语，前端直接展示） */
  reason: string;
  /** 被丢弃项的 id（如有） */
  itemId?: string;
  /** 批次模式下的帧序号（仅 L0/L1 批次相关事件） */
  frameIndex?: number;
  /** L3 dedup 命中时的目标对象类型（project/task/person/decision） */
  targetType?: string;
}

// ============================================================================
// 记忆系统重构：关系层 Edge
// ============================================================================

export type MemoryNodeType =
  | "capture"
  | "moment"
  | "episode"
  | "atom"
  | "object"
  | "report"
  // 兼容当前旧表命名，后续迁移时逐步收敛到 moment/episode/atom/object
  | "observation"
  | "scene"
  | "fact"
  | "project"
  | "task"
  | "person"
  | "decision"
  | "preference"
  | "knowledge";

export type MemoryRelationType =
  | "contains"
  | "derived_from"
  | "mentions"
  | "belongs_to"
  | "updates"
  | "continues"
  | "duplicates"
  | "contradicts"
  | "depends_on"
  | "involves"
  | "supports"
  | "uses";

export type MemoryEdgeStatus = "active" | "pending" | "rejected" | "superseded";
export type MemoryEdgeCreatedBy = "system" | "model" | "user";

export interface MemoryEdge {
  id: string;
  fromType: MemoryNodeType;
  fromId: string;
  toType: MemoryNodeType;
  toId: string;
  relationType: MemoryRelationType;
  confidence: number;
  createdBy: MemoryEdgeCreatedBy;
  evidenceIds: string[];
  status: MemoryEdgeStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateMemoryEdgeInput = Omit<
  MemoryEdge,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
  confidence?: number;
  evidenceIds?: string[];
  status?: MemoryEdgeStatus;
  reason?: string | null;
};

/**
 * CaptureBundle（来自 03_AI_PIPELINE_AND_MODEL_CONTRACTS.md）
 *
 * 视觉模型 API 通常只接收图片和文本。实现时把 metadata 写进 prompt，
 * 把 stitchedImagePath 或多张 imagePaths 作为 image input。
 */
export interface CaptureBundle {
  captureId: string;
  capturedAt: string;
  timezone: string;
  appName: string;
  windowTitle: string;
  urlOrDomain?: string;
  captureReason:
    | "window_focus_changed"
    | "window_title_changed"
    | "active_input_session"
    | "content_changed"
    | "scene_boundary"
    | "daily_preflight"
    | "long_session"
    | "project_switch"
    | "manual_capture";
  activitySignals: {
    keyboardActive: boolean;
    mouseActive: boolean;
    idleSeconds: number;
    activeWindowStableSeconds: number;
  };
  previousObservationSummary?: string;
  recentSceneSummary?: string;
  imagePaths: string[];
  stitchedImagePath?: string;
  retentionPolicy: "delete_immediately" | "1h" | "6h" | "today" | "3d" | "7d";
}

/**
 * 批次 CaptureBundle（攒批多帧合并提交，默认 6 帧）
 *
 * 由 CaptureBatcher 攒批后产出，交 MemoryPipeline.processBatchCaptureBundle 处理。
 * - frames：原始的多条单帧 CaptureBundle（保留帧级元数据，用于 normalizer 落 observation）
 * - compressedImagePaths：每帧 resize 到 800px 宽 + JPEG q=25 的临时文件路径
 *   由 CaptureBatcher.compressImages 生成，使用后由调用方负责清理
 */
export interface BatchCaptureBundle {
  /** 批次唯一 id */
  batchId: string;
  /** 多个单帧 bundle（按时间顺序；当前默认 6 帧） */
  frames: CaptureBundle[];
  /** 首帧捕获时间（UTC ISO 8601 with Z） */
  capturedAtStart: string;
  /** 末帧捕获时间（UTC ISO 8601 with Z） */
  capturedAtEnd: string;
  /** 时区（与单帧 bundle 一致） */
  timezone: string;
  /** 主帧 appName（取中位帧） */
  appName: string;
  /** 主帧 windowTitle（取中位帧） */
  windowTitle: string;
  /** 批次触发原因 */
  captureReason: CaptureBundle["captureReason"] | "batch_flush";
  /** 原始截图路径（扁平化 frames[].imagePaths） */
  imagePaths: string[];
  /** 压缩后的 JPEG q=25 临时文件路径 */
  compressedImagePaths: string[];
  /** 截图保留策略（取首帧） */
  retentionPolicy: ScreenshotRetentionPolicy;
}

/**
 * 截图保留策略类型（与 CaptureBundle.retentionPolicy 一致）
 */
export type ScreenshotRetentionPolicy =
  | "delete_immediately"
  | "1h"
  | "6h"
  | "today"
  | "3d"
  | "7d";

// ============================================================================
// Repository 领域类型（JSON 字段已 parse 为数组/对象）
// ============================================================================

/**
 * L0 Observation 领域模型
 *
 * Phase 2 V2 体验字段（008 迁移新增，均可空）：
 * - userFacingSummary：面向用户的 30-80 字摘要
 * - likelyWorkPurpose：用户可能在完成什么工作目的
 * - privacyRisk：隐私风险等级
 * - reportableSignal：是否适合未来进入工作日报
 */
export interface Observation {
  id: string;
  captureId: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  urlOrDomain: string | null;
  captureReason: string;
  sceneSummary: string;
  visibleContent: unknown[];
  detectedEntities: unknown[];
  possibleIntent: string | null;
  possibleTasks: unknown[];
  possibleDecisions: unknown[];
  sensitivity: string;
  confidence: number;
  uncertainties: string[];
  screenshotRetention: ScreenshotRetentionPolicy;
  screenshotPaths: string[];
  createdAt: string;
  /** V2：面向用户的简短摘要 */
  userFacingSummary?: string | null;
  /** V2：用户可能的工作目的 */
  likelyWorkPurpose?: string | null;
  /** V2：隐私风险等级 */
  privacyRisk?: "low" | "medium" | "high" | null;
  /** V2：是否适合进入工作日报 */
  reportableSignal?: "yes" | "maybe" | "no" | null;
}

/**
 * L1 Fact 领域模型
 *
 * Phase 2 V2 体验字段（008 迁移新增，均可空）：
 * - displayUse：标记 fact 适合如何使用（JSON 数组存 TEXT）
 * - reportable：是否适合进入工作日报（INTEGER 0/1）
 * - privateRisk：隐私风险等级
 * - userValue：对用户的长期价值
 */
export interface Fact {
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
  /** V2：适合的使用场景（timeline/personal_review/work_report/memory/task_list） */
  displayUse?: string[] | null;
  /** V2：是否适合进入工作日报 */
  reportable?: boolean | null;
  /** V2：隐私风险等级 */
  privateRisk?: "low" | "medium" | "high" | null;
  /** V2：对用户的长期价值 */
  userValue?: "low" | "medium" | "high" | null;
  /** 011 新增：抽取到的人物名候选数组（Linker 触发 person 入库的关键输入） */
  peopleHints?: string[] | null;
  sourceEpisodeIds: string[];
  claimStatus: "candidate" | "active" | "corrected" | "rejected" | "superseded" | "retracted";
  generationPath: string | null;
  generationVersion: number;
  derivationKey: string | null;
}

/**
 * L2 Scene 领域模型
 */
export interface Scene {
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
  taskIds: string[];
  decisionIds: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  derivationKey: string | null;
  derivationVersion: number;
}

/**
 * L3 Project 领域模型
 */
export interface Project {
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
  /** 003 字段：标记仅由被删 facts 支撑的对象，取值 'ok'/'needs_review'/'source_deleted' */
  orphanStatus?: string | null;
  /**
   * 012 字段：别名列表（合并过的旧名字）
   * - 例：项目「耀石锂电薪资」合并过「工资计算」「外包薪酬核算」，则 to.aliases = ['工资计算', '外包薪酬核算']
   * - Extractor / Linker prompt 注入该字段，避免再次识别成同义新项目
   */
  aliases?: string[];
}

/**
 * L3 Task 领域模型
 */
export interface Task {
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

/**
 * L3 Person 领域模型
 */
export interface Person {
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
  /**
   * 012 字段：别名列表（合并过的旧名字）
   * - 例：人物「陈章」合并过「陈章（耀石锂电 hr）」「耀石锂电 hr」，则 to.aliases = ['陈章（耀石锂电 hr）', '耀石锂电 hr']
   * - Extractor / Linker prompt 注入该字段，避免再次识别成同义新人
   */
  aliases?: string[];
}

/**
 * L3 Decision 领域模型
 */
export interface Decision {
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

/**
 * ProactiveItem 领域模型
 */
export interface ProactiveItem {
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
  /**
   * 013 字段：payload JSON 字符串（用于存类型相关自定义数据）
   * - merge_suggestion 类型：{objectType, fromId, toId, fromName, toName, reason, confidence}
   * - 其他类型：暂未使用
   */
  payloadJson?: string | null;
}

/**
 * Report 领域模型
 */
export interface Report {
  id: string;
  type: string;
  dateKey: string;
  title: string;
  contentJson: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
  /** 003 字段：是否需要重新生成（来源已被删除） */
  isStale?: number;
  /** 003 字段：stale 原因 */
  staleReason?: string | null;
  /** 003 字段：标记 stale 的时间 */
  staleAt?: string | null;
  /** 010 字段：关联项目 ID（用于历史报告按项目过滤） */
  projectId?: string | null;
}

/**
 * UserFeedback 领域模型
 */
export interface UserFeedback {
  id: string;
  targetType: string;
  targetId: string;
  feedbackType: string;
  note: string | null;
  createdAt: string;
}

/**
 * ModelJob 领域模型
 */
export interface ModelJob {
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
}

/**
 * 012 字段：对象合并审计记录（object_merges 表）
 * - 记录每次合并的 from/to/source，供追溯和别名学习
 * - 不参与业务逻辑查询
 */
export interface ObjectMerge {
  id: string;
  objectType: "project" | "task" | "person" | "decision";
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  source: "user_manual" | "linker_suggestion";
  reason: string | null;
  rewrittenFactsCount: number;
  rewrittenScenesCount: number;
  createdAt: string;
}

// ============================================================================
// Repository 输入类型（创建/更新时使用）
// ============================================================================

export type CreateObservationInput = Omit<Observation, "id" | "createdAt"> & {
  id?: string;
};

export type CreateFactInput = Omit<Fact, "id" | "createdAt" | "updatedAt" | "deletedAt" | "sourceEpisodeIds" | "claimStatus" | "generationPath" | "generationVersion" | "derivationKey"> & {
  id?: string;
  sourceEpisodeIds?: string[];
  claimStatus?: Fact["claimStatus"];
  generationPath?: string | null;
  generationVersion?: number;
  derivationKey?: string | null;
};

export type UpdateFactInput = Partial<Omit<Fact, "id" | "createdAt" | "updatedAt" | "deletedAt">>;

export type CreateSceneInput = Omit<Scene, "id" | "createdAt" | "updatedAt" | "deletedAt" | "derivationKey" | "derivationVersion"> & {
  id?: string;
  derivationKey?: string | null;
  derivationVersion?: number;
};

export type CreateReportInput = Omit<Report, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export type CreateModelConfigInput = {
  id?: string;
  kind: "vision" | "language" | "multimodal";
  providerName: string;
  endpoint: string;
  model: string;
  optionsJson?: string;
  enabled?: boolean;
};

export type UpdateModelConfigInput = Partial<Omit<CreateModelConfigInput, "kind">>;

export type CreatePrivacyRuleInput = {
  id?: string;
  type: "app_name" | "window_title_keyword" | "domain_keyword";
  pattern: string;
  action: "exclude" | "ask_before_capture" | "blur_sensitive";
  enabled?: boolean;
};

export type UpdatePrivacyRuleInput = Partial<Omit<CreatePrivacyRuleInput, "type">>;

export type CreateUserFeedbackInput = {
  id?: string;
  targetType: string;
  targetId: string;
  feedbackType: string;
  note?: string | null;
};

// ============================================================================
// Phase 2 新增类型（doc 19 / doc 20 / spec.md Phase 2）
// ============================================================================
// 体验升级引入：
// - Observer / Extractor 输出 V2（增加体验字段）
// - TimelineBuilder worker（今日时间轴）
// - PersonalReviewWriter worker（自用复盘）
// - WorkReportWriter worker（工作日报）
// - Judge 输出 V2（新增 unfinishedThreads）
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
 * TimelineBuilder 输出中的 block 项（LLM 输出结构，id 可选，无 createdAt/updatedAt）
 *
 * 与持久化的 TimelineBlock（shared/types.ts）区别：
 * - id 可选（LLM 可能不生成，由应用层补）
 * - 无 createdAt/updatedAt（由 Repository 写入时填充）
 * - 包含 privateRiskReason / confidence（LLM 输出有，持久化时合并到 TimelineBlock）
 *
 * spec.md 行 722-752
 */
export interface TimelineBlockOutputItem {
  id?: string;
  startAt?: string;
  endAt?: string;
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
  privateRiskReason: string;
  sourceSceneIds: string[];
  sourceFactIds: string[];
  sourceObservationIds: string[];
  confidence: number;
}

/**
 * Observer 输出 V2（doc 20 第 3 节 / spec.md 行 513-539）
 *
 * 在原 VisionObservationOutput 基础上新增体验字段：
 * - userFacingSummary：面向用户的 30-80 字摘要（不诗化、不像监控）
 * - likelyWorkPurpose：用户可能在完成什么工作目的
 * - privacyRisk：隐私风险等级
 * - reportableSignal：是否适合未来进入工作日报
 * - sensitivity：内容敏感度
 */
export interface ObserverOutputV2 {
  /** 批次模型输出对应的输入图片序号（1-based）；单帧输出可省略 */
  frameIndex?: number;
  sceneSummary: string;
  userFacingSummary: string;
  likelyWorkPurpose: string;
  visibleContent: Array<{
    type:
      | "webpage"
      | "document"
      | "chat"
      | "code"
      | "spreadsheet"
      | "design"
      | "email"
      | "terminal"
      | "unknown";
    summary: string;
    keyTextSnippets: string[];
  }>;
  detectedEntities: Array<{
    name: string;
    type:
      | "person"
      | "product"
      | "project"
      | "company"
      | "file"
      | "url"
      | "concept"
      | "other";
    evidence: string;
    confidence: number;
  }>;
  possibleUserIntent: string;
  possibleTasks: Array<{ text: string; confidence: number; evidence: string }>;
  possibleDecisions: Array<{ text: string; confidence: number; evidence: string }>;
  possibleProjectProgress: Array<{
    text: string;
    projectHint?: string;
    confidence: number;
    evidence: string;
  }>;
  privacyRisk: "low" | "medium" | "high";
  privacyRiskReason: string;
  reportableSignal: "yes" | "maybe" | "no";
  reportableReason: string;
  sensitivity: "normal" | "possibly_sensitive" | "high_sensitive";
  confidence: number;
  uncertainties: string[];
}

/**
 * Extractor 输出 V2 中的 fact 项（doc 20 第 4 节 / spec.md 行 610-626）
 *
 * 在原 ExtractorOutput.facts 基础上新增体验字段：
 * - displayUse：标记 fact 适合如何使用（timeline/personal_review/work_report/memory/task_list）
 * - reportable：是否适合进入工作日报
 * - privateRisk：隐私风险等级
 * - userValue：对用户的长期价值
 */
export interface ExtractorFactV2 {
  type:
    | "task"
    | "decision"
    | "project_progress"
    | "person"
    | "preference"
    | "knowledge"
    | "risk"
    | "question"
    | "note";
  content: string;
  status?: "open" | "in_progress" | "likely_done" | "done" | "blocked" | "unknown";
  projectHint?: string;
  peopleHints: string[];
  importance: number;
  confidence: number;
  inferred: boolean;
  evidenceText: string;
  sourceObservationIds: string[];
  tags: string[];
  displayUse: Array<
    "timeline" | "personal_review" | "work_report" | "memory" | "task_list"
  >;
  reportable: boolean;
  privateRisk: "low" | "medium" | "high";
  userValue: "low" | "medium" | "high";
}

/**
 * Extractor 输出 V2（doc 20 第 4 节 / spec.md 行 609-628）
 */
export interface ExtractorOutputV2 {
  facts: ExtractorFactV2[];
  discardedNoise: Array<{ reason: string; text: string }>;
}

/**
 * TimelineBuilder 输入（doc 20 第 5 节 / spec.md 行 651-685）
 */
export interface TimelineBuilderInput {
  dateKey: string;
  existingBlocks?: TimelineBlock[];
  observations: Array<{
    id: string;
    capturedAt: string;
    appName: string;
    windowTitle: string;
    sceneSummary: string;
    userFacingSummary?: string;
    likelyWorkPurpose?: string;
    privacyRisk?: "low" | "medium" | "high";
    reportableSignal?: "yes" | "maybe" | "no";
  }>;
  facts: Array<{
    id: string;
    type: string;
    content: string;
    projectId?: string;
    projectHint?: string;
    confidence: number;
    importance: number;
    displayUse?: string[];
    reportable?: boolean;
    privateRisk?: "low" | "medium" | "high";
    sourceObservationIds: string[];
  }>;
  scenes: Array<{
    id: string;
    title: string;
    summary: string;
    startAt: string;
    endAt: string;
    projectId?: string | null;
    factIds: string[];
    observationIds: string[];
    entityNames?: string[];
    confidence?: number;
  }>;
}

/**
 * TimelineBuilder 输出（doc 20 第 5 节 / spec.md 行 718-753）
 */
export interface TimelineBuilderOutput {
  dateKey: string;
  dayStartSummary: string;
  dayMainThread: string;
  blocks: TimelineBlockOutputItem[];
}

/**
 * PersonalReviewWriter 输入（doc 20 第 7 节 / spec.md 行 863-870）
 */
export interface PersonalReviewInput {
  dateKey: string;
  timelineBlocks: TimelineBlock[];
  unfinishedThreads: UnfinishedThread[];
  decisions: Fact[];
  memoriesWorthKeeping: Fact[];
  userPreferenceSummary?: string;
}

/**
 * PersonalReviewWriter 输出（doc 20 第 7 节 / spec.md 行 909-927）
 *
 * 注意：与 shared/types.ts 的 PersonalReview 区别：
 * - PersonalReviewOutput 是 LLM 输出结构（含 dateKey / title）
 * - PersonalReview 是持久化后的实体（含 id / createdAt / updatedAt）
 */
export interface PersonalReviewOutput {
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
}

/**
 * WorkReportWriter 输入（doc 20 第 8 节 / spec.md 行 974-980）
 *
 * 重要约束：selectedTimelineBlocks 必须是用户勾选或系统预选后用户确认的 block，
 * 不允许传入未确认的 block。
 */
export interface WorkReportInput {
  dateKey: string;
  selectedTimelineBlocks: TimelineBlock[];
  selectedFacts: Fact[];
  style: "brief" | "standard" | "formal";
  recipientHint?: "manager" | "team" | "client" | "self";
}

/**
 * WorkReportWriter 输出（doc 20 第 8 节 / spec.md 行 1012-1026）
 *
 * 注意：与 shared/types.ts 的 WorkReport 区别：
 * - WorkReportOutput 是 LLM 输出结构（含 dateKey / title）
 * - WorkReport 是持久化后的实体（含 id / createdAt / updatedAt）
 */
export interface WorkReportOutput {
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
}

/**
 * Judge 输出 V2（doc 20 第 6 节 / spec.md 行 812-833）
 *
 * 在原 JudgeOutput 基础上新增：
 * - unfinishedThreads：未收尾事项（少打扰，仅明确承诺/未完成/阻塞/明天继续）
 *
 * proactiveItems.type 收窄为 5 类（task_reminder / risk_warning /
 * decision_review / tomorrow_suggestion / needs_confirmation）。
 */
export interface JudgeOutputV2 {
  unfinishedThreads: Array<{
    title: string;
    reason: string;
    suggestedNextAction: string;
    priority: "low" | "medium" | "high";
    sourceFactIds: string[];
    sourceTimelineBlockIds: string[];
    confidence: number;
  }>;
  proactiveItems: Array<{
    type:
      | "task_reminder"
      | "risk_warning"
      | "decision_review"
      | "tomorrow_suggestion"
      | "needs_confirmation";
    title: string;
    body: string;
    reason: string;
    priority: number;
    surface: "in_app" | "daily_report" | "desktop_notification_candidate";
    requiresUserConfirmation: boolean;
    sourceFactIds: string[];
    sourceSceneIds: string[];
  }>;
}

/**
 * ProactiveItem V2（Phase 2 扩展）
 *
 * 在原 ProactiveItem 基础上新增 sourceTimelineBlockIds，
 * 用于追溯 proactive item 来自哪些 timeline block。
 */
export interface ProactiveItemV2 extends ProactiveItem {
  sourceTimelineBlockIds?: string[];
}
