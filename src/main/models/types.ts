// src/main/models/types.ts
// Main 进程内部使用的类型定义
// 注意：跨进程共享的类型应放在 src/shared/types.ts

import type { AppStatus, ModelConfig, PrivacyRule } from "../../shared/types";

/**
 * Re-export 共享类型，便于 main 内部统一从 @/models/types 引用
 */
export type { AppStatus, ModelConfig, PrivacyRule } from "../../shared/types";

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
  dailyReport: {
    autoGenerate: boolean;
    time: string; // HH:mm
  };
  /**
   * 首次启动引导是否已完成
   * - false：显示 Onboarding 组件
   * - true：进入正常主界面
   */
  onboardingCompleted: boolean;
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
    dailyReportTime: "18:30",
    weeklyReportTime: "20:00",
  },
  dailyReport: {
    autoGenerate: false,
    time: "18:30",
  },
  onboardingCompleted: false,
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
}

/**
 * L1 Fact 领域模型
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

// ============================================================================
// Repository 输入类型（创建/更新时使用）
// ============================================================================

export type CreateObservationInput = Omit<Observation, "id" | "createdAt"> & {
  id?: string;
};

export type CreateFactInput = Omit<Fact, "id" | "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
};

export type UpdateFactInput = Partial<Omit<Fact, "id" | "createdAt" | "updatedAt" | "deletedAt">>;

export type CreateSceneInput = Omit<Scene, "id" | "createdAt" | "updatedAt" | "deletedAt"> & {
  id?: string;
};

export type CreateReportInput = Omit<Report, "id" | "createdAt" | "updatedAt"> & {
  id?: string;
};

export type CreateModelConfigInput = {
  id?: string;
  kind: "vision" | "language";
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
