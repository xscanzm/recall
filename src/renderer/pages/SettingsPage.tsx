// src/renderer/pages/SettingsPage.tsx
// 设置页（来自 08 文档）
//
// 设置模块：
// 1. 模型配置（视觉 + 语言，完整 CRUD + 测试连接）
// 2. 观察设置（活动窗口稳定阈值/内容变化间隔/长会话采集间隔/idle 阈值）
// 3. 截图保留（单选：立即删除/1h/6h/当天/3天/7天，显示缓存大小，清空按钮）
// 4. 通知设置（应用内提醒/桌面通知/日报时间/周报时间）
// 5. 黑名单与隐私规则（完整 CRUD）
// 6. 忘掉最近（15/30/60 分钟/今天）
// 7. 数据导出 / 清空（JSON 导出 + 清空所有数据 + 清空截图缓存）
//
// 重要约束：
// - API Key 不显示完整（测试失败时不显示 key）
// - API Key 输入框 type=password
// - 删除模型配置时同时删除 SecretService 中对应 key（后端处理）
// - 桌面通知默认关闭
// - 应用内提醒默认开启

import { useEffect, useState } from "react";
import { ModelConfigForm } from "../components/ModelConfigForm";
import { PrivacyRuleList } from "../components/PrivacyRuleList";
import { useAppStore, type ScreenshotRetentionPolicy } from "../state/store";

/**
 * 忘掉最近时长选项（来自 spec.md "忘掉最近"）
 */
const FORGET_RECENT_OPTIONS: Array<{
  value: "15m" | "30m" | "1h" | "today";
  label: string;
  description: string;
}> = [
  { value: "15m", label: "15 分钟", description: "硬删除最近 15 分钟内的截图缓存与观察" },
  { value: "30m", label: "30 分钟", description: "硬删除最近 30 分钟内的截图缓存与观察" },
  { value: "1h", label: "1 小时", description: "硬删除最近 1 小时内的截图缓存与观察" },
  { value: "today", label: "今天", description: "硬删除今天全部截图缓存与观察" },
];

/**
 * 截图保留策略选项
 */
const RETENTION_OPTIONS: Array<{
  value: ScreenshotRetentionPolicy;
  label: string;
  description: string;
}> = [
  { value: "delete_immediately", label: "立即删除", description: "采集后立即删除截图，仅用于实时分析" },
  { value: "1h", label: "1 小时", description: "保留 1 小时" },
  { value: "6h", label: "6 小时", description: "保留 6 小时" },
  { value: "today", label: "当天", description: "默认。次日启动时清理前一天截图" },
  { value: "3d", label: "3 天", description: "保留 3 天" },
  { value: "7d", label: "7 天", description: "保留 7 天" },
];

/**
 * 格式化字节数为可读字符串
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function SettingsPage() {
  // 从 store 获取状态和动作
  const modelConfigs = useAppStore((s) => s.modelConfigs);
  const modelConfigsLoading = useAppStore((s) => s.modelConfigsLoading);
  const modelConfigsError = useAppStore((s) => s.modelConfigsError);
  const loadModelConfigs = useAppStore((s) => s.loadModelConfigs);
  const saveModelConfig = useAppStore((s) => s.saveModelConfig);
  const deleteModelConfig = useAppStore((s) => s.deleteModelConfig);
  const testModelConnection = useAppStore((s) => s.testModelConnection);

  const privacyRules = useAppStore((s) => s.privacyRules);
  const privacyRulesLoading = useAppStore((s) => s.privacyRulesLoading);
  const privacyRulesError = useAppStore((s) => s.privacyRulesError);
  const loadPrivacyRules = useAppStore((s) => s.loadPrivacyRules);
  const addPrivacyRule = useAppStore((s) => s.addPrivacyRule);
  const updatePrivacyRule = useAppStore((s) => s.updatePrivacyRule);
  const deletePrivacyRule = useAppStore((s) => s.deletePrivacyRule);

  const settings = useAppStore((s) => s.settings);
  const settingsLoading = useAppStore((s) => s.settingsLoading);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const forgetRecent = useAppStore((s) => s.forgetRecent);
  const exportData = useAppStore((s) => s.exportData);
  const clearAllData = useAppStore((s) => s.clearAllData);
  const getCacheSize = useAppStore((s) => s.getCacheSize);

  // 忘掉最近状态
  const [forgetLoading, setForgetLoading] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [forgetResult, setForgetResult] = useState<{
    deletedObservations: number;
    deletedScreenshots: number;
  } | null>(null);
  const [pendingForget, setPendingForget] = useState<
    "15m" | "30m" | "1h" | "today" | null
  >(null);

  // 数据导出 / 清空状态
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [includeScreenshots, setIncludeScreenshots] = useState(false);

  const [clearAllLoading, setClearAllLoading] = useState(false);
  const [clearAllError, setClearAllError] = useState<string | null>(null);
  const [clearAllResult, setClearAllResult] = useState<string | null>(null);
  const [pendingClearAll, setPendingClearAll] = useState(false);

  // 截图缓存大小
  const [cacheSize, setCacheSize] = useState<{ bytes: number; fileCount: number } | null>(null);
  const [clearCacheLoading, setClearCacheLoading] = useState(false);
  const [clearCacheResult, setClearCacheResult] = useState<string | null>(null);

  // 截图保留策略本地状态（保存时同步到 store）
  const [retentionPolicy, setRetentionPolicy] = useState<ScreenshotRetentionPolicy>("today");
  const [retentionSaving, setRetentionSaving] = useState(false);

  // 通知设置本地状态
  const [inAppReminders, setInAppReminders] = useState(true);
  const [desktopNotifications, setDesktopNotifications] = useState(false);
  const [dailyReportTime, setDailyReportTime] = useState("18:30");
  const [weeklyReportTime, setWeeklyReportTime] = useState("20:00");
  const [notificationSaving, setNotificationSaving] = useState(false);

  // 观察设置本地状态
  const [activeWindowStableSeconds, setActiveWindowStableSeconds] = useState(30);
  const [contentChangeMinIntervalSeconds, setContentChangeMinIntervalSeconds] = useState(60);
  const [longSessionIntervalMinutes, setLongSessionIntervalMinutes] = useState(5);
  const [idleThresholdSeconds, setIdleThresholdSeconds] = useState(120);
  const [observationSaving, setObservationSaving] = useState(false);

  // 初始化加载
  useEffect(() => {
    void loadModelConfigs();
    void loadPrivacyRules();
    void loadSettings();
    void refreshCacheSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 设置加载完成后同步本地状态
  useEffect(() => {
    if (settings) {
      setRetentionPolicy(settings.screenshot.retentionPolicy);
      setInAppReminders(settings.notification.inAppReminders);
      setDesktopNotifications(settings.notification.desktopNotifications);
      setDailyReportTime(settings.notification.dailyReportTime);
      setWeeklyReportTime(settings.notification.weeklyReportTime);
      setActiveWindowStableSeconds(settings.observation.activeWindowStableSeconds);
      setContentChangeMinIntervalSeconds(settings.observation.contentChangeMinIntervalSeconds);
      setLongSessionIntervalMinutes(settings.observation.longSessionIntervalMinutes);
      setIdleThresholdSeconds(settings.observation.idleThresholdSeconds);
    }
  }, [settings]);

  /**
   * 刷新截图缓存大小
   */
  const refreshCacheSize = async () => {
    const result = await getCacheSize();
    setCacheSize({ bytes: result.bytes, fileCount: result.fileCount });
  };

  /**
   * 保存截图保留策略
   */
  const handleSaveRetention = async () => {
    setRetentionSaving(true);
    try {
      const result = await updateSettings({
        screenshot: { retentionPolicy },
      });
      if (!result.ok) {
        window.alert(result.error ?? "保存失败");
      }
    } finally {
      setRetentionSaving(false);
    }
  };

  /**
   * 保存通知设置
   */
  const handleSaveNotification = async () => {
    setNotificationSaving(true);
    try {
      const result = await updateSettings({
        notification: {
          inAppReminders,
          desktopNotifications,
          dailyReportTime,
          weeklyReportTime,
        },
      });
      if (!result.ok) {
        window.alert(result.error ?? "保存失败");
      }
    } finally {
      setNotificationSaving(false);
    }
  };

  /**
   * 保存观察设置
   */
  const handleSaveObservation = async () => {
    setObservationSaving(true);
    try {
      const result = await updateSettings({
        observation: {
          enabled: settings?.observation.enabled ?? false,
          activeWindowStableSeconds,
          contentChangeMinIntervalSeconds,
          longSessionIntervalMinutes,
          idleThresholdSeconds,
        },
      });
      if (!result.ok) {
        window.alert(result.error ?? "保存失败");
      }
    } finally {
      setObservationSaving(false);
    }
  };

  /**
   * 清空所有截图缓存（调用 forgetRecent today）
   */
  const handleClearScreenshots = async () => {
    const confirmed = window.confirm(
      "确认清空所有截图缓存？\n\n截图文件会被硬删除，无法恢复。结构化记忆不受影响。"
    );
    if (!confirmed) return;
    setClearCacheLoading(true);
    setClearCacheResult(null);
    try {
      // 使用 forgetRecent today 清空截图
      const result = await forgetRecent("today");
      setClearCacheResult(
        `已清空：删除截图 ${result.deletedScreenshots} 个，删除观察 ${result.deletedObservations} 条`
      );
      await refreshCacheSize();
    } catch (err) {
      setClearCacheResult(err instanceof Error ? err.message : "清空失败");
    } finally {
      setClearCacheLoading(false);
    }
  };

  // 忘掉最近处理
  const handleForgetClick = (duration: "15m" | "30m" | "1h" | "today") => {
    setPendingForget(duration);
    setForgetError(null);
    setForgetResult(null);
  };

  const handleForgetConfirm = async () => {
    if (!pendingForget) return;
    setForgetLoading(true);
    setForgetError(null);
    try {
      const result = await forgetRecent(pendingForget);
      setForgetResult(result);
      setPendingForget(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setForgetError(message);
    } finally {
      setForgetLoading(false);
    }
  };

  const handleForgetCancel = () => {
    setPendingForget(null);
    setForgetError(null);
  };

  /**
   * 数据导出
   */
  const handleExport = async () => {
    setExportLoading(true);
    setExportError(null);
    setExportResult(null);
    try {
      const result = await exportData({ includeScreenshots });
      if (result.ok && result.data) {
        // 触发浏览器下载
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
        setExportResult(
          `已导出：${meta.exportedAt}，观察 ${result.data.observations.length} 条，` +
          `线索 ${result.data.facts.length} 条，工作片段 ${result.data.scenes.length} 条，` +
          `任务 ${result.data.tasks.length} 条，项目 ${result.data.projects.length} 个，` +
          `报告 ${result.data.reports.length} 篇。` +
          `${meta.includeScreenshots ? "（含截图路径）" : "（不含截图）"}`
        );
      } else {
        setExportError(result.error ?? "导出失败");
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "导出失败");
    } finally {
      setExportLoading(false);
    }
  };

  /**
   * 清空所有数据
   */
  const handleClearAllClick = () => {
    setPendingClearAll(true);
    setClearAllError(null);
    setClearAllResult(null);
  };

  const handleClearAllConfirm = async () => {
    setPendingClearAll(false);
    setClearAllLoading(true);
    setClearAllError(null);
    try {
      const result = await clearAllData();
      if (result.ok) {
        setClearAllResult(
          `已清空所有结构化记忆数据。删除截图 ${result.deletedScreenshots ?? 0} 个。` +
          "设置、模型配置、隐私规则已保留。"
        );
        await refreshCacheSize();
      } else {
        setClearAllError(result.error ?? "清空失败");
      }
    } catch (err) {
      setClearAllError(err instanceof Error ? err.message : "清空失败");
    } finally {
      setClearAllLoading(false);
    }
  };

  const handleClearAllCancel = () => {
    setPendingClearAll(false);
  };

  // 按模型类型分组
  const visionConfigs = modelConfigs.filter((c) => c.kind === "vision");
  const languageConfigs = modelConfigs.filter((c) => c.kind === "language");

  return (
    <div className="settings-page">
      <header className="page-header">
        <h2>设置</h2>
        <p className="page-header__sub">
          视觉模型和语言模型分开配置。API Key 保存在系统安全存储，不会进入数据库或日志。
        </p>
      </header>

      {/* 模型配置 - 视觉 */}
      <section className="card">
        <div className="card__body">
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
      </section>

      {/* 模型配置 - 语言 */}
      <section className="card">
        <div className="card__body">
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
      </section>

      {/* 观察设置 */}
      <section className="card">
        <h3 className="card__title">观察设置</h3>
        <div className="card__body">
          <p className="settings-section__hint">
            调整 Recall 采集观察的触发阈值。值越小越敏感，越频繁触发采集。
          </p>
          {settingsLoading ? (
            <p className="settings-section__hint">加载中...</p>
          ) : (
            <div className="settings-form">
              <div className="settings-form__field">
                <label>活动窗口稳定时间阈值（秒）</label>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={activeWindowStableSeconds}
                  onChange={(e) => setActiveWindowStableSeconds(Number(e.target.value))}
                />
                <p className="settings-form__hint">
                  用户输入活跃且窗口稳定超过此阈值时触发采集（默认 30 秒）
                </p>
              </div>

              <div className="settings-form__field">
                <label>内容变化最小间隔（秒）</label>
                <input
                  type="number"
                  min={30}
                  max={600}
                  value={contentChangeMinIntervalSeconds}
                  onChange={(e) => setContentChangeMinIntervalSeconds(Number(e.target.value))}
                />
                <p className="settings-form__hint">
                  内容差异触发采集的最小间隔（默认 60 秒）
                </p>
              </div>

              <div className="settings-form__field">
                <label>长会话采集间隔（分钟）</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={longSessionIntervalMinutes}
                  onChange={(e) => setLongSessionIntervalMinutes(Number(e.target.value))}
                />
                <p className="settings-form__hint">
                  同一窗口长时间活跃时，定期触发采集的间隔（默认 5 分钟）
                </p>
              </div>

              <div className="settings-form__field">
                <label>空闲判定阈值（秒）</label>
                <input
                  type="number"
                  min={30}
                  max={600}
                  value={idleThresholdSeconds}
                  onChange={(e) => setIdleThresholdSeconds(Number(e.target.value))}
                />
                <p className="settings-form__hint">
                  超过此阈值无键盘鼠标活动则判定为 idle（默认 120 秒）
                </p>
              </div>

              <div className="settings-form__actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleSaveObservation}
                  disabled={observationSaving}
                >
                  {observationSaving ? "保存中..." : "保存观察设置"}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 截图保留 */}
      <section className="card">
        <h3 className="card__title">截图保留</h3>
        <div className="card__body">
          <p className="settings-section__hint">
            截图仅本地短期保留，作为视觉模型输入。过期截图硬删除，结构化记忆不受影响。
          </p>
          <div className="retention-options">
            {RETENTION_OPTIONS.map((opt) => (
              <label key={opt.value} className="retention-options__item">
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

          <div className="settings-form__actions">
            <button
              type="button"
              className="primary"
              onClick={handleSaveRetention}
              disabled={retentionSaving}
            >
              {retentionSaving ? "保存中..." : "保存保留策略"}
            </button>
          </div>

          <div className="cache-info">
            <p className="cache-info__text">
              当前缓存：{cacheSize ? `${formatBytes(cacheSize.bytes)} / ${cacheSize.fileCount} 个文件` : "加载中..."}
            </p>
            <button
              type="button"
              className="cache-info__clear-btn"
              onClick={handleClearScreenshots}
              disabled={clearCacheLoading}
            >
              {clearCacheLoading ? "清空中..." : "清空截图缓存"}
            </button>
          </div>
          {clearCacheResult && <p className="cache-info__result">{clearCacheResult}</p>}
        </div>
      </section>

      {/* 通知设置 */}
      <section className="card">
        <h3 className="card__title">通知设置</h3>
        <div className="card__body">
          {settingsLoading ? (
            <p className="settings-section__hint">加载中...</p>
          ) : (
            <div className="settings-form">
              <label className="settings-form__toggle">
                <input
                  type="checkbox"
                  checked={inAppReminders}
                  onChange={(e) => setInAppReminders(e.target.checked)}
                />
                <div>
                  <span className="settings-form__toggle-label">应用内提醒</span>
                  <p className="settings-form__hint">默认开启。在应用内显示提醒，不建议关闭。</p>
                </div>
              </label>

              <label className="settings-form__toggle">
                <input
                  type="checkbox"
                  checked={desktopNotifications}
                  onChange={(e) => setDesktopNotifications(e.target.checked)}
                />
                <div>
                  <span className="settings-form__toggle-label">桌面通知</span>
                  <p className="settings-form__hint">
                    默认关闭。开启后只对候选高优先级提醒生效，低优先级提醒只在应用内显示。
                  </p>
                </div>
              </label>

              <div className="settings-form__field">
                <label>日报时间</label>
                <input
                  type="time"
                  value={dailyReportTime}
                  onChange={(e) => setDailyReportTime(e.target.value)}
                />
                <p className="settings-form__hint">每天此时间触发日报生成（默认 18:30）</p>
              </div>

              <div className="settings-form__field">
                <label>周报时间</label>
                <input
                  type="time"
                  value={weeklyReportTime}
                  onChange={(e) => setWeeklyReportTime(e.target.value)}
                />
                <p className="settings-form__hint">每周日此时间触发周报生成（默认 20:00）</p>
              </div>

              <div className="settings-form__actions">
                <button
                  type="button"
                  className="primary"
                  onClick={handleSaveNotification}
                  disabled={notificationSaving}
                >
                  {notificationSaving ? "保存中..." : "保存通知设置"}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 黑名单与隐私规则 */}
      <section className="card">
        <h3 className="card__title">黑名单与隐私规则</h3>
        <div className="card__body">
          <PrivacyRuleList
            rules={privacyRules}
            loading={privacyRulesLoading}
            error={privacyRulesError}
            onAdd={addPrivacyRule}
            onUpdate={updatePrivacyRule}
            onDelete={deletePrivacyRule}
          />
        </div>
      </section>

      {/* 忘掉最近（来自 spec.md "忘掉最近"章节，M7 已实现） */}
      <section className="card">
        <h3 className="card__title">忘掉最近</h3>
        <div className="card__body">
          <p className="forget-recent__hint">
            点击后 Recall 会硬删除对应时间范围内的截图缓存和观察，并 soft delete 关联线索/工作片段。引用这些线索的日报会被标记为需要重新生成。
          </p>
          <div className="forget-recent__buttons">
            {FORGET_RECENT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="forget-recent__btn"
                onClick={() => handleForgetClick(opt.value)}
                disabled={forgetLoading}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {forgetError && <p className="forget-recent__error">{forgetError}</p>}

          {forgetResult && (
            <div className="forget-recent__result">
              <p>已忘掉：</p>
              <ul>
                <li>删除观察 {forgetResult.deletedObservations} 条</li>
                <li>删除截图缓存 {forgetResult.deletedScreenshots} 个</li>
              </ul>
              <p className="forget-recent__result-hint">
                关联线索/工作片段已 soft delete，引用这些内容的日报已标记需要重新生成。
              </p>
            </div>
          )}

          {pendingForget && (
            <div className="forget-recent__confirm-overlay" onClick={handleForgetCancel}>
              <div
                className="forget-recent__confirm-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
              >
                <h4>确认忘掉最近</h4>
                <p>
                  你即将忘掉最近
                  <strong>
                    {FORGET_RECENT_OPTIONS.find((o) => o.value === pendingForget)?.label}
                  </strong>
                  的内容。
                </p>
                <p className="forget-recent__confirm-hint">
                  对应截图缓存会被硬删除，无法恢复；关联线索/工作片段会被 soft delete（可在数据库中恢复，但 UI 不再展示）。
                </p>
                <div className="forget-recent__confirm-actions">
                  <button type="button" onClick={handleForgetCancel} disabled={forgetLoading}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="primary forget-recent__confirm-btn"
                    onClick={handleForgetConfirm}
                    disabled={forgetLoading}
                  >
                    {forgetLoading ? "执行中..." : "确认忘掉"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 数据导出 / 清空 */}
      <section className="card">
        <h3 className="card__title">数据导出 / 清空</h3>
        <div className="card__body">
          <div className="data-section">
            <h4 className="data-section__title">导出全部记忆</h4>
            <p className="data-section__hint">
              导出为 JSON 文件，包含观察、线索、工作片段、任务、项目、决策、人物、报告，以及导出时间和版本。
              默认不包含截图，除非下方明确勾选。
            </p>
            <label className="data-section__toggle">
              <input
                type="checkbox"
                checked={includeScreenshots}
                onChange={(e) => setIncludeScreenshots(e.target.checked)}
              />
              <span>包含截图路径（仅路径，不含文件本身）</span>
            </label>
            <div className="data-section__actions">
              <button
                type="button"
                className="primary"
                onClick={handleExport}
                disabled={exportLoading}
              >
                {exportLoading ? "导出中..." : "导出 JSON"}
              </button>
            </div>
            {exportError && <p className="data-section__error">{exportError}</p>}
            {exportResult && <p className="data-section__result">{exportResult}</p>}
          </div>

          <div className="data-section data-section--danger">
            <h4 className="data-section__title">清空所有数据</h4>
            <p className="data-section__hint">
              清空所有结构化记忆数据（观察、线索、工作片段、任务、项目、决策、人物、报告）和全部截图缓存。
              保留：设置、模型配置、隐私规则、用户反馈。
              此操作不可恢复。
            </p>
            <div className="data-section__actions">
              <button
                type="button"
                className="data-section__danger-btn"
                onClick={handleClearAllClick}
                disabled={clearAllLoading}
              >
                {clearAllLoading ? "清空中..." : "清空所有数据"}
              </button>
            </div>
            {clearAllError && <p className="data-section__error">{clearAllError}</p>}
            {clearAllResult && <p className="data-section__result">{clearAllResult}</p>}
            {pendingClearAll && (
              <div className="forget-recent__confirm-overlay" onClick={handleClearAllCancel}>
                <div
                  className="forget-recent__confirm-modal"
                  onClick={(e) => e.stopPropagation()}
                  role="dialog"
                  aria-modal="true"
                >
                  <h4>确认清空所有数据</h4>
                  <p>
                    你即将清空<strong>所有结构化记忆数据</strong>和全部截图缓存。
                  </p>
                  <p className="forget-recent__confirm-hint">
                    此操作不可恢复。设置、模型配置、隐私规则、用户反馈会保留。
                  </p>
                  <div className="forget-recent__confirm-actions">
                    <button type="button" onClick={handleClearAllCancel} disabled={clearAllLoading}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="primary forget-recent__confirm-btn"
                      onClick={handleClearAllConfirm}
                      disabled={clearAllLoading}
                    >
                      {clearAllLoading ? "执行中..." : "确认清空"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <style>{`
        .settings-section__hint {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.6;
          margin: 0 0 12px 0;
        }
        .settings-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .settings-form__field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .settings-form__field label {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .settings-form__field input[type="number"],
        .settings-form__field input[type="time"] {
          padding: 6px 10px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          font-family: inherit;
          font-size: 13px;
          width: 200px;
        }
        .settings-form__hint {
          margin: 0;
          font-size: 11px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .settings-form__toggle {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          cursor: pointer;
        }
        .settings-form__toggle input[type="checkbox"] {
          margin-top: 2px;
        }
        .settings-form__toggle-label {
          font-size: 13px;
          font-weight: 500;
          display: block;
        }
        .settings-form__actions {
          display: flex;
          gap: 8px;
          margin-top: 4px;
        }
        .settings-form__actions button {
          padding: 6px 14px;
          font-size: 13px;
          border: 1px solid var(--border);
          background-color: var(--surface);
          border-radius: var(--radius-button);
          cursor: pointer;
          font-family: inherit;
        }
        .settings-form__actions button.primary {
          background-color: var(--accent-green);
          color: white;
          border-color: var(--accent-green);
        }
        .settings-form__actions button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .retention-options {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 12px;
        }
        .retention-options__item {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          padding: 8px 12px;
          background-color: var(--bg);
          border-radius: var(--radius-button);
          border: 1px solid var(--border);
          cursor: pointer;
        }
        .retention-options__label {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .retention-options__name {
          font-size: 13px;
          font-weight: 500;
        }
        .retention-options__desc {
          font-size: 11px;
          color: var(--text-secondary);
        }
        .cache-info {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          background-color: var(--bg);
          border-radius: var(--radius-button);
          border: 1px solid var(--border);
          margin-top: 12px;
        }
        .cache-info__text {
          margin: 0;
          font-size: 12px;
          color: var(--text-secondary);
          flex: 1;
        }
        .cache-info__clear-btn {
          padding: 4px 12px;
          font-size: 12px;
          border: 1px solid var(--danger);
          color: var(--danger);
          background-color: var(--surface);
          border-radius: var(--radius-button);
          cursor: pointer;
          font-family: inherit;
        }
        .cache-info__clear-btn:hover:not(:disabled) {
          background-color: #fbeeeb;
        }
        .cache-info__clear-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .cache-info__result {
          margin: 8px 0 0 0;
          font-size: 12px;
          color: var(--accent-green);
        }
        .data-section {
          padding: 12px;
          background-color: var(--bg);
          border-radius: var(--radius-button);
          border: 1px solid var(--border);
          margin-bottom: 12px;
        }
        .data-section--danger {
          border-color: var(--danger);
        }
        .data-section__title {
          font-size: 13px;
          font-weight: 600;
          margin: 0 0 6px 0;
        }
        .data-section__hint {
          margin: 0 0 10px 0;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.6;
        }
        .data-section__toggle {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 10px;
          cursor: pointer;
          font-size: 12px;
        }
        .data-section__actions {
          display: flex;
          gap: 8px;
        }
        .data-section__actions button {
          padding: 6px 14px;
          font-size: 12px;
          border: 1px solid var(--border);
          background-color: var(--surface);
          border-radius: var(--radius-button);
          cursor: pointer;
          font-family: inherit;
        }
        .data-section__actions button.primary {
          background-color: var(--accent-green);
          color: white;
          border-color: var(--accent-green);
        }
        .data-section__danger-btn {
          color: var(--danger) !important;
          border-color: var(--danger) !important;
        }
        .data-section__actions button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .data-section__error {
          margin: 8px 0 0 0;
          font-size: 12px;
          color: var(--danger);
        }
        .data-section__result {
          margin: 8px 0 0 0;
          font-size: 12px;
          color: var(--accent-green);
        }
        .forget-recent__hint {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.6;
          margin: 0 0 10px 0;
        }
        .forget-recent__buttons {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .forget-recent__btn {
          padding: 8px 16px;
          border: 1px solid var(--danger);
          color: var(--danger);
          background-color: var(--surface);
          border-radius: var(--radius-button);
          cursor: pointer;
          font-size: 13px;
          font-family: inherit;
        }
        .forget-recent__btn:hover:not(:disabled) {
          background-color: #fbeeeb;
        }
        .forget-recent__btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .forget-recent__error {
          color: var(--danger);
          font-size: 12px;
          margin: 8px 0 0 0;
        }
        .forget-recent__result {
          margin-top: 12px;
          padding: 10px 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          background-color: var(--bg);
          font-size: 12px;
        }
        .forget-recent__result p {
          margin: 0 0 4px 0;
          font-weight: 500;
        }
        .forget-recent__result ul {
          margin: 0 0 6px 0;
          padding-left: 18px;
          color: var(--text-secondary);
        }
        .forget-recent__result-hint {
          font-size: 11px !important;
          color: var(--text-secondary);
          font-weight: 400 !important;
          font-style: italic;
        }
        .forget-recent__confirm-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(30, 36, 35, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }
        .forget-recent__confirm-modal {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          box-shadow: 0 4px 24px rgba(30, 36, 35, 0.12);
          padding: 16px 20px;
          width: 90%;
          max-width: 440px;
        }
        .forget-recent__confirm-modal h4 {
          font-size: 15px;
          font-weight: 600;
          margin: 0 0 8px 0;
        }
        .forget-recent__confirm-modal p {
          font-size: 13px;
          margin: 0 0 6px 0;
          line-height: 1.6;
          color: var(--text-primary);
        }
        .forget-recent__confirm-hint {
          font-size: 12px !important;
          color: var(--text-secondary) !important;
        }
        .forget-recent__confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 12px;
        }
        .forget-recent__confirm-actions button {
          padding: 6px 14px;
          border: 1px solid var(--border);
          background-color: var(--surface);
          font-size: 12px;
          font-family: inherit;
          cursor: pointer;
        }
        .forget-recent__confirm-btn {
          border-color: var(--danger) !important;
          color: var(--danger) !important;
        }
        .forget-recent__confirm-btn:hover:not(:disabled) {
          background-color: #fbeeeb !important;
        }
      `}</style>
    </div>
  );
}
