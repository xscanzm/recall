// src/renderer/state/store.ts
// 全局状态管理（Zustand）
//
// M0：维护 AppStatus、当前激活页面、首次启动标志
// M5：扩展 todayData（今日记忆数据）、reminders（提醒列表）、加载动作
// M7：扩展 tasks/projects/search/ask/projectDetail 状态和动作
// M8：扩展 modelConfigs/privacyRules/settings 状态与 CRUD 动作、数据导出/清空

import { create } from "zustand";
import type { AppStatus } from "../../shared/types";
import { getIpc } from "./ipc";

export type PageKey =
  | "today"
  | "reminders"
  | "tasks"
  | "projects"
  | "reports"
  | "memory"
  | "settings"
  | "trust";

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
  type: "fact" | "scene" | "task" | "project" | "decision" | "report" | "person";
  title: string;
  summary?: string;
  createdAt: string;
  projectName?: string;
  projectId?: string | null;
  sourceType?: "observation" | "fact" | "scene" | "project" | "report";
  sourceId?: string | null;
}

/**
 * 轻量问答来源对象
 */
export interface AskSourceItem {
  id: string;
  type: "fact" | "scene" | "task" | "project" | "decision" | "report" | "person";
  title: string;
  summary?: string;
}

/**
 * 轻量问答结果
 */
export interface AskResult {
  ok: boolean;
  answer?: string;
  sources?: AskSourceItem[];
  searchCount?: number;
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
  kind: "vision" | "language";
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
  dailyReport: {
    autoGenerate: boolean;
    time: string;
  };
  onboardingCompleted: boolean;
}

/**
 * 数据导出结果
 */
export interface DataExportResult {
  meta: {
    version: string;
    exportedAt: string;
    includeScreenshots: boolean;
  };
  observations: unknown[];
  facts: unknown[];
  scenes: unknown[];
  tasks: unknown[];
  decisions: unknown[];
  people: unknown[];
  projects: unknown[];
  reports: unknown[];
}

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
  searchLoading: boolean;
  searchError: string | null;
  searchSearched: boolean; // 是否已执行过搜索

  // M7 新增：轻量问答
  askQuestion: string;
  askResult: AskResult | null;
  askLoading: boolean;
  askError: string | null;

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
  searchMemory: (query: string, limit?: number, offset?: number) => Promise<void>;
  askMemory: (question: string, limit?: number) => Promise<void>;
  loadProjectDetail: (id: string) => Promise<void>;
  clearProjectDetail: () => void;
  updateTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
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
  }) => Promise<void>;
  forgetRecent: (duration: "15m" | "30m" | "1h" | "today") => Promise<{
    deletedObservations: number;
    deletedScreenshots: number;
  }>;

  // M8 新增：模型配置 CRUD
  loadModelConfigs: () => Promise<void>;
  saveModelConfig: (input: {
    id?: string;
    kind: "vision" | "language";
    providerName: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    enabled?: boolean;
  }) => Promise<{ ok: boolean; warning?: string; error?: string }>;
  deleteModelConfig: (id: string) => Promise<{ ok: boolean; error?: string }>;
  testModelConnection: (input: {
    kind: "vision" | "language";
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

  // M8 新增：数据导出 / 清空 / 缓存大小
  exportData: (input: { includeScreenshots?: boolean }) => Promise<{
    ok: boolean;
    data?: DataExportResult;
    error?: string;
  }>;
  clearAllData: () => Promise<{ ok: boolean; deletedScreenshots?: number; error?: string }>;
  getCacheSize: () => Promise<{ ok: boolean; bytes: number; fileCount: number }>;
}

/**
 * 默认 AppStatus（与 main 进程 createInitialAppStatus 保持一致）
 */
const DEFAULT_APP_STATUS: AppStatus = {
  observing: false,
  paused: false,
  pipelineState: "idle",
};

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
  searchLoading: false,
  searchError: null,
  searchSearched: false,

  // M7 新增：问答状态
  askQuestion: "",
  askResult: null,
  askLoading: false,
  askError: null,

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
  searchMemory: async (query: string, limit = 50, offset = 0) => {
    if (!query.trim()) return;
    set({
      searchLoading: true,
      searchError: null,
      searchQuery: query,
    });
    try {
      const result = await getIpc().memory.search<SearchResultItem>({
        query: query.trim(),
        limit,
        offset,
      });
      set({
        searchResults: result?.results ?? [],
        searchLoading: false,
        searchSearched: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ searchLoading: false, searchError: message, searchSearched: true });
    }
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
  askMemory: async (question: string, limit = 10) => {
    if (!question.trim()) return;
    set({
      askLoading: true,
      askError: null,
      askQuestion: question,
      askResult: null,
    });
    try {
      const result = await getIpc().memory.ask({ question: question.trim(), limit });
      set({
        askResult: result,
        askLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        askLoading: false,
        askError: message,
        askResult: { ok: false, code: "unknown_error", message },
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
   */
  mergeObjects: async (input) => {
    try {
      await getIpc().memory.mergeObjects(input);
      // 合并后重新加载今日数据
      await get().loadToday();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 忘掉最近（调用 capture:forgetRecent IPC）
   * - 删除对应时间范围内截图缓存（硬删除）
   * - 删除对应 observation
   * - 删除或 soft delete 关联 facts/scenes（由 main 端实现）
   */
  forgetRecent: async (duration) => {
    const result = await getIpc().capture.forgetRecent({ duration });
    // 忘掉最近后重新加载今日数据
    await get().loadToday();
    return {
      deletedObservations: result.deletedObservations,
      deletedScreenshots: result.deletedScreenshots,
    };
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
    try {
      await getIpc().settings.update(patch);
      // 乐观更新本地设置
      const current = get().settings;
      if (current) {
        set({
          settings: {
            observation: patch.observation ?? current.observation,
            screenshot: patch.screenshot ?? current.screenshot,
            notification: patch.notification ?? current.notification,
            dailyReport: patch.dailyReport ?? current.dailyReport,
            onboardingCompleted:
              patch.onboardingCompleted ?? current.onboardingCompleted,
          },
        });
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 数据导出（JSON，默认不含截图）
   */
  exportData: async (input) => {
    try {
      const result = await getIpc().data.export(input);
      if (result.ok && result.export) {
        return { ok: true, data: result.export as DataExportResult };
      }
      return {
        ok: false,
        error: result.message ?? "导出失败",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 清空所有结构化记忆数据 + 截图缓存
   * 保留 settings / model_configs / privacy_rules / user_feedback
   */
  clearAllData: async () => {
    try {
      const result = await getIpc().data.clearAll();
      if (result.ok) {
        // 清空后重新加载今日数据
        await get().loadToday();
        return { ok: true, deletedScreenshots: result.deletedScreenshots };
      }
      return {
        ok: false,
        error: result.message ?? "清空失败",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  },

  /**
   * 查询截图缓存当前大小（字节数和文件数）
   */
  getCacheSize: async () => {
    try {
      return await getIpc().data.getCacheSize();
    } catch {
      return { ok: true, bytes: 0, fileCount: 0 };
    }
  },
}));
