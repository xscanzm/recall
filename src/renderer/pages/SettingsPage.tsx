// src/renderer/pages/SettingsPage.tsx
// 设置页（Phase 7 重构，spec 行 2300-2401）
//
// 6 分区布局：
// 1. 模型配置（视觉 + 语言分开，使用 ModelConfigForm）
// 2. 观察设置（开启/暂停、开机自动恢复、只观察活动窗口）
// 3. 截图保留（6 个保留策略 + 缓存大小 + 清空按钮）
// 4. 黑名单应用（使用 PrivacyRuleList，含默认建议提示）
// 5. 通知（应用内提醒默认开 / 桌面通知默认关 / 日报时间 / 周报时间）
// 6. 数据管理（导出 / 清空截图 / 忘掉15分钟 / 忘掉30分钟 / 删除今天 / 清空所有）
//
// 重要约束：
// - API Key 输入框 type=password（在 ModelConfigForm 中实现）
// - API Key 通过 SecretService 安全存储，不写入 SQLite
// - 危险操作（清空所有 / 删除今天 / 忘掉最近）必须二次确认
// - 二次确认对话框使用 store 中的 showConfirmDialog / requestConfirm / executeConfirm

import { useEffect, useState } from "react";
import { ModelConfigForm } from "../components/ModelConfigForm";
import { PrivacyRuleList } from "../components/PrivacyRuleList";
import { useAppStore, type ScreenshotRetentionPolicy } from "../state/store";
import { getIpc } from "../state/ipc";
import { renderSimpleMarkdown } from "../utils/simpleMarkdown";
// 打包时嵌入当前版本的更新说明（Vite ?raw import，构建时把 markdown 作为字符串嵌入 bundle）
import currentReleaseNotes from "../../../cloudflare/worker/release-notes.md?raw";

/**
 * 截图保留策略选项（spec 行 2344-2352）
 */
const RETENTION_OPTIONS: Array<{
  value: ScreenshotRetentionPolicy;
  label: string;
  description: string;
}> = [
  { value: "delete_immediately", label: "立即删除", description: "采集后立即删除，仅用于实时分析" },
  { value: "1h", label: "1 小时", description: "保留 1 小时" },
  { value: "6h", label: "6 小时", description: "保留 6 小时" },
  { value: "today", label: "当天", description: "次日启动时清理前一天截图（默认）" },
  { value: "3d", label: "3 天", description: "保留 3 天" },
  { value: "7d", label: "7 天", description: "保留 7 天" },
];

/**
 * 黑名单默认建议（spec 行 2371-2374）
 * 仅作为新增规则时的快捷预设，不会自动添加
 */
const BLACKLIST_PRESETS: Array<{
  type: "app_name" | "window_title_keyword" | "domain_keyword";
  pattern: string;
  label: string;
}> = [
  { type: "app_name", pattern: "1Password", label: "密码管理器（1Password）" },
  { type: "app_name", pattern: "银行", label: "银行支付类应用" },
  { type: "window_title_keyword", pattern: "password", label: "窗口标题含 password" },
  { type: "window_title_keyword", pattern: "医疗", label: "窗口标题含医疗" },
  { type: "domain_keyword", pattern: "bank.com", label: "域名含 bank.com" },
];

/**
 * 格式化字节数为可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function SettingsPage() {
  // 模型配置
  const modelConfigs = useAppStore((s) => s.modelConfigs);
  const modelConfigsLoading = useAppStore((s) => s.modelConfigsLoading);
  const modelConfigsError = useAppStore((s) => s.modelConfigsError);
  const loadModelConfigs = useAppStore((s) => s.loadModelConfigs);
  const saveModelConfig = useAppStore((s) => s.saveModelConfig);
  const deleteModelConfig = useAppStore((s) => s.deleteModelConfig);
  const testModelConnection = useAppStore((s) => s.testModelConnection);

  // 隐私规则
  const privacyRules = useAppStore((s) => s.privacyRules);
  const privacyRulesLoading = useAppStore((s) => s.privacyRulesLoading);
  const privacyRulesError = useAppStore((s) => s.privacyRulesError);
  const loadPrivacyRules = useAppStore((s) => s.loadPrivacyRules);
  const addPrivacyRule = useAppStore((s) => s.addPrivacyRule);
  const updatePrivacyRule = useAppStore((s) => s.updatePrivacyRule);
  const deletePrivacyRule = useAppStore((s) => s.deletePrivacyRule);

  // 应用设置
  const settings = useAppStore((s) => s.settings);
  const settingsLoading = useAppStore((s) => s.settingsLoading);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  // 应用状态（用于观察开启/暂停）
  const appStatus = useAppStore((s) => s.appStatus);

  // 数据操作
  const forgetRecent = useAppStore((s) => s.forgetRecent);
  const exportData = useAppStore((s) => s.exportData);
  const clearAllData = useAppStore((s) => s.clearAllData);
  const clearScreenshotsOnly = useAppStore((s) => s.clearScreenshotsOnly);
  const getCacheSize = useAppStore((s) => s.getCacheSize);

  // 二次确认对话框（触发用 requestConfirm，渲染由 AppShell 全局处理）
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const clearingData = useAppStore((s) => s.clearingData);
  const setClearingData = useAppStore((s) => s.setClearingData);

  // 版本更新
  const currentVersion = useAppStore((s) => s.currentVersion);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const checkForUpdate = useAppStore((s) => s.checkForUpdate);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    try {
      await checkForUpdate();
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  // 本地 UI 状态
  const [retentionPolicy, setRetentionPolicy] = useState<ScreenshotRetentionPolicy>("today");
  const [retentionSaving, setRetentionSaving] = useState(false);

  const [inAppReminders, setInAppReminders] = useState(true);
  const [desktopNotifications, setDesktopNotifications] = useState(false);
  const [dailyReportTime, setDailyReportTime] = useState("17:30");
  const [personalReviewTime, setPersonalReviewTime] = useState("22:00");
  const [weeklyReportTime, setWeeklyReportTime] = useState("20:00");
  const [endOfDayEnabled, setEndOfDayEnabled] = useState(true);
  const [endOfDayFirstTime, setEndOfDayFirstTime] = useState("17:30");
  const [endOfDaySecondTime, setEndOfDaySecondTime] = useState("18:00");
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [modelServiceSaving, setModelServiceSaving] = useState(false);

  // 观察状态切换 loading
  const [observationToggling, setObservationToggling] = useState(false);
  const [autoResumeSaving, setAutoResumeSaving] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [launchAtLoginLoading, setLaunchAtLoginLoading] = useState(true);
  const [launchAtLoginSaving, setLaunchAtLoginSaving] = useState(false);

  // 截图缓存
  const [cacheSize, setCacheSize] = useState<{ bytes: number; fileCount: number } | null>(null);

  // 数据导出
  const [includeScreenshots, setIncludeScreenshots] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMessage, setExportMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 操作结果消息（忘掉最近 / 清空截图 / 清空所有）
  const [actionMessage, setActionMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // 调试模式
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugVerboseModelIO, setDebugVerboseModelIO] = useState(false);
  const [debugSaving, setDebugSaving] = useState(false);

  // 初始化加载
  useEffect(() => {
    void loadModelConfigs();
    void loadPrivacyRules();
    void loadSettings();
    void refreshCacheSize();
    void refreshLaunchAtLogin();
    // 仅挂载时拉一次初始数据；这几个 loader 都是稳定引用（zustand action / useCallback）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // settings 加载完成后同步本地状态
  useEffect(() => {
    if (settings) {
      setRetentionPolicy(settings.screenshot.retentionPolicy);
      setInAppReminders(settings.notification.inAppReminders);
      setDesktopNotifications(settings.notification.desktopNotifications);
      setDailyReportTime(settings.notification.dailyReportTime);
      setPersonalReviewTime(settings.personalReview?.time ?? "22:00");
      setWeeklyReportTime(settings.notification.weeklyReportTime);
      setEndOfDayEnabled(settings.endOfDayReview?.enabled ?? true);
      setEndOfDayFirstTime(settings.endOfDayReview?.firstTime ?? "17:30");
      setEndOfDaySecondTime(settings.endOfDayReview?.secondTime ?? "18:00");
      setDebugEnabled(settings.debug?.enabled ?? false);
      setDebugVerboseModelIO(settings.debug?.verboseModelIO ?? false);
    }
  }, [settings]);

  /**
   * 刷新截图缓存大小
   */
  const refreshCacheSize = async () => {
    const result = await getCacheSize();
    setCacheSize({ bytes: result.bytes, fileCount: result.fileCount });
  };

  const refreshLaunchAtLogin = async () => {
    setLaunchAtLoginLoading(true);
    try {
      const result = await getIpc().app.getLaunchAtLogin();
      setLaunchAtLogin(result.enabled);
    } catch (err) {
      setActionMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "读取 Windows 自启动设置失败",
      });
    } finally {
      setLaunchAtLoginLoading(false);
    }
  };

  const handleModelServiceChange = async (useRecallDefault: boolean) => {
    setModelServiceSaving(true);
    const result = await updateSettings({
      defaultModelService: {
        consent: useRecallDefault ? "accepted" : "declined",
        acceptedAt: useRecallDefault ? new Date().toISOString() : null,
      },
    });
    if (!result.ok) {
      setActionMessage({ kind: "err", text: result.error ?? "模型服务设置保存失败" });
    }
    setModelServiceSaving(false);
  };

  // ============================================================================
  // 观察设置 handlers
  // ============================================================================

  /**
   * 开启 / 暂停观察
   * 调用 app:startObserving / app:pauseObserving IPC
   */
  const handleToggleObservation = async () => {
    setObservationToggling(true);
    setActionMessage(null);
    try {
      if (appStatus.paused || !appStatus.observing) {
        await getIpc().app.startObserving();
      } else {
        await getIpc().app.pauseObserving();
      }
    } catch (err) {
      setActionMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "切换观察状态失败",
      });
    } finally {
      setObservationToggling(false);
    }
  };

  /**
   * 切换"开机后自动恢复观察"
   * 持久化到 settings.observation.enabled 字段
   * 语义：true = 用户希望观察启用，开机后自动恢复；false = 开机后不自动开始
   */
  const handleAutoResumeChange = async (checked: boolean) => {
    const current = settings?.observation ?? {
      enabled: false,
      activeWindowStableSeconds: 30,
      contentChangeMinIntervalSeconds: 60,
      longSessionIntervalMinutes: 5,
      idleThresholdSeconds: 120,
    };
    setAutoResumeSaving(true);
    setActionMessage(null);
    try {
      const result = await updateSettings({
        observation: { ...current, enabled: checked },
      });
      if (!result.ok) {
        setActionMessage({ kind: "err", text: result.error ?? "保存失败" });
      }
    } finally {
      setAutoResumeSaving(false);
    }
  };

  const handleLaunchAtLoginChange = async (checked: boolean) => {
    const previous = launchAtLogin;
    setLaunchAtLogin(checked);
    setLaunchAtLoginSaving(true);
    setActionMessage(null);
    try {
      const result = await getIpc().app.setLaunchAtLogin({ enabled: checked });
      if (result.ok) {
        setLaunchAtLogin(result.enabled);
      } else {
        setActionMessage({ kind: "err", text: "保存 Windows 自启动设置失败" });
      }
    } catch (err) {
      setLaunchAtLogin(previous);
      setActionMessage({
        kind: "err",
        text: err instanceof Error ? err.message : "保存 Windows 自启动设置失败",
      });
    } finally {
      setLaunchAtLoginSaving(false);
    }
  };

  // ============================================================================
  // 截图保留 handlers
  // ============================================================================

  const handleSaveRetention = async () => {
    setRetentionSaving(true);
    setActionMessage(null);
    try {
      const result = await updateSettings({
        screenshot: { retentionPolicy },
      });
      if (!result.ok) {
        setActionMessage({ kind: "err", text: result.error ?? "保存失败" });
      } else {
        setActionMessage({ kind: "ok", text: "截图保留策略已保存" });
      }
    } finally {
      setRetentionSaving(false);
    }
  };

  /**
   * 清空截图缓存（数据管理分区也复用此函数）
   * 不是危险操作（截图硬删除但结构化记忆不受影响），但仍弹确认
   */
  const handleClearScreenshots = () => {
    requestConfirm({
      title: "清空截图缓存",
      message:
        "仅删除截图文件，结构化记忆（观察、线索、工作片段等）会保留。" +
        "如需同时清理观察记录，请使用「忘掉最近」或「删除今天数据」。",
      confirmText: "确认清空截图",
      onConfirm: async () => {
        setClearingData(true);
        setActionMessage(null);
        try {
          // 仅删除截图文件，不删除结构化记忆
          const result = await clearScreenshotsOnly();
          if (result.ok) {
            setActionMessage({
              kind: "ok",
              text: `已清空截图缓存：删除截图 ${result.deletedScreenshots ?? 0} 个`,
            });
          } else {
            setActionMessage({
              kind: "err",
              text: result.error ?? "清空失败",
            });
          }
          await refreshCacheSize();
        } catch (err) {
          setActionMessage({
            kind: "err",
            text: err instanceof Error ? err.message : "清空失败",
          });
        } finally {
          setClearingData(false);
        }
      },
    });
  };

  // ============================================================================
  // 通知 handlers
  // ============================================================================

  const handleSaveNotification = async () => {
    setNotificationSaving(true);
    setActionMessage(null);
    try {
      const result = await updateSettings({
          notification: {
            inAppReminders,
            desktopNotifications,
            dailyReportTime,
            weeklyReportTime,
          },
          endOfDayReview: {
            enabled: endOfDayEnabled,
            firstTime: endOfDayFirstTime,
            secondTime: endOfDaySecondTime,
          },
          personalReview: {
            // autoGenerate is retained for settings compatibility; scheduler no longer reads it.
            autoGenerate: settings?.personalReview?.autoGenerate ?? false,
            time: personalReviewTime,
          },
      });
      if (!result.ok) {
        setActionMessage({ kind: "err", text: result.error ?? "保存失败" });
      } else {
        setActionMessage({ kind: "ok", text: "通知设置已保存" });
      }
    } finally {
      setNotificationSaving(false);
    }
  };

  // ============================================================================
  // 数据管理 handlers
  // ============================================================================

  /**
   * 导出数据为 JSON 文件
   * 非危险操作，不弹确认
   */
  const handleExport = async () => {
    setExportLoading(true);
    setExportMessage(null);
    try {
      const result = await exportData({ includeScreenshots });
      if (result.ok && result.data) {
        const json = JSON.stringify(result.data, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10);
        a.download = `recall-export-${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        const meta = result.data.meta;
        setExportMessage({
          kind: "ok",
          text:
            `已导出（${meta.exportedAt}）：观察 ${result.data.observations.length} 条，` +
            `线索 ${result.data.facts.length} 条，工作片段 ${result.data.scenes.length} 条，` +
            `任务 ${result.data.tasks.length} 条，项目 ${result.data.projects.length} 个，` +
            `报告 ${result.data.reports.length} 篇。` +
            `${meta.includeScreenshots ? "（含截图路径）" : "（不含截图）"}`,
        });
      } else {
        setExportMessage({ kind: "err", text: result.error ?? "导出失败" });
      }
    } catch (err) {
      setExportMessage({ kind: "err", text: err instanceof Error ? err.message : "导出失败" });
    } finally {
      setExportLoading(false);
    }
  };

  /**
   * 忘掉最近 N 分钟（危险操作，二次确认）
   */
  const handleForgetRecent = (minutes: 15 | 30) => {
    requestConfirm({
      title: `忘掉最近 ${minutes} 分钟`,
      message:
        ` Recall 会硬删除最近 ${minutes} 分钟内的截图缓存和观察记录，` +
        "关联的线索/工作片段会被软删除（数据库中可恢复，但 UI 不再展示）。" +
        "引用这些线索的日报会被标记为需要重新生成。此操作不可撤销。",
      confirmText: `确认忘掉最近 ${minutes} 分钟`,
      onConfirm: async () => {
        setClearingData(true);
        setActionMessage(null);
        try {
          const result = await forgetRecent(minutes === 15 ? "15m" : "30m");
          setActionMessage({
            kind: "ok",
            text: `已忘掉最近 ${minutes} 分钟：删除观察 ${result.deletedObservations} 条，截图 ${result.deletedScreenshots} 个`,
          });
          await refreshCacheSize();
        } catch (err) {
          setActionMessage({
            kind: "err",
            text: err instanceof Error ? err.message : "忘掉最近失败",
          });
        } finally {
          setClearingData(false);
        }
      },
    });
  };

  /**
   * 删除今天数据（危险操作，二次确认）
   * 复用 forgetRecent("today")
   */
  const handleDeleteToday = () => {
    requestConfirm({
      title: "删除今天数据",
      message:
        "Recall 会硬删除今天全部截图缓存和观察记录，" +
        "关联的线索/工作片段会被软删除。此操作不可撤销。" +
        "如需保留部分内容，请先导出。",
      confirmText: "确认删除今天",
      onConfirm: async () => {
        setClearingData(true);
        setActionMessage(null);
        try {
          const result = await forgetRecent("today");
          setActionMessage({
            kind: "ok",
            text: `已删除今天数据：观察 ${result.deletedObservations} 条，截图 ${result.deletedScreenshots} 个`,
          });
          await refreshCacheSize();
        } catch (err) {
          setActionMessage({
            kind: "err",
            text: err instanceof Error ? err.message : "删除今天失败",
          });
        } finally {
          setClearingData(false);
        }
      },
    });
  };

  /**
   * 清空所有数据（危险操作，二次确认）
   */
  const handleClearAll = () => {
    requestConfirm({
      title: "清空所有数据",
      message:
        "此操作会清空所有结构化记忆数据（观察、线索、工作片段、任务、项目、决策、人物、报告）" +
        "和全部截图缓存。保留：设置、模型配置、隐私规则、用户反馈。\n\n" +
        "此操作不可恢复。如需保留数据，请先导出。",
      confirmText: "确认清空所有数据",
      onConfirm: async () => {
        setClearingData(true);
        setActionMessage(null);
        try {
          const result = await clearAllData();
          if (result.ok) {
            setActionMessage({
              kind: "ok",
              text:
                `已清空所有结构化记忆数据。删除截图 ${result.deletedScreenshots ?? 0} 个。` +
                "设置、模型配置、隐私规则已保留。",
            });
            await refreshCacheSize();
          } else {
            setActionMessage({ kind: "err", text: result.error ?? "清空失败" });
          }
        } catch (err) {
          setActionMessage({
            kind: "err",
            text: err instanceof Error ? err.message : "清空失败",
          });
        } finally {
          setClearingData(false);
        }
      },
    });
  };

  /**
   * 保存调试模式设置
   */
  const handleSaveDebug = async () => {
    setDebugSaving(true);
    await updateSettings({
      debug: {
        enabled: debugEnabled,
        verboseModelIO: debugVerboseModelIO,
      },
    });
    setDebugSaving(false);
  };

  // 按模型类型分组
  const visionConfigs = modelConfigs.filter((c) => c.kind === "vision");
  const languageConfigs = modelConfigs.filter((c) => c.kind === "language");
  const multimodalConfigs = modelConfigs.filter((c) => c.kind === "multimodal");

  // 观察状态描述
  const isObserving = appStatus.observing && !appStatus.paused;
  const observationStateLabel = isObserving ? "观察中" : "已暂停";
  const observationToggleLabel = isObserving ? "暂停观察" : "恢复观察";

  return (
    <div className="settings-page">
      <header className="page-header">
        <h2>设置</h2>
        <p className="page-header__sub">
          不配置自己 Key，使用 Recall 默认模型服务；也可以配置自己的模型直接调用。
        </p>
      </header>

      {/* ============ Section 1: 模型配置 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">1. 模型配置</h3>
          <p className="settings-section__hint">
            语言任务优先使用你的语言模型，其次使用你的多模态模型；图片任务优先使用你的视觉模型，其次使用你的多模态模型。没有可用的自有配置时才使用 Recall 默认服务。
          </p>
        </header>
        <div className="settings-section__content">
          <div className="settings-section__block">
            <h4 className="settings-section__subtitle">模型服务</h4>
            <div className="model-service-choice" role="radiogroup" aria-label="模型服务">
              <label className={settings?.defaultModelService?.consent === "accepted" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="settings-model-service"
                  checked={settings?.defaultModelService?.consent === "accepted"}
                  disabled={modelServiceSaving}
                  onChange={() => void handleModelServiceChange(true)}
                />
                <span><strong>使用 Recall 默认模型服务</strong>无需配置 API 地址和 Key。默认服务只统计匿名安装级调用，不记录内容。</span>
              </label>
              <label className={settings?.defaultModelService?.consent === "declined" ? "is-selected" : ""}>
                <input
                  type="radio"
                  name="settings-model-service"
                  checked={settings?.defaultModelService?.consent === "declined"}
                  disabled={modelServiceSaving}
                  onChange={() => void handleModelServiceChange(false)}
                />
                <span><strong>只使用自己的模型</strong>调用从本机直连你的 endpoint，不向 Recall 上报；配置失败会明确提示，不会自动切换。</span>
              </label>
            </div>
          </div>

          <div className="settings-section__block">
            <h4 className="settings-section__subtitle">自己的多模态模型</h4>
            <p className="settings-section__hint">
              可选。模型需兼容 OpenAI Chat Completions，并支持图片输入。
            </p>
            <ModelConfigForm
              kind="multimodal"
              configs={multimodalConfigs}
              loading={modelConfigsLoading}
              error={modelConfigsError}
              onSave={saveModelConfig}
              onDelete={deleteModelConfig}
              onTest={testModelConnection}
            />
          </div>

          <details className="settings-section__advanced">
            <summary>分别配置视觉模型与语言模型</summary>
            <p className="settings-section__hint">
              有对应配置时分别优先使用；缺少某一类配置时再使用上面的多模态模型。
            </p>

          <div className="settings-section__block">
            <h4 className="settings-section__subtitle">视觉模型</h4>
            <p className="settings-section__hint">
              用于分析屏幕截图，识别窗口内容、实体和可能意图。
            </p>
            <ModelConfigForm
              kind="vision"
              configs={visionConfigs}
              loading={modelConfigsLoading}
              error={modelConfigsError}
              onSave={saveModelConfig}
              onDelete={deleteModelConfig}
              onTest={testModelConnection}
            />
          </div>

          <div className="settings-section__block">
            <h4 className="settings-section__subtitle">语言模型</h4>
            <p className="settings-section__hint">
              用于提取线索、构建场景、生成报告和回答用户问题。
            </p>
            <ModelConfigForm
              kind="language"
              configs={languageConfigs}
              loading={modelConfigsLoading}
              error={modelConfigsError}
              onSave={saveModelConfig}
              onDelete={deleteModelConfig}
              onTest={testModelConnection}
            />
          </div>
          </details>
        </div>
      </section>

      {/* ============ Section 2: 观察设置 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">2. 观察设置</h3>
          <p className="settings-section__hint">
            Recall 只整理当前活动窗口的上下文，不做全屏录屏。
          </p>
        </header>
        <div className="settings-section__content">
          <div className="settings-section__row">
            <div className="settings-section__row-main">
              <span className="settings-section__row-label">当前观察状态</span>
              <span
                className={`settings-section__state-pill ${
                  isObserving ? "is-active" : "is-paused"
                }`}
              >
                {observationStateLabel}
              </span>
            </div>
            <button
              type="button"
              className={isObserving ? "btn btn-secondary" : "btn btn-primary"}
              onClick={handleToggleObservation}
              disabled={observationToggling}
            >
              {observationToggling ? "切换中..." : observationToggleLabel}
            </button>
          </div>

          <label className="settings-section__toggle">
            <input
              type="checkbox"
              checked={settings?.observation.enabled ?? false}
              onChange={(e) => handleAutoResumeChange(e.target.checked)}
              disabled={settingsLoading || autoResumeSaving}
            />
            <div className="settings-section__toggle-text">
              <span className="settings-section__toggle-label">开机后自动恢复观察</span>
              <p className="settings-section__hint">
                关闭后，每次启动 Recall 都需要手动点击恢复观察。
              </p>
            </div>
          </label>

          <label className="settings-section__toggle">
            <input
              type="checkbox"
              checked={launchAtLogin}
              onChange={(e) => handleLaunchAtLoginChange(e.target.checked)}
              disabled={launchAtLoginLoading || launchAtLoginSaving}
            />
            <div className="settings-section__toggle-text">
              <span className="settings-section__toggle-label">登录 Windows 后自动启动 Recall</span>
              <p className="settings-section__hint">
                适合早测长期使用。开启后应用随 Windows 登录启动，并按上方观察设置决定是否自动恢复观察。
              </p>
            </div>
          </label>

          <div className="settings-section__note">
            <span className="settings-section__note-icon" aria-hidden>✓</span>
            <span>只观察活动窗口（已默认启用）。Recall 不会录制全屏，也不会在你不操作时持续采集。</span>
          </div>
        </div>
      </section>

      {/* ============ Section 3: 截图保留 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">3. 截图保留</h3>
          <p className="settings-section__hint">
            截图用于模型理解，会按你的设置保存在本机。删除截图不会删除已经整理好的文字记忆。
          </p>
        </header>
        <div className="settings-section__content">
          <div className="retention-options" role="radiogroup" aria-label="截图保留策略">
            {RETENTION_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`retention-options__item ${
                  retentionPolicy === opt.value ? "is-selected" : ""
                }`}
              >
                <input
                  type="radio"
                  name="retention"
                  value={opt.value}
                  checked={retentionPolicy === opt.value}
                  onChange={() => setRetentionPolicy(opt.value)}
                />
                <div className="retention-options__label">
                  <span className="retention-options__name">{opt.label}</span>
                  <span className="retention-options__desc">{opt.description}</span>
                </div>
              </label>
            ))}
          </div>

          <div className="settings-section__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSaveRetention}
              disabled={retentionSaving || settingsLoading}
            >
              {retentionSaving ? "保存中..." : "保存保留策略"}
            </button>
          </div>

          <div className="cache-info">
            <div className="cache-info__text">
              <span className="cache-info__label">当前缓存</span>
              <span className="cache-info__value">
                {cacheSize ? `${formatBytes(cacheSize.bytes)} / ${cacheSize.fileCount} 个文件` : "加载中..."}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-secondary cache-info__clear-btn"
              onClick={handleClearScreenshots}
              disabled={clearingData}
            >
              {clearingData ? "清空中..." : "清空截图缓存"}
            </button>
          </div>
        </div>
      </section>

      {/* ============ Section 4: 黑名单应用 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">4. 黑名单应用</h3>
          <p className="settings-section__hint">
            匹配黑名单的应用、窗口标题或域名不会被采集、不会调用模型、不会保存任何数据。
          </p>
        </header>
        <div className="settings-section__content">
          <div className="settings-section__presets">
            <span className="settings-section__presets-label">默认建议（点击快速添加）：</span>
            <div className="settings-section__presets-list">
              {BLACKLIST_PRESETS.map((preset) => (
                <button
                  key={`${preset.type}:${preset.pattern}`}
                  type="button"
                  className="btn btn-secondary btn-sm settings-section__preset-btn"
                  onClick={() =>
                    addPrivacyRule({
                      type: preset.type,
                      pattern: preset.pattern,
                      action: "exclude",
                    })
                  }
                >
                  + {preset.label}
                </button>
              ))}
            </div>
          </div>

          <PrivacyRuleList
            rules={privacyRules}
            loading={privacyRulesLoading}
            error={privacyRulesError}
            onAdd={addPrivacyRule}
            onUpdate={updatePrivacyRule}
            onDelete={deletePrivacyRule}
            emptyHint="暂无黑名单规则。建议至少添加密码管理器、银行支付和医疗证件类规则。"
          />
        </div>
      </section>

      {/* ============ Section 5: 通知 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">5. 通知</h3>
          <p className="settings-section__hint">
            报告成功生成时会单独提示一次；其他桌面提醒仍由下方开关控制。
          </p>
        </header>
        <div className="settings-section__content">
          {settingsLoading ? (
            <p className="settings-section__hint">加载中...</p>
          ) : (
            <>
              <label className="settings-section__toggle">
                <input
                  type="checkbox"
                  checked={inAppReminders}
                  onChange={(e) => setInAppReminders(e.target.checked)}
                />
                <div className="settings-section__toggle-text">
                  <span className="settings-section__toggle-label">应用内提醒</span>
                  <p className="settings-section__hint">默认开启。在应用内显示提醒，不建议关闭。</p>
                </div>
              </label>

              <label className="settings-section__toggle">
                <input
                  type="checkbox"
                  checked={desktopNotifications}
                  onChange={(e) => setDesktopNotifications(e.target.checked)}
                />
                <div className="settings-section__toggle-text">
                  <span className="settings-section__toggle-label">桌面通知</span>
                  <p className="settings-section__hint">
                    默认关闭。开启后，高优先级记忆提醒也会显示在桌面；报告生成通知不受此开关影响。
                  </p>
                </div>
              </label>

              <div className="settings-form__row">
                <div className="settings-form__field">
                  <label>收工回顾第一次通知</label>
                  <input type="time" value={endOfDayFirstTime} onChange={(e) => setEndOfDayFirstTime(e.target.value)} disabled={!endOfDayEnabled} />
                  <p className="settings-form__hint">默认 17:30</p>
                </div>
                <div className="settings-form__field">
                  <label>收工回顾第二次通知</label>
                  <input type="time" value={endOfDaySecondTime} onChange={(e) => setEndOfDaySecondTime(e.target.value)} disabled={!endOfDayEnabled} />
                  <p className="settings-form__hint">默认 18:00，必须晚于第一次</p>
                </div>
              </div>

              <label className="settings-section__toggle">
                <input type="checkbox" checked={endOfDayEnabled} onChange={(e) => setEndOfDayEnabled(e.target.checked)} />
                <div className="settings-section__toggle-text">
                  <span className="settings-section__toggle-label">收工回顾通知</span>
                  <p className="settings-section__hint">每天在右下角显示今天完成和需要留意的事项。</p>
                </div>
              </label>

              <div className="settings-form__row">
                <div className="settings-form__field">
                  <label>日报时间</label>
                  <input
                    type="time"
                    value={dailyReportTime}
                    onChange={(e) => setDailyReportTime(e.target.value)}
                  />
                  <p className="settings-form__hint">每天此时间触发日报生成（默认 17:30）</p>
                </div>

                <div className="settings-form__field">
                  <label>周报时间</label>
                  <input
                    type="time"
                    value={weeklyReportTime}
                    onChange={(e) => setWeeklyReportTime(e.target.value)}
                  />
                  <p className="settings-form__hint">每周五此时间触发周报生成（默认 20:00）</p>
                </div>
              </div>

              <div className="settings-form__row">
                <div className="settings-form__field">
                  <label>个人复盘时间</label>
                  <input
                    type="time"
                    value={personalReviewTime}
                    onChange={(e) => setPersonalReviewTime(e.target.value)}
                  />
                  <p className="settings-form__hint">每天此时间自动生成个人复盘（默认 22:00）</p>
                </div>
              </div>

              <div className="settings-section__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveNotification}
                  disabled={notificationSaving}
                >
                  {notificationSaving ? "保存中..." : "保存通知设置"}
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* ============ Section 6: 数据管理 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">6. 数据管理</h3>
          <p className="settings-section__hint">
            导出、清空或忘掉最近的数据。危险操作需要二次确认。
          </p>
        </header>
        <div className="settings-section__content">
          {/* 导出数据 */}
          <div className="data-block">
            <div className="data-block__head">
              <h4 className="data-block__title">导出数据</h4>
              <p className="data-block__hint">
                导出为 JSON 文件，包含观察、线索、工作片段、任务、项目、决策、人物、报告。默认不包含截图路径。
              </p>
            </div>
            <label className="settings-section__toggle settings-section__toggle--inline">
              <input
                type="checkbox"
                checked={includeScreenshots}
                onChange={(e) => setIncludeScreenshots(e.target.checked)}
              />
              <span>包含截图路径（仅路径，不含文件本身）</span>
            </label>
            <div className="data-block__actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleExport}
                disabled={exportLoading || clearingData}
              >
                {exportLoading ? "导出中..." : "导出 JSON"}
              </button>
            </div>
            {exportMessage && (
              <p
                className={`data-block__message ${
                  exportMessage.kind === "ok" ? "is-ok" : "is-err"
                }`}
              >
                {exportMessage.text}
              </p>
            )}
          </div>

          {/* 清空截图缓存（非危险，但仍弹确认） */}
          <div className="data-block">
            <div className="data-block__head">
              <h4 className="data-block__title">清空截图缓存</h4>
              <p className="data-block__hint">
                硬删除全部截图文件，结构化记忆不受影响。
              </p>
            </div>
            <div className="data-block__actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleClearScreenshots}
                disabled={clearingData}
              >
                {clearingData ? "处理中..." : "清空截图缓存"}
              </button>
            </div>
          </div>

          {/* 危险操作分组 */}
          <div className="data-block data-block--danger">
            <div className="data-block__head">
              <h4 className="data-block__title">危险操作</h4>
              <p className="data-block__hint">
                以下操作不可撤销。如需保留数据，请先导出。
              </p>
            </div>

            <div className="data-block__danger-grid">
              <button
                type="button"
                className="btn btn-danger data-block__danger-btn"
                onClick={() => handleForgetRecent(15)}
                disabled={clearingData}
              >
                忘掉最近 15 分钟
              </button>
              <button
                type="button"
                className="btn btn-danger data-block__danger-btn"
                onClick={() => handleForgetRecent(30)}
                disabled={clearingData}
              >
                忘掉最近 30 分钟
              </button>
              <button
                type="button"
                className="btn btn-danger data-block__danger-btn"
                onClick={handleDeleteToday}
                disabled={clearingData}
              >
                删除今天数据
              </button>
              <button
                type="button"
                className="btn btn-danger data-block__danger-btn"
                onClick={handleClearAll}
                disabled={clearingData}
              >
                清空所有数据
              </button>
            </div>
          </div>

          {actionMessage && (
            <p
              className={`data-block__message ${
                actionMessage.kind === "ok" ? "is-ok" : "is-err"
              }`}
            >
              {actionMessage.text}
            </p>
          )}
        </div>
      </section>

      {/* ============ Section 7: 调试 ============ */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">7. 调试</h3>
          <p className="settings-section__hint">
            调试模式供开发者排查数据流问题。开启后会额外记录模型输入输出与各层丢弃事件。
          </p>
        </header>
        <div className="settings-section__content">
          {settingsLoading ? (
            <p className="settings-section__hint">加载中...</p>
          ) : (
            <>
              <div className="settings-section__note">
                <span className="settings-section__note-icon" aria-hidden>⚠️</span>
                <span>开启调试模式会增加磁盘占用（记录完整模型输入输出）。普通用户无需开启。</span>
              </div>

              <label className="settings-section__toggle">
                <input
                  type="checkbox"
                  checked={debugEnabled}
                  onChange={(e) => setDebugEnabled(e.target.checked)}
                />
                <div className="settings-section__toggle-text">
                  <span className="settings-section__toggle-label">开启调试模式</span>
                  <p className="settings-section__hint">
                    开启后主导航出现「调试」入口，各层开始收集丢弃事件。
                  </p>
                </div>
              </label>

              <label className="settings-section__toggle">
                <input
                  type="checkbox"
                  checked={debugVerboseModelIO}
                  onChange={(e) => setDebugVerboseModelIO(e.target.checked)}
                  disabled={!debugEnabled}
                />
                <div className="settings-section__toggle-text">
                  <span className="settings-section__toggle-label">记录完整模型输入输出</span>
                  <p className="settings-section__hint">
                    额外记录 prompt 上下文到 model_jobs.raw_input_json（开销较大）。需先开启调试模式。
                  </p>
                </div>
              </label>

              <div className="settings-section__actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSaveDebug}
                  disabled={debugSaving}
                >
                  {debugSaving ? "保存中..." : "保存调试设置"}
                </button>
              </div>
            </>
          )}
        </div>
      </section>

      {/* 8. 关于 */}
      <section className="settings-section">
        <header className="settings-section__header">
          <h3 className="settings-section__title">8. 关于</h3>
          <p className="settings-section__hint">当前版本与更新检查</p>
        </header>
        <div className="settings-section__content">
          <div className="settings-section__row">
            <span>当前版本</span>
            <span className="settings-section__value">v{currentVersion || "—"}</span>
          </div>

          {/* 当前版本更新说明（打包时嵌入，离线可用） */}
          {currentReleaseNotes && (
            <div className="settings-section__release-notes-wrap">
              <p className="settings-section__row-label">本次更新内容</p>
              <div className="settings-section__release-notes">
                {renderSimpleMarkdown(currentReleaseNotes)}
              </div>
            </div>
          )}

          <div className="settings-section__actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleCheckUpdate}
              disabled={isCheckingUpdate}
            >
              {isCheckingUpdate ? "检查中..." : "检查更新"}
            </button>
          </div>
          {updateStatus.state === "hasUpdate" && (
            <p className="settings-section__hint">
              发现新版本 v{updateStatus.info.latestVersion}，点击右上角徽章查看详情。
            </p>
          )}
          {updateStatus.state === "noUpdate" && (
            <p className="settings-section__hint">已是最新版本。</p>
          )}
          {updateStatus.state === "error" && (
            <p className="settings-section__hint">检查更新失败：{updateStatus.message}</p>
          )}
        </div>
      </section>

      {/* 二次确认对话框已移至 AppShell 全局渲染 */}
    </div>
  );
}
