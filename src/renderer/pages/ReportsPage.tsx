// src/renderer/pages/ReportsPage.tsx
// 报告页（Phase 4，doc 23）
//
// 5 Tab 结构：
// 1. 我的复盘 - 给自己看，温和真实的当日回顾
// 2. 工作日报 - 给上司/团队看，基于选中片段生成
// 3. 周报 - 本周已确认日报 + reportable 时间轴片段汇总
// 4. 月报 - 本月概览/主要项目/关键成果/重要决策/持续风险/下月重点
// 5. 历史 - 所有报告列表，支持类型/日期范围过滤
//
// 重要约束（来自 spec.md Phase 4）：
// - 报告正文不是 JSON，必须展示为可读文本
// - 复制按钮输出 plain text
// - 编辑器支持 textarea 编辑，保存到 reports
// - 来源面板不默认显示截图
// - 我的复盘与工作日报语气明显区分
// - 主区域宽度最大 920px

import { useEffect, useState } from "react";
import {
  useAppStore,
  type FactItem,
  type ProjectItem,
  type ReportItem,
  type ReportsTabKey,
  type SceneItem,
} from "../state/store";
import { getIpc } from "../state/ipc";
import { formatReportAsText } from "../components/ReportEditor";
import { ReportRequirementsPanel } from "../components/ReportRequirementsPanel";
import type { PersonalReview, TimelineBlock, WorkReport } from "../../shared/types";
import { todayDateKey } from "./today/helpers";
import {
  createEmptyReportRequirements,
  normalizeReportRequirements,
  TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH,
  type ReportRequirement,
  type ReportRequirements,
  type ReportRequirementType,
} from "../../shared/reportRequirements";

// ============================================================================
// 常量与 Tab 配置
// ============================================================================

const REPORT_TABS: Array<{ key: ReportsTabKey; label: string }> = [
  { key: "personal", label: "我的复盘" },
  { key: "work", label: "工作日报" },
  { key: "weekly", label: "周报" },
  { key: "monthly", label: "月报" },
  { key: "history", label: "历史" },
];

const WORK_STYLE_OPTIONS: Array<{
  value: "brief" | "standard" | "formal";
  label: string;
}> = [
  { value: "brief", label: "简洁" },
  { value: "standard", label: "标准" },
  { value: "formal", label: "稍正式" },
];

const REPORT_TYPE_LABELS: Record<string, string> = {
  daily: "日报",
  weekly: "周报",
  monthly: "月报",
  retrospective: "复盘",
  personal_daily_review: "复盘",
  work_daily_report: "工作日报",
};

function reportRequirementTypeForTab(
  tab: ReportsTabKey
): ReportRequirementType | null {
  if (tab === "history") return null;
  return tab;
}

function hasLongTermRequirement(requirement: ReportRequirement): boolean {
  return Boolean(
    requirement.focus.trim() ||
      requirement.presentation.trim() ||
      requirement.reminders.trim()
  );
}

interface SourceEvidenceData {
  facts: FactItem[];
  scenes: SceneItem[];
  timelineBlocks: TimelineBlock[];
}

// ============================================================================
// 主组件
// ============================================================================

export function ReportsPage() {
  const isReady = useAppStore((s) => s.isReady);

  // 报告页状态
  const reportsTab = useAppStore((s) => s.reportsTab);
  const reportsDateKey = useAppStore((s) => s.reportsDateKey);
  const reportsWeekStart = useAppStore((s) => s.reportsWeekStart);
  const reportsMonthKey = useAppStore((s) => s.reportsMonthKey);
  const personalReview = useAppStore((s) => s.personalReview);
  const workReport = useAppStore((s) => s.workReport);
  const reportsList = useAppStore((s) => s.reportsList);
  const reportsLoading = useAppStore((s) => s.reportsLoading);
  const reportsError = useAppStore((s) => s.reportsError);
  const reportEditing = useAppStore((s) => s.reportEditing);
  const reportDraft = useAppStore((s) => s.reportDraft);
  const historyTypeFilter = useAppStore((s) => s.reportsHistoryTypeFilter);
  const historyDateFrom = useAppStore((s) => s.reportsHistoryDateFrom);
  const historyDateTo = useAppStore((s) => s.reportsHistoryDateTo);
  const historyProjectFilter = useAppStore((s) => s.reportsHistoryProjectFilter);
  // 项目列表（用于历史 Tab 的项目过滤）
  const projects = useAppStore((s) => s.todayData.projects);
  const loadToday = useAppStore((s) => s.loadToday);

  // 报告页 actions
  const setReportsTab = useAppStore((s) => s.setReportsTab);
  const setReportsDateKey = useAppStore((s) => s.setReportsDateKey);
  const rollOverReportsDateKeyIfNeeded = useAppStore(
    (s) => s.rollOverReportsDateKeyIfNeeded
  );
  const markReportsDateKeySetByUser = useAppStore(
    (s) => s.markReportsDateKeySetByUser
  );
  const fallbackToLatestReportIfMissing = useAppStore(
    (s) => s.fallbackToLatestReportIfMissing
  );
  const setReportsWeekStart = useAppStore((s) => s.setReportsWeekStart);
  const setReportsMonthKey = useAppStore((s) => s.setReportsMonthKey);
  const loadPersonalReview = useAppStore((s) => s.loadPersonalReview);
  const loadWorkReport = useAppStore((s) => s.loadWorkReport);
  const loadReportsList = useAppStore((s) => s.loadReportsList);
  const generatePersonalReview = useAppStore((s) => s.generatePersonalReview);
  const personalReviewGenerating = useAppStore((s) => s.personalReviewGenerating);
  const updateReport = useAppStore((s) => s.updateReport);
  const deleteReport = useAppStore((s) => s.deleteReport);
  const setReportEditing = useAppStore((s) => s.setReportEditing);
  const setReportDraft = useAppStore((s) => s.setReportDraft);
  const setHistoryTypeFilter = useAppStore((s) => s.setReportsHistoryTypeFilter);
  const setHistoryDateFrom = useAppStore((s) => s.setReportsHistoryDateFrom);
  const setHistoryDateTo = useAppStore((s) => s.setReportsHistoryDateTo);
  const setHistoryProjectFilter = useAppStore((s) => s.setReportsHistoryProjectFilter);

  // 今日页跳转 actions（用于"选择片段生成日报"）
  const setPage = useAppStore((s) => s.setPage);
  const setTodayPageDateKey = useAppStore((s) => s.setTodayPageDateKey);
  const setWorkReportSelectionMode = useAppStore(
    (s) => s.setWorkReportSelectionMode
  );
  const workReportStyle = useAppStore((s) => s.workReportStyle);
  const setWorkReportStyle = useAppStore((s) => s.setWorkReportStyle);
  const workReportGenerationRequirement = useAppStore(
    (s) => s.workReportGenerationRequirement
  );
  const setWorkReportGenerationRequirement = useAppStore(
    (s) => s.setWorkReportGenerationRequirement
  );

  // 本地 UI 状态
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [sourcePanel, setSourcePanel] = useState<{
    title: string;
    factIds: string[];
    sceneIds: string[];
    blockIds: string[];
  } | null>(null);
  const [historyDetail, setHistoryDetail] = useState<ReportItem | null>(null);
  const [reportRequirements, setReportRequirements] = useState<ReportRequirements>(
    () => createEmptyReportRequirements()
  );
  const [reportRequirementsLoading, setReportRequirementsLoading] = useState(true);
  const [requirementsPanelType, setRequirementsPanelType] =
    useState<ReportRequirementType | null>(null);
  const [temporaryRequirements, setTemporaryRequirements] = useState<
    Record<ReportRequirementType, string>
  >({ personal: "", work: "", weekly: "", monthly: "" });
  const [temporaryEditorOpen, setTemporaryEditorOpen] = useState<
    Record<ReportRequirementType, boolean>
  >({ personal: false, work: false, weekly: false, monthly: false });

  const currentRequirementType = reportRequirementTypeForTab(reportsTab);

  // Effect A: Tab 切换 / 日期变化时加载数据
  // - 注意：**不**在这里调用 rollOverReportsDateKeyIfNeeded
  //   否则用户点"前一天"会被立即回滚到今天
  // - 跨日回滚统一在 Effect B 处理（mount / focus / 30 min timer）
  useEffect(() => {
    if (!isReady) return;
    if (reportsTab === "personal") {
      void loadPersonalReview(reportsDateKey);
    } else if (reportsTab === "work") {
      void loadWorkReport(reportsDateKey);
    } else if (reportsTab === "weekly") {
      void loadReportsList({ type: "weekly", limit: 30 });
    } else if (reportsTab === "monthly") {
      void loadReportsList({ type: "monthly", limit: 12 });
    } else if (reportsTab === "history") {
      void loadReportsList({
        type: historyTypeFilter !== "all" ? historyTypeFilter : undefined,
        dateFrom: historyDateFrom || undefined,
        dateTo: historyDateTo || undefined,
        limit: 100,
      });
    }
    // 切换 tab 时退出编辑模式
    setReportEditing(false);
    setReportDraft("");
  }, [
    isReady,
    reportsTab,
    reportsDateKey,
    reportsWeekStart,
    reportsMonthKey,
    historyTypeFilter,
    historyDateFrom,
    historyDateTo,
    loadPersonalReview,
    loadWorkReport,
    loadReportsList,
    setReportEditing,
    setReportDraft,
  ]);

  // Effect B: 跨日兜底 + "默认显示最近一份"
  // - 只依赖 isReady，不依赖 reportsDateKey（避免用户点"前一天"时反复触发）
  // - 三处触发：mount / window focus / 30 分钟定时
  // - 跨日回滚：仅当用户没主动改过 dateKey 时才回滚
  // - 默认显示最近：当前 dateKey 没数据且 ≥ today 且 user-changed=false 时
  //   自动切到 ≤ today 的最近一份
  useEffect(() => {
    if (!isReady) return;
    // 挂载时跑一次
    rollOverReportsDateKeyIfNeeded();
    void fallbackToLatestReportIfMissing();
    // 切回窗口时跑一次
    const handleFocus = () => {
      rollOverReportsDateKeyIfNeeded();
      void fallbackToLatestReportIfMissing();
    };
    window.addEventListener("focus", handleFocus);
    // 30 分钟轮询（兜底长时前台跨日）
    const timer = setInterval(() => {
      rollOverReportsDateKeyIfNeeded();
      void fallbackToLatestReportIfMissing();
    }, 30 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", handleFocus);
      clearInterval(timer);
    };
  }, [isReady, rollOverReportsDateKeyIfNeeded, fallbackToLatestReportIfMissing]);

  // Effect C: 加载完成后做 fallback
  // - Effect A 在 dateKey/tab 变化时触发 load，
  //   loadPersonalReview/loadWorkReport 完成后会写入 state.personalReview/workReport
  // - 这里用 dateKey 变化作为"load 已触发"的信号来跑 fallback
  // - fallback 内部会检查 "user-changed=true 时不强制回退"
  // - **不**监听 personalReview/workReport 自身（避免循环）
  useEffect(() => {
    if (!isReady) return;
    if (reportsTab === "personal" || reportsTab === "work") {
      void fallbackToLatestReportIfMissing();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, reportsTab, reportsDateKey]);

  // 历史 Tab 时加载项目列表（用于项目过滤下拉）
  useEffect(() => {
    if (!isReady) return;
    if (reportsTab === "history" && projects.length === 0) {
      void loadToday();
    }
  }, [isReady, reportsTab, projects.length, loadToday]);

  useEffect(() => {
    if (!isReady) return;
    let active = true;
    setReportRequirementsLoading(true);
    void getIpc().settings
      .get<{ reportRequirements?: unknown }>()
      .then((settings) => {
        if (!active) return;
        setReportRequirements(normalizeReportRequirements(settings.reportRequirements));
      })
      .catch((error) => {
        if (!active) return;
        useAppStore.setState({
          reportsError:
            error instanceof Error ? error.message : "加载报告要求失败",
        });
      })
      .finally(() => {
        if (active) setReportRequirementsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isReady]);

  // ============================================================================
  // 通用处理函数
  // ============================================================================

  const handleCopy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint("已复制到剪贴板");
      setTimeout(() => setCopyHint(null), 2000);
    } catch {
      // clipboard API 不可用时降级
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopyHint("已复制到剪贴板");
        setTimeout(() => setCopyHint(null), 2000);
      } catch {
        setCopyHint("复制失败：剪贴板不可用");
        setTimeout(() => setCopyHint(null), 3000);
      }
      document.body.removeChild(textarea);
    }
  };

  const handleExportMarkdown = (text: string, filename: string) => {
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleEnterEdit = (currentText: string) => {
    setReportDraft(currentText);
    setReportEditing(true);
  };

  const handleCancelEdit = () => {
    setReportEditing(false);
    setReportDraft("");
  };

  const handleSaveReport = async (id: string) => {
    await updateReport(id, reportDraft);
  };

  const getTemporaryRequirement = (type: ReportRequirementType): string =>
    type === "work"
      ? workReportGenerationRequirement
      : temporaryRequirements[type];

  const setTemporaryRequirement = (
    type: ReportRequirementType,
    value: string
  ) => {
    if (type === "work") {
      setWorkReportGenerationRequirement(value);
      return;
    }
    setTemporaryRequirements((current) => ({ ...current, [type]: value }));
  };

  const clearTemporaryRequirement = (type: ReportRequirementType) => {
    setTemporaryRequirement(type, "");
    setTemporaryEditorOpen((current) => ({ ...current, [type]: false }));
  };

  const handleSaveReportRequirements = async (
    nextRequirements: ReportRequirements
  ) => {
    const result = await getIpc().settings.update<{
      reportRequirements?: unknown;
    }>({ reportRequirements: nextRequirements });
    const savedRequirements = normalizeReportRequirements(
      result.settings.reportRequirements
    );
    setReportRequirements(savedRequirements);
    setCopyHint("报告要求已保存");
    setTimeout(() => setCopyHint(null), 2000);
  };

  // 删除我的复盘某条目（unfinished / worthRemembering）
  // 从对应数组中 splice 后重新组装 PersonalReview contentJson，调用 reports.update
  const handleDeletePersonalReviewEntry = async (
    section: "unfinished" | "worthRemembering",
    index: number
  ) => {
    if (!personalReview) return;
    const newReview: PersonalReview = { ...personalReview };
    if (section === "unfinished") {
      newReview.unfinished = [...personalReview.unfinished];
      newReview.unfinished.splice(index, 1);
    } else {
      newReview.worthRemembering = [...personalReview.worthRemembering];
      newReview.worthRemembering.splice(index, 1);
    }
    try {
      const contentJson = JSON.stringify({
        id: newReview.id,
        dateKey: newReview.dateKey,
        title: newReview.title,
        overview: newReview.overview,
        mainThreads: newReview.mainThreads,
        meaningfulProgress: newReview.meaningfulProgress,
        unfinished: newReview.unfinished,
        worthRemembering: newReview.worthRemembering,
        tomorrowStartHere: newReview.tomorrowStartHere,
      });
      await getIpc().reports.update({ id: personalReview.id, contentJson });
      useAppStore.setState({ personalReview: newReview });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAppStore.setState({ reportsError: message });
    }
  };

  // 生成我的复盘（复用 Phase 3 的 generatePersonalReview，再刷新报告页状态）
  const handleGeneratePersonalReview = async () => {
    const generated = await generatePersonalReview(
      reportsDateKey,
      getTemporaryRequirement("personal") || undefined
    );
    if (generated) {
      clearTemporaryRequirement("personal");
      await loadPersonalReview(reportsDateKey);
    }
  };

  // 生成周报
  const handleGenerateWeekly = async () => {
    try {
      const result = await getIpc().reports.generate({
        type: "weekly",
        dateKey: reportsWeekStart,
        generationRequirement: getTemporaryRequirement("weekly") || undefined,
      });
      if (!result.ok) {
        useAppStore.setState({ reportsError: result.message ?? "周报生成失败" });
      } else {
        clearTemporaryRequirement("weekly");
        await loadReportsList({ type: "weekly", limit: 30 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAppStore.setState({ reportsError: message });
    }
  };

  // 生成月报
  // 月报 6 大板块（doc 23 §6.4）：本月概览/主要项目/关键成果/重要决策/持续风险/下月重点
  // main 端 reports:generate 已支持 type:"monthly"，复用 weekly 生成逻辑后更新 type
  const handleGenerateMonthly = async () => {
    try {
      const result = await getIpc().reports.generate({
        type: "monthly",
        dateKey: `${reportsMonthKey}-01`,
        generationRequirement: getTemporaryRequirement("monthly") || undefined,
      });
      if (!result.ok) {
        useAppStore.setState({ reportsError: result.message ?? "月报生成失败" });
      } else {
        clearTemporaryRequirement("monthly");
        await loadReportsList({ type: "monthly", limit: 12 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useAppStore.setState({ reportsError: message });
    }
  };

  // 跳转到今日页选择片段生成日报
  const handleEnterSelectionMode = () => {
    setTodayPageDateKey(reportsDateKey);
    setWorkReportSelectionMode(true);
    setPage("today");
  };

  // 日期导航
  const handleDateChange = (newDateKey: string) => {
    setReportsDateKey(newDateKey);
  };

  const handlePrevDay = () => {
    setReportsDateKey(addDays(reportsDateKey, -1));
  };

  const handleNextDay = () => {
    setReportsDateKey(addDays(reportsDateKey, 1));
  };

  const handlePrevWeek = () => {
    setReportsWeekStart(addDays(reportsWeekStart, -7));
  };

  const handleNextWeek = () => {
    setReportsWeekStart(addDays(reportsWeekStart, 7));
  };

  const handlePrevMonth = () => {
    setReportsMonthKey(addMonths(reportsMonthKey, -1));
  };

  const handleNextMonth = () => {
    setReportsMonthKey(addMonths(reportsMonthKey, 1));
  };

  // ============================================================================
  // 渲染
  // ============================================================================

  if (!isReady) {
    return (
      <div className="reports-page">
        <header className="page-header">
          <h2>报告</h2>
          <p className="page-header__sub">正在加载...</p>
        </header>
      </div>
    );
  }

  return (
    <div className="reports-page">
      <header className="page-header">
        <h2>报告</h2>
        <p className="page-header__sub">
          把每天的记录整理成复盘、日报、周报和月报。
        </p>
      </header>

      {/* Tab 栏 */}
      <nav className="reports-tabs" role="tablist">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={reportsTab === tab.key}
            className={`reports-tab${reportsTab === tab.key ? " is-active" : ""}`}
            onClick={() => setReportsTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {currentRequirementType && (
        <section className="reports-requirements-bar" aria-label="报告生成要求">
          <div className="reports-requirements-bar__summary">
            <span className="reports-requirements-bar__title">报告要求</span>
            <span className="reports-requirements-bar__status">
              {reportRequirementsLoading
                ? "正在加载..."
                : hasLongTermRequirement(reportRequirements[currentRequirementType])
                  ? "已设置长期要求"
                  : "尚未设置长期要求"}
            </span>
          </div>
          <div className="reports-requirements-bar__actions">
            <button
              type="button"
              className="tb-btn"
              onClick={() => setRequirementsPanelType(currentRequirementType)}
              disabled={reportRequirementsLoading}
            >
              维护报告要求
            </button>
            <button
              type="button"
              className="tb-btn"
              onClick={() =>
                setTemporaryEditorOpen((current) => ({
                  ...current,
                  [currentRequirementType]: !current[currentRequirementType],
                }))
              }
            >
              {temporaryEditorOpen[currentRequirementType]
                ? "收起本次要求"
                : "本次补充要求"}
            </button>
          </div>

          {temporaryEditorOpen[currentRequirementType] && (
            <label className="reports-temporary-requirement">
              <span className="reports-temporary-requirement__label">
                本次补充要求（可选）
              </span>
              <span className="reports-temporary-requirement__hint">
                只影响当前这一次生成，不会保存为长期报告要求。
              </span>
              <textarea
                value={getTemporaryRequirement(currentRequirementType)}
                maxLength={TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH}
                placeholder="例如：本次重点统计客户反馈，并把尚未解决的问题单独列出。"
                onChange={(event) =>
                  setTemporaryRequirement(
                    currentRequirementType,
                    event.target.value
                  )
                }
              />
              <span className="reports-temporary-requirement__count">
                {getTemporaryRequirement(currentRequirementType).length}/
                {TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH}
              </span>
            </label>
          )}
        </section>
      )}

      {/* 主区域：最大宽度 920px */}
      <div className="reports-content">
        {reportsError && (
          <div className="reports-error">
            <span>{reportsError}</span>
            <button onClick={() => useAppStore.setState({ reportsError: null })}>
              关闭
            </button>
          </div>
        )}

        {copyHint && <div className="reports-copy-hint">{copyHint}</div>}

        {reportsTab === "personal" && (
          <PersonalReviewTab
            dateKey={reportsDateKey}
            personalReview={personalReview}
            loading={reportsLoading}
            generating={personalReviewGenerating}
            editing={reportEditing}
            draft={reportDraft}
            onDateChange={handleDateChange}
            onPrevDay={handlePrevDay}
            onNextDay={handleNextDay}
            onGenerate={handleGeneratePersonalReview}
            onCopy={handleCopy}
            onEnterEdit={handleEnterEdit}
            onCancelEdit={handleCancelEdit}
            onSave={() => personalReview && handleSaveReport(personalReview.id)}
            onDraftChange={setReportDraft}
            onViewSource={(entry) =>
              setSourcePanel({
                title: "来源",
                factIds: entry.factIds,
                sceneIds: [],
                blockIds: entry.blockIds,
              })
            }
            onDeleteEntry={handleDeletePersonalReviewEntry}
          />
        )}

        {reportsTab === "work" && (
          <WorkReportTab
            dateKey={reportsDateKey}
            workReport={workReport}
            loading={reportsLoading}
            editing={reportEditing}
            draft={reportDraft}
            style={workReportStyle}
            onStyleChange={setWorkReportStyle}
            onDateChange={handleDateChange}
            onPrevDay={handlePrevDay}
            onNextDay={handleNextDay}
            onEnterSelection={handleEnterSelectionMode}
            onCopy={handleCopy}
            onEnterEdit={handleEnterEdit}
            onCancelEdit={handleCancelEdit}
            onSave={() => workReport && handleSaveReport(workReport.id)}
            onDraftChange={setReportDraft}
            onExportMarkdown={(text) =>
              handleExportMarkdown(text, `work-report-${reportsDateKey}.md`)
            }
            onViewSource={() =>
              workReport &&
              setSourcePanel({
                title: "工作日报来源",
                factIds: workReport.sourceFactIds,
                sceneIds: [],
                blockIds: workReport.sourceTimelineBlockIds,
              })
            }
          />
        )}

        {reportsTab === "weekly" && (
          <WeeklyReportTab
            weekStart={reportsWeekStart}
            reports={reportsList.filter((r) => r.type === "weekly")}
            loading={reportsLoading}
            editing={reportEditing}
            draft={reportDraft}
            onPrevWeek={handlePrevWeek}
            onNextWeek={handleNextWeek}
            onGenerate={handleGenerateWeekly}
            onCopy={handleCopy}
            onEnterEdit={handleEnterEdit}
            onCancelEdit={handleCancelEdit}
            onSave={(id) => handleSaveReport(id)}
            onDraftChange={setReportDraft}
            onExportMarkdown={(text, id) =>
              handleExportMarkdown(text, `weekly-report-${id}.md`)
            }
            onViewSource={(item) =>
              setSourcePanel({
                title: "周报来源",
                factIds: item.sourceFactIds,
                sceneIds: item.sourceSceneIds,
                blockIds: [],
              })
            }
          />
        )}

        {reportsTab === "monthly" && (
          <MonthlyReportTab
            monthKey={reportsMonthKey}
            reports={reportsList.filter((r) => r.type === "monthly")}
            loading={reportsLoading}
            editing={reportEditing}
            draft={reportDraft}
            onPrevMonth={handlePrevMonth}
            onNextMonth={handleNextMonth}
            onGenerate={handleGenerateMonthly}
            onCopy={handleCopy}
            onEnterEdit={handleEnterEdit}
            onCancelEdit={handleCancelEdit}
            onSave={(id) => handleSaveReport(id)}
            onDraftChange={setReportDraft}
            onExportMarkdown={(text, id) =>
              handleExportMarkdown(text, `monthly-report-${id}.md`)
            }
            onViewSource={(item) =>
              setSourcePanel({
                title: "月报来源",
                factIds: item.sourceFactIds,
                sceneIds: item.sourceSceneIds,
                blockIds: [],
              })
            }
          />
        )}

        {reportsTab === "history" && (
          <HistoryTab
            reports={reportsList}
            loading={reportsLoading}
            typeFilter={historyTypeFilter}
            dateFrom={historyDateFrom}
            dateTo={historyDateTo}
            projectFilter={historyProjectFilter}
            projects={projects}
            detail={historyDetail}
            onTypeFilterChange={setHistoryTypeFilter}
            onDateFromChange={setHistoryDateFrom}
            onDateToChange={setHistoryDateTo}
            onProjectFilterChange={setHistoryProjectFilter}
            onViewDetail={setHistoryDetail}
            onCopy={handleCopy}
            onDelete={async (id) => {
              // 调用 reports:delete IPC 物理删除报告
              try {
                const result = await deleteReport(id);
                if (!result.ok) {
                  useAppStore.setState({
                    reportsError: result.error ?? "删除报告失败",
                  });
                } else {
                  // 删除成功后若当前详情视图是被删除的报告，关闭详情
                  if (historyDetail && historyDetail.id === id) {
                    setHistoryDetail(null);
                  }
                }
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                useAppStore.setState({ reportsError: message });
              }
            }}
            onViewSource={(item) =>
              setSourcePanel({
                title: "报告来源",
                factIds: item.sourceFactIds,
                sceneIds: item.sourceSceneIds,
                blockIds: [],
              })
            }
          />
        )}
      </div>

      {/* 来源面板（弹层，不默认显示截图） */}
      {sourcePanel && (
        <SourcePanel
          title={sourcePanel.title}
          factIds={sourcePanel.factIds}
          sceneIds={sourcePanel.sceneIds}
          blockIds={sourcePanel.blockIds}
          onClose={() => setSourcePanel(null)}
        />
      )}

      {requirementsPanelType && (
        <ReportRequirementsPanel
          initialType={requirementsPanelType}
          requirements={reportRequirements}
          onSave={handleSaveReportRequirements}
          onClose={() => setRequirementsPanelType(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// 我的复盘 Tab
// ============================================================================

interface PersonalReviewTabProps {
  dateKey: string;
  personalReview: PersonalReview | null;
  loading: boolean;
  generating: boolean;
  editing: boolean;
  draft: string;
  onDateChange: (dateKey: string) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onGenerate: () => void;
  onCopy: (text: string) => void;
  onEnterEdit: (text: string) => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDraftChange: (draft: string) => void;
  onViewSource: (entry: {
    factIds: string[];
    blockIds: string[];
  }) => void;
  /** 删除我的复盘某条目（section + index） */
  onDeleteEntry: (
    section: "unfinished" | "worthRemembering",
    index: number
  ) => void;
}

function PersonalReviewTab(props: PersonalReviewTabProps) {
  const {
    dateKey,
    personalReview,
    loading,
    generating,
    editing,
    draft,
    onDateChange,
    onPrevDay,
    onNextDay,
    onGenerate,
    onCopy,
    onEnterEdit,
    onCancelEdit,
    onSave,
    onDraftChange,
    onViewSource,
    onDeleteEntry,
  } = props;

  if (loading && !personalReview) {
    return <div className="reports-loading">正在加载个人复盘...</div>;
  }

  // 日期感知：过去 / 今天的按钮文案和空状态文案不同
  const isPastDate = dateKey < todayDateKey();

  // 未生成时
  if (!personalReview) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button
              className="tb-icon-btn"
              onClick={onPrevDay}
              aria-label="前一天"
            >
              ‹
            </button>
            <input
              type="date"
              className="date-nav__current"
              value={dateKey}
              onChange={(e) => onDateChange(e.target.value)}
            />
            <button
              className="tb-icon-btn"
              onClick={onNextDay}
              aria-label="后一天"
            >
              ›
            </button>
          </div>
          <button
            className="tb-btn tb-btn--primary"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating
              ? "生成中..."
              : isPastDate
                ? "补跑复盘"
                : "生成我的复盘"}
          </button>
        </div>
        <div className="reports-empty">
          <p>{isPastDate ? "这天还没有复盘。" : "今天还没有复盘。"}</p>
          <p className="reports-empty__hint">
            {isPastDate
              ? `点击"补跑复盘"，把 ${dateKey} 的记录整理成一份给自己看的回顾。`
              : '点击"生成我的复盘"，把今天的记录整理成一份给自己看的回顾。'}
          </p>
        </div>
      </section>
    );
  }

  const compiledText = compilePersonalReviewToText(personalReview);

  // 编辑模式
  if (editing) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevDay} aria-label="前一天">
              ‹
            </button>
            <input
              type="date"
              className="date-nav__current"
              value={dateKey}
              onChange={(e) => onDateChange(e.target.value)}
            />
            <button className="tb-icon-btn" onClick={onNextDay} aria-label="后一天">
              ›
            </button>
          </div>
          <div className="reports-toolbar__actions">
            <button
              className="tb-btn tb-btn--primary"
              onClick={onSave}
            >
              保存
            </button>
            <button className="tb-btn" onClick={onCancelEdit}>
              取消
            </button>
          </div>
        </div>
        <div className="report-editor">
          <p className="report-editor__hint">
            编辑复盘正文。保存后会写入 reports，复制时输出纯文本。
          </p>
          <textarea
            className="report-editor__textarea"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>
    );
  }

  // 已生成：展示结构化内容
  return (
    <section className="reports-tab-panel">
      <div className="reports-toolbar">
        <div className="date-nav">
          <button className="tb-icon-btn" onClick={onPrevDay} aria-label="前一天">
            ‹
          </button>
          <input
            type="date"
            className="date-nav__current"
            value={dateKey}
            onChange={(e) => onDateChange(e.target.value)}
          />
          <button className="tb-icon-btn" onClick={onNextDay} aria-label="后一天">
            ›
          </button>
        </div>
        <div className="reports-toolbar__actions">
          <button
            className="tb-btn"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating ? "重新生成中..." : "重新生成"}
          </button>
          <button className="tb-btn" onClick={() => onCopy(compiledText)}>
            复制
          </button>
          <button className="tb-btn" onClick={() => onEnterEdit(compiledText)}>
            编辑
          </button>
        </div>
      </div>

      <article className="report-article">
        <header className="report-article__header">
          <h3 className="report-article__title">{personalReview.title}</h3>
          <span className="report-article__date">{dateKey}</span>
        </header>

        {/* 今天主要在做什么 */}
        <section className="report-section">
          <h4 className="report-section__title">今天主要在做什么</h4>
          <p className="report-section__text">
            {personalReview.overview || "（暂无总览）"}
          </p>
          {(personalReview.mainThreads ?? []).length > 0 && (
            <ul className="report-section__bullets">
              {personalReview.mainThreads.map((thread, idx) => (
                <li key={`thread-${idx}`}>{thread}</li>
              ))}
            </ul>
          )}
        </section>

        {/* 有价值的进展 */}
        <section className="report-section">
          <h4 className="report-section__title">有价值的进展</h4>
          {(personalReview.meaningfulProgress ?? []).length > 0 ? (
            <ul className="report-section__bullets">
              {personalReview.meaningfulProgress.map((progress, idx) => (
                <li key={`progress-${idx}`}>{progress}</li>
              ))}
            </ul>
          ) : (
            <p className="report-section__empty">今天没有记录到明显的进展。</p>
          )}
        </section>

        {/* 还没收尾的事 */}
        <section className="report-section">
          <h4 className="report-section__title">还没收尾的事</h4>
          {(personalReview.unfinished ?? []).length > 0 ? (
            <div className="report-section__list">
              {personalReview.unfinished.map((item, idx) => (
                <div key={`unfinished-${idx}`} className="report-entry">
                  <div className="report-entry__body">
                    <p className="report-entry__text">{item.text}</p>
                    {item.suggestedNextAction && (
                      <p className="report-entry__meta">
                        建议下一步：{item.suggestedNextAction}
                      </p>
                    )}
                  </div>
                  <div className="report-entry__actions">
                    {((item.sourceFactIds ?? []).length > 0 ||
                      (item.sourceTimelineBlockIds ?? []).length > 0) && (
                      <button
                        className="report-entry__action"
                        onClick={() =>
                          onViewSource({
                            factIds: item.sourceFactIds,
                            blockIds: item.sourceTimelineBlockIds,
                          })
                        }
                      >
                        查看来源
                      </button>
                    )}
                    <button
                      className="report-entry__action report-entry__action--danger"
                      onClick={() => onDeleteEntry("unfinished", idx)}
                    >
                      删除此条
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="report-section__empty">今天没有未收尾的事。</p>
          )}
        </section>

        {/* 值得以后记住 */}
        <section className="report-section">
          <h4 className="report-section__title">值得以后记住</h4>
          {(personalReview.worthRemembering ?? []).length > 0 ? (
            <div className="report-section__list">
              {personalReview.worthRemembering.map((item, idx) => (
                <div key={`remember-${idx}`} className="report-entry">
                  <div className="report-entry__body">
                    <p className="report-entry__text">{item.text}</p>
                    {item.reason && (
                      <p className="report-entry__meta">理由：{item.reason}</p>
                    )}
                  </div>
                  <div className="report-entry__actions">
                    {(item.sourceFactIds ?? []).length > 0 && (
                      <button
                        className="report-entry__action"
                        onClick={() =>
                          onViewSource({
                            factIds: item.sourceFactIds,
                            blockIds: [],
                          })
                        }
                      >
                        查看来源
                      </button>
                    )}
                    <button
                      className="report-entry__action report-entry__action--danger"
                      onClick={() => onDeleteEntry("worthRemembering", idx)}
                    >
                      删除此条
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="report-section__empty">今天没有特别需要记住的事。</p>
          )}
        </section>

        {/* 明天可以从这里继续 */}
        <section className="report-section">
          <h4 className="report-section__title">明天可以从这里继续</h4>
          {(personalReview.tomorrowStartHere ?? []).length > 0 ? (
            <ol className="report-section__numbered">
              {personalReview.tomorrowStartHere.map((tip, idx) => (
                <li key={`tomorrow-${idx}`}>{tip}</li>
              ))}
            </ol>
          ) : (
            <p className="report-section__empty">暂无建议。</p>
          )}
        </section>
      </article>
    </section>
  );
}

// ============================================================================
// 工作日报 Tab
// ============================================================================

interface WorkReportTabProps {
  dateKey: string;
  workReport: WorkReport | null;
  loading: boolean;
  editing: boolean;
  draft: string;
  style: "brief" | "standard" | "formal";
  onStyleChange: (style: "brief" | "standard" | "formal") => void;
  onDateChange: (dateKey: string) => void;
  onPrevDay: () => void;
  onNextDay: () => void;
  onEnterSelection: () => void;
  onCopy: (text: string) => void;
  onEnterEdit: (text: string) => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDraftChange: (draft: string) => void;
  onExportMarkdown: (text: string) => void;
  onViewSource: () => void;
}

function WorkReportTab(props: WorkReportTabProps) {
  const {
    dateKey,
    workReport,
    loading,
    editing,
    draft,
    style,
    onStyleChange,
    onDateChange,
    onPrevDay,
    onNextDay,
    onEnterSelection,
    onCopy,
    onEnterEdit,
    onCancelEdit,
    onSave,
    onDraftChange,
    onExportMarkdown,
    onViewSource,
  } = props;

  if (loading && !workReport) {
    return <div className="reports-loading">正在加载工作日报...</div>;
  }

  // 日期感知：过去 / 今天 的空状态文案不同（用户可能来补跑某天）
  const isPastDate = dateKey < todayDateKey();

  // 未生成时：显示引导
  if (!workReport) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevDay} aria-label="前一天">
              ‹
            </button>
            <input
              type="date"
              className="date-nav__current"
              value={dateKey}
              onChange={(e) => onDateChange(e.target.value)}
            />
            <button className="tb-icon-btn" onClick={onNextDay} aria-label="后一天">
              ›
            </button>
          </div>
          {/* 风格切换：简洁 / 标准 / 稍正式（默认标准） */}
          <div className="seg-control">
            {WORK_STYLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`seg-control__btn${style === opt.value ? " is-active" : ""}`}
                onClick={() => onStyleChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="reports-empty">
          <p>{isPastDate ? "这天还没有工作日报。" : "还没有工作日报。"}</p>
          <p className="reports-empty__hint">
            {isPastDate
              ? `点击下方按钮，选择 ${dateKey} 适合汇报的工作片段，补跑一份日报。`
              : "先选择今天适合汇报的工作片段，再生成一份可复制的日报。"}
          </p>
          <button
            className="tb-btn tb-btn--primary reports-empty__action"
            onClick={onEnterSelection}
          >
            {isPastDate ? "补跑日报" : "选择片段生成日报"}
          </button>
        </div>
      </section>
    );
  }

  // 编辑模式
  if (editing) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevDay} aria-label="前一天">
              ‹
            </button>
            <input
              type="date"
              className="date-nav__current"
              value={dateKey}
              onChange={(e) => onDateChange(e.target.value)}
            />
            <button className="tb-icon-btn" onClick={onNextDay} aria-label="后一天">
              ›
            </button>
          </div>
          <div className="reports-toolbar__actions">
            <button className="tb-btn tb-btn--primary" onClick={onSave}>
              保存
            </button>
            <button className="tb-btn" onClick={onCancelEdit}>
              取消
            </button>
          </div>
        </div>
        <div className="report-editor">
          <p className="report-editor__hint">
            编辑日报正文。保存后会写入 reports，复制时输出纯文本。
          </p>
          <textarea
            className="report-editor__textarea"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>
    );
  }

  // 已生成：展示结构化内容
  // 防御（2026-07-07）：workReport.sections 等字段可能缺失，统一兜底空数组
  const sections = workReport.sections ?? {
    completed: [],
    projectProgress: [],
    risks: [],
    tomorrowPlan: [],
  };
  const hasSections =
    (sections.completed ?? []).length > 0 ||
    (sections.projectProgress ?? []).length > 0 ||
    (sections.risks ?? []).length > 0 ||
    (sections.tomorrowPlan ?? []).length > 0;

  return (
    <section className="reports-tab-panel">
      <div className="reports-toolbar">
        <div className="date-nav">
          <button className="tb-icon-btn" onClick={onPrevDay} aria-label="前一天">
            ‹
          </button>
          <input
            type="date"
            className="date-nav__current"
            value={dateKey}
            onChange={(e) => onDateChange(e.target.value)}
          />
          <button className="tb-icon-btn" onClick={onNextDay} aria-label="后一天">
            ›
          </button>
        </div>
        <div className="reports-toolbar__actions">
          {/* 风格切换 */}
          <div className="seg-control">
            {WORK_STYLE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`seg-control__btn${style === opt.value ? " is-active" : ""}`}
                onClick={() => onStyleChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button className="tb-btn" onClick={() => onCopy(workReport.plainText)}>
            复制
          </button>
          <button
            className="tb-btn"
            onClick={() => onEnterEdit(workReport.plainText)}
          >
            编辑
          </button>
          <button className="tb-btn" onClick={onEnterSelection}>
            重新选择片段
          </button>
          <button
            className="tb-btn"
            onClick={() => onExportMarkdown(workReport.plainText)}
          >
            导出 Markdown
          </button>
        </div>
      </div>

      {(workReport.warnings ?? []).length > 0 && (
        <div className="reports-warnings">
          {workReport.warnings.map((w, idx) => (
            <p key={`warn-${idx}`}>{w}</p>
          ))}
        </div>
      )}

      <article className="report-article">
        <header className="report-article__header">
          <h3 className="report-article__title">{workReport.title}</h3>
          <span className="report-article__date">{dateKey}</span>
        </header>

        {/* 今日完成 */}
        <section className="report-section">
          <h4 className="report-section__title">今日完成</h4>
          {hasSections && (sections.completed ?? []).length > 0 ? (
            <ul className="report-section__bullets">
              {sections.completed.map((item, idx) => (
                <li key={`done-${idx}`}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="report-section__text">{workReport.plainText || "（暂无内容）"}</p>
          )}
        </section>

        {/* 项目进展 */}
        {(sections.projectProgress ?? []).length > 0 && (
          <section className="report-section">
            <h4 className="report-section__title">项目进展</h4>
            <ul className="report-section__bullets">
              {sections.projectProgress.map((item, idx) => (
                <li key={`proj-${idx}`}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        {/* 问题与风险 */}
        {(sections.risks ?? []).length > 0 && (
          <section className="report-section">
            <h4 className="report-section__title">问题与风险</h4>
            <ul className="report-section__bullets">
              {sections.risks.map((item, idx) => (
                <li key={`risk-${idx}`}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        {/* 明日计划 */}
        {(sections.tomorrowPlan ?? []).length > 0 && (
          <section className="report-section">
            <h4 className="report-section__title">明日计划</h4>
            <ul className="report-section__bullets">
              {sections.tomorrowPlan.map((item, idx) => (
                <li key={`plan-${idx}`}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        {/* 完整正文（可复制纯文本） */}
        <section className="report-section report-section--fulltext">
          <h4 className="report-section__title">完整正文</h4>
          <pre className="report-section__pre">{workReport.plainText || ""}</pre>
        </section>

        {/* 来源信息 */}
        {((workReport.sourceFactIds ?? []).length > 0 ||
          (workReport.sourceTimelineBlockIds ?? []).length > 0) && (
          <section className="report-section">
            <h4 className="report-section__title">来源</h4>
            <div className="report-source-summary">
              <span className="tag">
                事实 {workReport.sourceFactIds.length} 条
              </span>
              <span className="tag">
                片段 {workReport.sourceTimelineBlockIds.length} 个
              </span>
              {(workReport.omittedForPrivacy ?? 0) > 0 && (
                <span className="tag tag-warning">
                  因隐私省略 {workReport.omittedForPrivacy} 条
                </span>
              )}
              <button className="report-entry__action" onClick={onViewSource}>
                查看来源
              </button>
            </div>
          </section>
        )}
      </article>
    </section>
  );
}

// ============================================================================
// 周报 Tab
// ============================================================================

interface WeeklyReportTabProps {
  weekStart: string;
  reports: ReportItem[];
  loading: boolean;
  editing: boolean;
  draft: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onGenerate: () => void;
  onCopy: (text: string) => void;
  onEnterEdit: (text: string) => void;
  onCancelEdit: () => void;
  onSave: (id: string) => void;
  onDraftChange: (draft: string) => void;
  onExportMarkdown: (text: string, id: string) => void;
  onViewSource: (item: ReportItem) => void;
}

function WeeklyReportTab(props: WeeklyReportTabProps) {
  const {
    weekStart,
    reports,
    loading,
    editing,
    draft,
    onPrevWeek,
    onNextWeek,
    onGenerate,
    onCopy,
    onEnterEdit,
    onCancelEdit,
    onSave,
    onDraftChange,
    onExportMarkdown,
    onViewSource,
  } = props;

  const weekEnd = addDays(weekStart, 6);
  const currentReport = reports.find((r) => r.dateKey === weekStart) ?? null;

  if (loading && reports.length === 0) {
    return <div className="reports-loading">正在加载周报...</div>;
  }

  // 编辑模式
  if (editing && currentReport) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevWeek} aria-label="上一周">
              ‹
            </button>
            <span className="date-nav__current">
              {weekStart} ~ {weekEnd}
            </span>
            <button className="tb-icon-btn" onClick={onNextWeek} aria-label="下一周">
              ›
            </button>
          </div>
          <div className="reports-toolbar__actions">
            <button
              className="tb-btn tb-btn--primary"
              onClick={() => onSave(currentReport.id)}
            >
              保存
            </button>
            <button className="tb-btn" onClick={onCancelEdit}>
              取消
            </button>
          </div>
        </div>
        <div className="report-editor">
          <p className="report-editor__hint">
            编辑周报正文。保存后会写入 reports，复制时输出纯文本。
          </p>
          <textarea
            className="report-editor__textarea"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>
    );
  }

  // 当前周无周报
  if (!currentReport) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevWeek} aria-label="上一周">
              ‹
            </button>
            <span className="date-nav__current">
              {weekStart} ~ {weekEnd}
            </span>
            <button className="tb-icon-btn" onClick={onNextWeek} aria-label="下一周">
              ›
            </button>
          </div>
          <button className="tb-btn tb-btn--primary" onClick={onGenerate}>
            生成周报
          </button>
        </div>
        <div className="reports-empty">
          <p>本周还没有周报。</p>
          <p className="reports-empty__hint">
            点击"生成周报"汇总本周已确认日报与可汇报时间轴片段。
          </p>
        </div>

        {/* 历史周报列表 */}
        {reports.length > 0 && (
          <ReportList
            reports={reports}
            onCopy={onCopy}
            onViewSource={onViewSource}
            onExport={onExportMarkdown}
          />
        )}
      </section>
    );
  }

  // 当前周有周报
  const compiledText = compileReportItemToText(currentReport);
  const sections = parseReportSections(currentReport);

  return (
    <section className="reports-tab-panel">
      <div className="reports-toolbar">
        <div className="date-nav">
          <button className="tb-icon-btn" onClick={onPrevWeek} aria-label="上一周">
            ‹
          </button>
          <span className="date-nav__current">
            {weekStart} ~ {weekEnd}
          </span>
          <button className="tb-icon-btn" onClick={onNextWeek} aria-label="下一周">
            ›
          </button>
        </div>
        <div className="reports-toolbar__actions">
          <button className="tb-btn" onClick={onGenerate}>
            生成周报
          </button>
          <button className="tb-btn" onClick={() => onCopy(compiledText)}>
            复制
          </button>
          <button className="tb-btn" onClick={() => onEnterEdit(compiledText)}>
            编辑
          </button>
          <button
            className="tb-btn"
            onClick={() => onExportMarkdown(compiledText, currentReport.id)}
          >
            导出 Markdown
          </button>
        </div>
      </div>

      <article className="report-article">
        <header className="report-article__header">
          <h3 className="report-article__title">{currentReport.title}</h3>
          <span className="report-article__date">
            {weekStart} ~ {weekEnd}
          </span>
        </header>

        <ReportSectionsDisplay sections={sections} rawText={compiledText} />

        {/* 来源信息 */}
        {(currentReport.sourceFactIds.length > 0 ||
          currentReport.sourceSceneIds.length > 0) && (
          <section className="report-section">
            <h4 className="report-section__title">来源</h4>
            <div className="report-source-summary">
              <span className="tag">
                事实 {currentReport.sourceFactIds.length} 条
              </span>
              <span className="tag">
                场景 {currentReport.sourceSceneIds.length} 个
              </span>
              <button
                className="report-entry__action"
                onClick={() => onViewSource(currentReport)}
              >
                查看来源
              </button>
            </div>
          </section>
        )}
      </article>

      {/* 历史周报 */}
      {reports.filter((r) => r.id !== currentReport.id).length > 0 && (
        <div className="reports-history-section">
          <h4 className="reports-history-section__title">历史周报</h4>
          <ReportList
            reports={reports.filter((r) => r.id !== currentReport.id)}
            onCopy={onCopy}
            onViewSource={onViewSource}
            onExport={onExportMarkdown}
          />
        </div>
      )}
    </section>
  );
}

// ============================================================================
// 月报 Tab
// ============================================================================

interface MonthlyReportTabProps {
  monthKey: string;
  reports: ReportItem[];
  loading: boolean;
  editing: boolean;
  draft: string;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onGenerate: () => void;
  onCopy: (text: string) => void;
  onEnterEdit: (text: string) => void;
  onCancelEdit: () => void;
  onSave: (id: string) => void;
  onDraftChange: (draft: string) => void;
  onExportMarkdown: (text: string, id: string) => void;
  onViewSource: (item: ReportItem) => void;
}

function MonthlyReportTab(props: MonthlyReportTabProps) {
  const {
    monthKey,
    reports,
    loading,
    editing,
    draft,
    onPrevMonth,
    onNextMonth,
    onGenerate,
    onCopy,
    onEnterEdit,
    onCancelEdit,
    onSave,
    onDraftChange,
    onExportMarkdown,
    onViewSource,
  } = props;

  const currentReport =
    reports.find((r) => r.dateKey.startsWith(monthKey)) ?? null;

  if (loading && reports.length === 0) {
    return <div className="reports-loading">正在加载月报...</div>;
  }

  // 编辑模式
  if (editing && currentReport) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevMonth} aria-label="上个月">
              ‹
            </button>
            <span className="date-nav__current">{monthKey}</span>
            <button className="tb-icon-btn" onClick={onNextMonth} aria-label="下个月">
              ›
            </button>
          </div>
          <div className="reports-toolbar__actions">
            <button
              className="tb-btn tb-btn--primary"
              onClick={() => onSave(currentReport.id)}
            >
              保存
            </button>
            <button className="tb-btn" onClick={onCancelEdit}>
              取消
            </button>
          </div>
        </div>
        <div className="report-editor">
          <p className="report-editor__hint">
            编辑月报正文。保存后会写入 reports，复制时输出纯文本。
          </p>
          <textarea
            className="report-editor__textarea"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            spellCheck={false}
          />
        </div>
      </section>
    );
  }

  // 当月无月报（月报可后置，但页面结构保留）
  if (!currentReport) {
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <div className="date-nav">
            <button className="tb-icon-btn" onClick={onPrevMonth} aria-label="上个月">
              ‹
            </button>
            <span className="date-nav__current">{monthKey}</span>
            <button className="tb-icon-btn" onClick={onNextMonth} aria-label="下个月">
              ›
            </button>
          </div>
          <button className="tb-btn tb-btn--primary" onClick={onGenerate}>
            生成月报
          </button>
        </div>
        <div className="reports-empty">
          <p>本月还没有月报。</p>
          <p className="reports-empty__hint">
            月报会汇总本月主要项目、关键成果、重要决策和持续风险。
          </p>
        </div>

        {reports.length > 0 && (
          <ReportList
            reports={reports}
            onCopy={onCopy}
            onViewSource={onViewSource}
            onExport={onExportMarkdown}
          />
        )}
      </section>
    );
  }

  // 当月有月报
  const compiledText = compileReportItemToText(currentReport);
  const sections = parseReportSections(currentReport);

  return (
    <section className="reports-tab-panel">
      <div className="reports-toolbar">
        <div className="date-nav">
          <button className="tb-icon-btn" onClick={onPrevMonth} aria-label="上个月">
            ‹
          </button>
          <span className="date-nav__current">{monthKey}</span>
          <button className="tb-icon-btn" onClick={onNextMonth} aria-label="下个月">
            ›
          </button>
        </div>
        <div className="reports-toolbar__actions">
          <button className="tb-btn" onClick={onGenerate}>
            生成月报
          </button>
          <button className="tb-btn" onClick={() => onCopy(compiledText)}>
            复制
          </button>
          <button className="tb-btn" onClick={() => onEnterEdit(compiledText)}>
            编辑
          </button>
          <button
            className="tb-btn"
            onClick={() => onExportMarkdown(compiledText, currentReport.id)}
          >
            导出 Markdown
          </button>
        </div>
      </div>

      <article className="report-article">
        <header className="report-article__header">
          <h3 className="report-article__title">{currentReport.title}</h3>
          <span className="report-article__date">{monthKey}</span>
        </header>

        <ReportSectionsDisplay sections={sections} rawText={compiledText} />

        {(currentReport.sourceFactIds.length > 0 ||
          currentReport.sourceSceneIds.length > 0) && (
          <section className="report-section">
            <h4 className="report-section__title">来源</h4>
            <div className="report-source-summary">
              <span className="tag">
                事实 {currentReport.sourceFactIds.length} 条
              </span>
              <span className="tag">
                场景 {currentReport.sourceSceneIds.length} 个
              </span>
              <button
                className="report-entry__action"
                onClick={() => onViewSource(currentReport)}
              >
                查看来源
              </button>
            </div>
          </section>
        )}
      </article>
    </section>
  );
}

// ============================================================================
// 历史 Tab
// ============================================================================

interface HistoryTabProps {
  reports: ReportItem[];
  loading: boolean;
  typeFilter: string;
  dateFrom: string;
  dateTo: string;
  projectFilter: string;
  projects: ProjectItem[];
  detail: ReportItem | null;
  onTypeFilterChange: (type: string) => void;
  onDateFromChange: (dateKey: string) => void;
  onDateToChange: (dateKey: string) => void;
  onProjectFilterChange: (projectId: string) => void;
  onViewDetail: (item: ReportItem | null) => void;
  onCopy: (text: string) => void;
  onDelete: (id: string) => void;
  onViewSource: (item: ReportItem) => void;
}

function HistoryTab(props: HistoryTabProps) {
  const {
    reports,
    loading,
    typeFilter,
    dateFrom,
    dateTo,
    projectFilter,
    projects,
    detail,
    onTypeFilterChange,
    onDateFromChange,
    onDateToChange,
    onProjectFilterChange,
    onViewDetail,
    onCopy,
    onDelete,
    onViewSource,
  } = props;

  if (loading && reports.length === 0) {
    return <div className="reports-loading">正在加载历史报告...</div>;
  }

  // 详情视图
  if (detail) {
    const compiledText = compileReportItemToText(detail);
    return (
      <section className="reports-tab-panel">
        <div className="reports-toolbar">
          <button className="tb-btn" onClick={() => onViewDetail(null)}>
            返回列表
          </button>
          <div className="reports-toolbar__actions">
            <button className="tb-btn" onClick={() => onCopy(compiledText)}>
              复制
            </button>
            <button
              className="tb-btn"
              onClick={() => onViewSource(detail)}
            >
              查看来源
            </button>
          </div>
        </div>
        <article className="report-article">
          <header className="report-article__header">
            <h3 className="report-article__title">{detail.title}</h3>
            <span className="report-article__date">{detail.dateKey}</span>
          </header>
          <pre className="report-section__pre">{compiledText}</pre>
        </article>
      </section>
    );
  }

  // 列表视图
  // 按项目过滤：若 projectFilter !== "all"，过滤出 projectId 匹配的报告。
  const filteredReports =
    projectFilter !== "all"
      ? reports.filter((r) => r.projectId === projectFilter)
      : reports;

  return (
    <section className="reports-tab-panel">
      {/* 过滤栏：类型 / 日期范围 / 项目 */}
      <div className="reports-filters">
        <div className="reports-filter-group">
          <label className="reports-filter__label">类型</label>
          <select
            className="reports-filter__select"
            value={typeFilter}
            onChange={(e) => onTypeFilterChange(e.target.value)}
          >
            <option value="all">全部</option>
            <option value="daily">日报</option>
            <option value="weekly">周报</option>
            <option value="monthly">月报</option>
            <option value="retrospective">复盘</option>
          </select>
        </div>
        <div className="reports-filter-group">
          <label className="reports-filter__label">起始日期</label>
          <input
            type="date"
            className="reports-filter__select"
            value={dateFrom}
            onChange={(e) => onDateFromChange(e.target.value)}
          />
        </div>
        <div className="reports-filter-group">
          <label className="reports-filter__label">结束日期</label>
          <input
            type="date"
            className="reports-filter__select"
            value={dateTo}
            onChange={(e) => onDateToChange(e.target.value)}
          />
        </div>
        <div className="reports-filter-group">
          <label className="reports-filter__label">项目</label>
          <select
            className="reports-filter__select"
            value={projectFilter}
            onChange={(e) => onProjectFilterChange(e.target.value)}
          >
            <option value="all">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filteredReports.length === 0 ? (
        <div className="reports-empty">
          <p>还没有任何报告。</p>
          <p className="reports-empty__hint">
            开始观察一段时间后，可以在这里查看历史报告。
          </p>
        </div>
      ) : (
        <div className="reports-history-list">
          <div className="reports-history-header">
            <span className="reports-history-col reports-history-col--date">
              日期/周期
            </span>
            <span className="reports-history-col reports-history-col--type">
              类型
            </span>
            <span className="reports-history-col reports-history-col--title">
              标题
            </span>
            <span className="reports-history-col reports-history-col--time">
              更新时间
            </span>
            <span className="reports-history-col reports-history-col--actions">
              操作
            </span>
          </div>
          {filteredReports.map((r) => (
            <div key={r.id} className="reports-history-row">
              <span className="reports-history-col reports-history-col--date">
                {r.dateKey}
              </span>
              <span className="reports-history-col reports-history-col--type">
                <span className="tag">
                  {REPORT_TYPE_LABELS[r.type] ?? r.type}
                </span>
              </span>
              <span
                className="reports-history-col reports-history-col--title"
                title={r.title}
              >
                {r.title}
              </span>
              <span className="reports-history-col reports-history-col--time">
                {formatUpdatedAt(r.updatedAt)}
              </span>
              <span className="reports-history-col reports-history-col--actions">
                <button
                  className="report-entry__action"
                  onClick={() => onViewDetail(r)}
                >
                  查看
                </button>
                <button
                  className="report-entry__action"
                  onClick={() => onCopy(compileReportItemToText(r))}
                >
                  复制
                </button>
                <button
                  className="report-entry__action report-entry__action--danger"
                  onClick={() => {
                    useAppStore.getState().requestConfirm({
                      title: "删除报告",
                      message: "确定删除这份报告？删除后无法恢复。",
                      confirmText: "确认删除",
                      onConfirm: () => onDelete(r.id),
                    });
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================================
// 报告列表（周报/月报历史）
// ============================================================================

interface ReportListProps {
  reports: ReportItem[];
  onCopy: (text: string) => void;
  onViewSource: (item: ReportItem) => void;
  onExport: (text: string, id: string) => void;
}

function ReportList({ reports, onCopy, onViewSource, onExport }: ReportListProps) {
  if (reports.length === 0) return null;
  return (
    <div className="reports-history-list">
      {reports.map((r) => (
        <div key={r.id} className="reports-history-row">
          <span className="reports-history-col reports-history-col--date">
            {r.dateKey}
          </span>
          <span className="reports-history-col reports-history-col--type">
            <span className="tag">
              {REPORT_TYPE_LABELS[r.type] ?? r.type}
            </span>
          </span>
          <span
            className="reports-history-col reports-history-col--title"
            title={r.title}
          >
            {r.title}
          </span>
          <span className="reports-history-col reports-history-col--time">
            {formatUpdatedAt(r.updatedAt)}
          </span>
          <span className="reports-history-col reports-history-col--actions">
            <button
              className="report-entry__action"
              onClick={() => onCopy(compileReportItemToText(r))}
            >
              复制
            </button>
            <button
              className="report-entry__action"
              onClick={() => onExport(compileReportItemToText(r), r.id)}
            >
              导出
            </button>
            <button
              className="report-entry__action"
              onClick={() => onViewSource(r)}
            >
              来源
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// 报告段落展示（周报/月报通用）
// ============================================================================

interface ReportSectionsDisplayProps {
  sections: Array<{ title: string; items: string[] }>;
  rawText: string;
}

function ReportSectionsDisplay({ sections, rawText }: ReportSectionsDisplayProps) {
  if (sections.length > 0) {
    return (
      <>
        {sections.map((section, idx) => (
          <section key={`section-${idx}`} className="report-section">
            <h4 className="report-section__title">{section.title}</h4>
            {section.items.length > 0 ? (
              <ul className="report-section__bullets">
                {section.items.map((item, itemIdx) => (
                  <li key={`item-${idx}-${itemIdx}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p className="report-section__empty">暂无内容。</p>
            )}
          </section>
        ))}
      </>
    );
  }
  // 没有结构化段落时，回退到纯文本展示
  return (
    <section className="report-section">
      <pre className="report-section__pre">{rawText}</pre>
    </section>
  );
}

// ============================================================================
// 来源面板（弹层，不默认显示截图）
// ============================================================================

interface SourcePanelProps {
  title: string;
  factIds: string[];
  sceneIds: string[];
  blockIds: string[];
  onClose: () => void;
}

function SourcePanel({
  title,
  factIds,
  sceneIds,
  blockIds,
  onClose,
}: SourcePanelProps) {
  const total = factIds.length + sceneIds.length + blockIds.length;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SourceEvidenceData>({
    facts: [],
    scenes: [],
    timelineBlocks: [],
  });

  useEffect(() => {
    let cancelled = false;

    const loadEvidence = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await getIpc().reports.getEvidenceByIds({
          factIds,
          sceneIds,
          blockIds,
        });
        if (cancelled) return;
        if (!res.ok) {
          setEvidence({ facts: [], scenes: [], timelineBlocks: [] });
          setLoadError(res.error);
          return;
        }
        const data = res.data;
        setEvidence({
          facts: Array.isArray(data.facts) ? (data.facts as FactItem[]) : [],
          scenes: Array.isArray(data.scenes) ? (data.scenes as SceneItem[]) : [],
          timelineBlocks: Array.isArray(data.timelineBlocks)
            ? (data.timelineBlocks as TimelineBlock[])
            : [],
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setEvidence({ facts: [], scenes: [], timelineBlocks: [] });
        setLoadError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void loadEvidence();
    return () => {
      cancelled = true;
    };
  }, [factIds, sceneIds, blockIds]);

  const blockMap = new Map(evidence.timelineBlocks.map((block) => [block.id, block]));
  const factMap = new Map(evidence.facts.map((fact) => [fact.id, fact]));
  const sceneMap = new Map(evidence.scenes.map((scene) => [scene.id, scene]));

  return (
    <div className="report-source-overlay" onClick={onClose}>
      <div
        className="report-source-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="report-source-panel__header">
          <h4 className="report-source-panel__title">{title}</h4>
          <button
            className="report-source-panel__close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="report-source-panel__body">
          <p className="report-source-panel__hint">
            以下为报告关联的事实、场景与时间轴片段。不显示截图。
          </p>

          <div className="report-source-panel__stats">
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">事实</span>
              <span className="report-source-panel__stat-value">
                {factIds.length}
              </span>
            </div>
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">场景</span>
              <span className="report-source-panel__stat-value">
                {sceneIds.length}
              </span>
            </div>
            <div className="report-source-panel__stat">
              <span className="report-source-panel__stat-label">片段</span>
              <span className="report-source-panel__stat-value">
                {blockIds.length}
              </span>
            </div>
          </div>

          {loading && (
            <p className="report-source-panel__empty">正在加载来源证据...</p>
          )}

          {!loading && loadError && (
            <p className="report-source-panel__empty">
              来源加载失败：{loadError}
            </p>
          )}

          {/* 时间轴片段：显示标题 / 时间范围 / 摘要 / 关键产出 */}
          {!loading && blockIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">时间轴片段</h5>
              <div className="report-source-panel__items">
                {blockIds.slice(0, 30).map((id) => {
                  const block = blockMap.get(id);
                  if (block) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">片段</span>
                          <span className="source-panel__item-title">
                            {block.title}
                          </span>
                        </div>
                        <p className="source-panel__item-meta">
                          时间范围：{block.startAt} ~ {block.endAt}
                        </p>
                        {block.summary && (
                          <p className="source-panel__item-summary">
                            {block.summary}
                          </p>
                        )}
                        {block.highlights.length > 0 && (
                          <div className="source-panel__item-highlights">
                            <span className="source-panel__item-highlights-label">
                              关键产出：
                            </span>
                            <ul>
                              {block.highlights.map((h, i) => (
                                <li key={i}>{h}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">片段</span>
                      <span className="source-panel__item-hint">
                        该片段未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {blockIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {blockIds.length} 个
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 来源事实：显示内容 */}
          {!loading && factIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">来源事实</h5>
              <div className="report-source-panel__items">
                {factIds.slice(0, 30).map((id) => {
                  const fact = factMap.get(id);
                  if (fact) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">事实</span>
                          <span className="source-panel__item-title">
                            {fact.type}
                          </span>
                        </div>
                        <p className="source-panel__item-summary">
                          {fact.content}
                        </p>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">事实</span>
                      <span className="source-panel__item-hint">
                        该事实未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {factIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {factIds.length} 条
                  </p>
                )}
              </div>
            </div>
          )}

          {/* 来源场景：显示标题 / 时间范围 / 摘要 */}
          {!loading && sceneIds.length > 0 && (
            <div className="report-source-panel__group">
              <h5 className="report-source-panel__group-title">来源场景</h5>
              <div className="report-source-panel__items">
                {sceneIds.slice(0, 30).map((id) => {
                  const scene = sceneMap.get(id);
                  if (scene) {
                    return (
                      <div key={id} className="source-panel__item">
                        <div className="source-panel__item-header">
                          <span className="tag tag-category">场景</span>
                          <span className="source-panel__item-title">
                            {scene.title}
                          </span>
                        </div>
                        <p className="source-panel__item-meta">
                          时间范围：{scene.startAt} ~ {scene.endAt}
                        </p>
                        {scene.summary && (
                          <p className="source-panel__item-summary">
                            {scene.summary}
                          </p>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={id}
                      className="source-panel__item source-panel__item--missing"
                    >
                      <span className="tag tag-category">场景</span>
                      <span className="source-panel__item-hint">
                        该场景未找到，或已不再保留
                      </span>
                    </div>
                  );
                })}
                {sceneIds.length > 30 && (
                  <p className="report-source-panel__id-more">
                    ...共 {sceneIds.length} 个
                  </p>
                )}
              </div>
            </div>
          )}

          {!loading && total === 0 && (
            <p className="report-source-panel__empty">
              本报告未关联来源。重要条目通常会显示来源事实或场景。
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 工具函数
// ============================================================================

/** 将 Date 格式化为 dateKey（YYYY-MM-DD） */
function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 获取今日 dateKey */
function getTodayKey(): string {
  return formatDateKey(new Date());
}

/** 在 dateKey 上加减天数，返回新 dateKey */
function addDays(dateKey: string, days: number): string {
  const d = new Date(dateKey + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatDateKey(d);
}

/** 在 monthKey（YYYY-MM）上加减月份 */
function addMonths(monthKey: string, months: number): string {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(y, (m - 1) + months, 1);
  const newY = d.getFullYear();
  const newM = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${newY}-${newM}`;
}

/** 格式化 updatedAt 为简短显示 */
function formatUpdatedAt(updatedAt: string): string {
  if (!updatedAt) return "-";
  try {
    const d = new Date(updatedAt);
    return `${d.getFullYear()}-${(d.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${d.getDate().toString().padStart(2, "0")} ${d
      .getHours()
      .toString()
      .padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  } catch {
    return updatedAt;
  }
}

/**
 * 将 PersonalReview 编译为可复制的纯文本。
 * 语气温和、面向自己，与工作日报明显区分。
 */
function compilePersonalReviewToText(pr: PersonalReview): string {
  const lines: string[] = [];
  lines.push(`# ${pr.title || "我的复盘"}`);
  lines.push(`日期：${pr.dateKey}`);
  lines.push("");

  lines.push("## 今天主要在做什么");
  lines.push(pr.overview || "（暂无总览）");
  if ((pr.mainThreads ?? []).length > 0) {
    pr.mainThreads.forEach((t) => lines.push(`- ${t}`));
  }
  lines.push("");

  lines.push("## 有价值的进展");
  if ((pr.meaningfulProgress ?? []).length > 0) {
    pr.meaningfulProgress.forEach((p) => lines.push(`- ${p}`));
  } else {
    lines.push("今天没有记录到明显的进展。");
  }
  lines.push("");

  lines.push("## 还没收尾的事");
  if ((pr.unfinished ?? []).length > 0) {
    pr.unfinished.forEach((u) => {
      lines.push(`- ${u.text}`);
      if (u.suggestedNextAction) {
        lines.push(`  建议下一步：${u.suggestedNextAction}`);
      }
    });
  } else {
    lines.push("今天没有未收尾的事。");
  }
  lines.push("");

  lines.push("## 值得以后记住");
  if ((pr.worthRemembering ?? []).length > 0) {
    pr.worthRemembering.forEach((w) => {
      lines.push(`- ${w.text}`);
      if (w.reason) lines.push(`  理由：${w.reason}`);
    });
  } else {
    lines.push("今天没有特别需要记住的事。");
  }
  lines.push("");

  lines.push("## 明天可以从这里继续");
  if ((pr.tomorrowStartHere ?? []).length > 0) {
    pr.tomorrowStartHere.forEach((t, idx) => lines.push(`${idx + 1}. ${t}`));
  } else {
    lines.push("暂无建议。");
  }

  return lines.join("\n");
}

/**
 * 将 ReportItem（周报/月报/历史）的 contentJson 编译为纯文本。
 * 优先级：plainText 字段 > formatReportAsText（日报/周报结构）> 原始 contentJson。
 */
function compileReportItemToText(item: ReportItem): string {
  // 1. 尝试解析 contentJson
  try {
    const parsed = JSON.parse(item.contentJson) as Record<string, unknown>;

    // 2. 如果是编辑后的 {plainText: "..."} 格式
    if (typeof parsed.plainText === "string") {
      return parsed.plainText;
    }

    // 3. 如果是日报/周报结构（有 headline/overview 字段），使用 formatReportAsText
    if (
      typeof parsed.headline === "string" &&
      typeof parsed.overview === "string"
    ) {
      try {
        return formatReportAsText(
          parsed as unknown as Parameters<typeof formatReportAsText>[0],
          item.title,
          item.dateKey
        );
      } catch {
        // 解析失败，回退
      }
    }

    // 4. 其他结构：尝试提取常见字段拼装
    const lines: string[] = [];
    lines.push(`# ${item.title}`);
    lines.push(`日期：${item.dateKey}`);
    lines.push("");
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        lines.push(`## ${key}`);
        value.forEach((v) => {
          if (typeof v === "string") {
            lines.push(`- ${v}`);
          } else if (v && typeof v === "object") {
            const obj = v as Record<string, unknown>;
            const text =
              typeof obj.text === "string"
                ? obj.text
                : typeof obj.summary === "string"
                ? obj.summary
                : JSON.stringify(v);
            lines.push(`- ${text}`);
          }
        });
        lines.push("");
      } else if (typeof value === "string" && key !== "date" && key !== "weekStart" && key !== "weekEnd") {
        lines.push(`## ${key}`);
        lines.push(value);
        lines.push("");
      }
    }
    return lines.join("\n");
  } catch {
    // 5. contentJson 不是合法 JSON，直接返回
    return item.contentJson || item.title;
  }
}

/**
 * 从 ReportItem 的 contentJson 解析出结构化段落。
 * 用于周报/月报的结构化展示。
 *
 * section 标题按 spec Phase 4：
 * - 周报：本周概览 / 项目进展 / 完成事项 / 关键决策 / 风险与阻塞 / 下周计划
 * - 月报：本月概览 / 主要项目 / 关键成果 / 重要决策 / 持续风险 / 下月重点
 */
function parseReportSections(
  item: ReportItem
): Array<{ title: string; items: string[] }> {
  try {
    const parsed = JSON.parse(item.contentJson) as Record<string, unknown>;

    // 编辑后的 plainText 格式：无结构化段落
    if (typeof parsed.plainText === "string") {
      return [];
    }

    const sections: Array<{ title: string; items: string[] }> = [];
    const isMonthly = item.type === "monthly";

    // 概览
    if (typeof parsed.overview === "string") {
      sections.push({
        title: isMonthly ? "本月概览" : "本周概览",
        items: [parsed.overview as string],
      });
    }

    // projectUpdates -> 主要项目 / 项目进展
    if (Array.isArray(parsed.projectUpdates)) {
      sections.push({
        title: isMonthly ? "主要项目" : "项目进展",
        items: (parsed.projectUpdates as Array<Record<string, unknown>>).map(
          (p) => {
            const name = typeof p.projectName === "string" ? p.projectName : "";
            const summary = typeof p.summary === "string" ? p.summary : "";
            return name ? `${name}：${summary}` : summary;
          }
        ),
      });
    }

    // completed -> 关键成果 / 完成事项
    if (Array.isArray(parsed.completed)) {
      sections.push({
        title: isMonthly ? "关键成果" : "完成事项",
        items: (parsed.completed as Array<Record<string, unknown>>).map(
          (c) => (typeof c.text === "string" ? c.text : String(c))
        ),
      });
    }

    // decisions -> 重要决策 / 关键决策
    if (Array.isArray(parsed.decisions)) {
      sections.push({
        title: isMonthly ? "重要决策" : "关键决策",
        items: (parsed.decisions as Array<Record<string, unknown>>).map(
          (d) => (typeof d.text === "string" ? d.text : String(d))
        ),
      });
    }

    // risks -> 持续风险 / 风险与阻塞
    if (Array.isArray(parsed.risks)) {
      sections.push({
        title: isMonthly ? "持续风险" : "风险与阻塞",
        items: (parsed.risks as Array<Record<string, unknown>>).map(
          (r) => (typeof r.text === "string" ? r.text : String(r))
        ),
      });
    }

    // nextWeekSuggestions (周报) / nextMonthSuggestions (月报)
    const nextKey = parsed.nextWeekSuggestions
      ? "nextWeekSuggestions"
      : parsed.nextMonthSuggestions
      ? "nextMonthSuggestions"
      : null;
    if (nextKey && Array.isArray(parsed[nextKey])) {
      sections.push({
        title: isMonthly ? "下月重点" : "下周计划",
        items: (parsed[nextKey] as string[]).map(String),
      });
    }

    return sections;
  } catch {
    return [];
  }
}
