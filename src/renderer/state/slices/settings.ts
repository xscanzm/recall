// src/renderer/state/slices/settings.ts
// 设置：模型配置、隐私规则、应用设置、数据导出与清理
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, ModelConfigItem, PrivacyRuleItem, AppSettingsState, DataExportResult } from "../types";
import { getIpc } from "../ipc";
import { clearAllDataAction, clearScreenshotsOnlyAction, exportDataAction, forgetRecentAction, getCacheSizeAction } from "../searchDataActions";
import { EMPTY_TODAY } from "../defaults";

export interface SettingsSlice {

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
  forgetRecent: (duration: "15m" | "30m" | "1h" | "today") => Promise<{
    deletedObservations: number;
    deletedScreenshots: number;
  }>;

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
}

export const createSettingsSlice: AppSliceCreator<SettingsSlice> = (set, get) => ({

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
      const list = await getIpc().privacy.listRules();
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
      const settings = await getIpc().settings.get();
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
      const result = await getIpc().settings.update(patch);
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
  forgetRecent: async (duration) => {
    return forgetRecentAction(set as never, get as never, EMPTY_TODAY, duration);
  },

  // ============================================================================
  // M8 新增动作：模型配置 / 隐私规则 / 设置 / 数据导出
  // ============================================================================

  /**
   * 加载模型配置列表（不返回 API Key）
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
});
