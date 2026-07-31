// src/renderer/pages/TodayPage.tsx
// 今日页（Phase 3，doc 21）
//
// 布局（AppShell 已提供 76px Sidebar）：
//   .today-page  ->  grid: 1fr（时间轴占满）
//   右侧结果面板默认隐藏，点击右上角按钮以 drawer 浮层展开
//
// 中间主区域：TimelineHeader / TimelineToolbar / TimelineList
// 右侧面板：TodaySidePanel（7 模块）或 WorkReportSelectionPanel（选择模式）
//
// 状态：
// - 模型错误：全页 ErrorState
// - 暂停中：全页 EmptyState（恢复观察）
// - 首次未开始：全页 EmptyState（开始观察 / 配置模型）
// - 观察中：完整布局
//
// 重要约束（spec 第 14 节）：前台禁止出现 L0/L1/L2/Fact/Scene/Model job 等技术词。

import { useEffect, useMemo, useState } from "react";
import { PanelRight, RefreshCw } from "lucide-react";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { TimelineHeader } from "./today/TimelineHeader";
import { TimelineToolbar, type TimelineViewMode } from "./today/TimelineToolbar";
import { TimelineList } from "./today/TimelineList";
import { TodaySidePanel } from "./today/TodaySidePanel";
import { WorkReportSelectionPanel } from "./today/WorkReportSelectionPanel";
import { WorkReportPreviewModal } from "./today/WorkReportPreviewModal";
import { friendlyDateLabel, isWorkCategory, todayDateKey } from "./today/helpers";
import { TodayVisualizationBand } from "./today/TodayVisualizationBand";
import { MemoryDetailPage, type MemoryDetailRef } from "./MemoryDetailPage";
import { MacPermissionBanner } from "../components/MacPermissionBanner";
import type { TimelineBlockCategory } from "../../shared/types";

export function TodayPage() {
  const isReady = useAppStore((s) => s.isReady);
  const appStatus = useAppStore((s) => s.appStatus);
  const todayPageData = useAppStore((s) => s.todayPageData);
  const todayPageLoading = useAppStore((s) => s.todayPageLoading);
  const todayPageError = useAppStore((s) => s.todayPageError);
  const todayPageDateKey = useAppStore((s) => s.todayPageDateKey);
  const refreshTodayPageData = useAppStore((s) => s.refreshTodayPageData);
  const rollOverTodayDateKeyIfNeeded = useAppStore(
    (s) => s.rollOverTodayDateKeyIfNeeded
  );
  const workReportSelectionMode = useAppStore((s) => s.workReportSelectionMode);
  const previewModalOpen = useAppStore((s) => s.previewModalOpen);
  const ignoredBlockIds = useAppStore((s) => s.ignoredBlockIds);
  const sidePanelDrawerOpen = useAppStore((s) => s.sidePanelDrawerOpen);
  const setSidePanelDrawerOpen = useAppStore((s) => s.setSidePanelDrawerOpen);
  const setPage = useAppStore((s) => s.setPage);

  const [viewMode, setViewMode] = useState<TimelineViewMode>("segments");
  const [onlyWork, setOnlyWork] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<TimelineBlockCategory | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<MemoryDetailRef | null>(null);

  const handleCategoryFilterChange = (category: TimelineBlockCategory) => {
    setCategoryFilter((current) => (current === category ? null : category));
    setSearchKeyword("");
    if (!isWorkCategory(category)) setOnlyWork(false);
  };

  const handleKeywordSelect = (keyword: string) => {
    setCategoryFilter(null);
    setSearchKeyword(keyword);
  };

  const handleSearchKeywordChange = (keyword: string) => {
    setCategoryFilter(null);
    setSearchKeyword(keyword);
  };

  const handleOpenWindow = (windowId: string) => {
    const activityWindow = todayPageData?.activityOverview.windows.find((item) => item.id === windowId);
    if (!activityWindow || !todayPageData) return;
    const episodeIds = new Set(activityWindow.sourceEpisodeIds);
    const observationIds = new Set(activityWindow.sourceObservationIds);
    const relatedBlock = todayPageData.timelineBlocks
      .map((block) => ({
        block,
        score: (block.sourceSceneIds.some((id) => episodeIds.has(id)) ? 1000 : 0)
          + block.sourceObservationIds.filter((id) => observationIds.has(id)).length,
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.block;
    setSelectedDetail(relatedBlock
      ? { id: relatedBlock.id, type: "timeline" }
      : { id: activityWindow.sourceEpisodeIds[0], type: "scene" });
  };

  // 首次进入或 dateKey 变化时加载（选择模式中不重载，避免清空选区）
  useEffect(() => {
    if (!isReady) return;
    if (workReportSelectionMode) return;
    // 跨日检测：如果 dateKey 已经不是今天，自动滚动到今天（store 内部会触发 load）
    const rolledOver = rollOverTodayDateKeyIfNeeded();
    if (rolledOver) return; // 滚动已触发 load，避免重复
    void refreshTodayPageData();
    // 故意只依赖 isReady + todayPageDateKey：
    // workReportSelectionMode 上面只作为 early-return 的守卫，若列入依赖，
    // 退出选择模式的那一刻就会重跑 load 并清空用户刚选好的条目。
    // 其余依赖是 zustand action，引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, todayPageDateKey]);

  // 跨日兜底 + 当天数据刷新：window focus 时
  // - 先检查跨日（rollOver 内部会触发 load）
  // - 未跨日则主动刷新当前 dateKey 数据（main 端 10 分钟定时器可能已写入新 timeline_blocks）
  useEffect(() => {
    const handleFocus = () => {
      if (!isReady) return;
      if (workReportSelectionMode) return;
      const rolledOver = rollOverTodayDateKeyIfNeeded();
      if (!rolledOver) {
        void refreshTodayPageData();
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isReady, workReportSelectionMode, rollOverTodayDateKeyIfNeeded, refreshTodayPageData]);

  // 定时刷新：每 10 分钟刷新当前 dateKey 数据
  // - 与 main 端 TimelineBuilder 调度周期对齐，新落盘的 blocks 能及时显示
  // - 同时做跨日兜底检查
  useEffect(() => {
    if (!isReady) return;
    const timer = setInterval(() => {
      if (workReportSelectionMode) return;
      const rolledOver = rollOverTodayDateKeyIfNeeded();
      if (!rolledOver) {
        void refreshTodayPageData();
      }
    }, 10 * 60 * 1000);
    return () => clearInterval(timer);
  }, [isReady, workReportSelectionMode, rollOverTodayDateKeyIfNeeded, refreshTodayPageData]);

  const handleStartObserving = async () => {
    try {
      await getIpc().app.startObserving();
    } catch (err) {
      console.error("启动观察失败:", err);
    }
  };

  const handleGoSettings = () => setPage("settings");
  const handleRetry = () => void refreshTodayPageData();

  if (selectedDetail) {
    return (
      <MemoryDetailPage
        detailRef={selectedDetail}
        backLabel="返回今日时间轴"
        onBack={() => setSelectedDetail(null)}
        onOpenRelation={(relation) => setSelectedDetail(relation)}
      />
    );
  }

  // ---- 全页空状态 / 错误状态 ----

  if (!isReady) {
    return (
      <div className="today-page today-page--centered">
        <p className="today-page__booting">正在加载 Recall...</p>
      </div>
    );
  }

  // 模型错误（spec 13.1）
  if (appStatus.lastError || appStatus.pipelineState === "error") {
    return (
      <div className="today-page today-page--centered">
        <ErrorState
          title="模型连接失败"
          description="请检查 endpoint、model 和 API Key。"
          primaryAction={{ label: "重试", onClick: handleRetry }}
          secondaryAction={{ label: "去设置", onClick: handleGoSettings }}
        />
      </div>
    );
  }

  // 暂停中（spec 11.3）
  if (appStatus.paused) {
    return (
      <div className="today-page today-page--centered">
        <EmptyState
          title="Recall 已暂停"
          description="暂停期间不会采集窗口，也不会调用模型。"
          primaryAction={{ label: "恢复观察", onClick: handleStartObserving }}
        />
      </div>
    );
  }

  // 首次未开始观察（spec 11.1）
  if (!appStatus.observing) {
    return (
      <div className="today-page today-page--centered">
        <EmptyState
          title="今天还没有记录"
          description="开启观察后，Recall 会把你的电脑工作整理成时间轴、待收尾和日报素材。"
          primaryAction={{ label: "开始观察", onClick: handleStartObserving }}
          secondaryAction={{ label: "选择模型服务", onClick: handleGoSettings }}
        />
      </div>
    );
  }

  // ---- 完整三栏布局 ----

  // macOS 权限未授予时显示引导横幅（不阻断布局，但醒目提示）
  const macPermBanner =
    appStatus.macPermissions && appStatus.macPermissions.permissionsChecked ? (
      <MacPermissionBanner macPermissions={appStatus.macPermissions} />
    ) : null;

  return (
    <>
      {macPermBanner}
      <TodayPageLayout
        todayPageData={todayPageData}
        todayPageLoading={todayPageLoading}
        todayPageError={todayPageError}
        todayPageDateKey={todayPageDateKey}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onlyWork={onlyWork}
        onOnlyWorkChange={setOnlyWork}
        searchKeyword={searchKeyword}
        onSearchKeywordChange={handleSearchKeywordChange}
        categoryFilter={categoryFilter}
        onCategoryFilterChange={handleCategoryFilterChange}
        onKeywordSelect={handleKeywordSelect}
        ignoredBlockIds={ignoredBlockIds}
        workReportSelectionMode={workReportSelectionMode}
        previewModalOpen={previewModalOpen}
        sidePanelDrawerOpen={sidePanelDrawerOpen}
        onToggleDrawer={() => setSidePanelDrawerOpen(!sidePanelDrawerOpen)}
        onRetry={handleRetry}
        onGoSettings={handleGoSettings}
        onOpenDetail={(id) => setSelectedDetail({ id, type: "timeline" })}
        onOpenWindow={handleOpenWindow}
      />
    </>
  );
}

// ============================================================================
// 三栏布局
// ============================================================================

interface TodayPageLayoutProps {
  todayPageData: ReturnType<typeof useAppStore.getState>["todayPageData"];
  todayPageLoading: boolean;
  todayPageError: string | null;
  todayPageDateKey: string;
  viewMode: TimelineViewMode;
  onViewModeChange: (m: TimelineViewMode) => void;
  onlyWork: boolean;
  onOnlyWorkChange: (v: boolean) => void;
  searchKeyword: string;
  onSearchKeywordChange: (v: string) => void;
  categoryFilter: TimelineBlockCategory | null;
  onCategoryFilterChange: (category: TimelineBlockCategory) => void;
  onKeywordSelect: (keyword: string) => void;
  ignoredBlockIds: string[];
  workReportSelectionMode: boolean;
  previewModalOpen: boolean;
  sidePanelDrawerOpen: boolean;
  onToggleDrawer: () => void;
  onRetry: () => void;
  onGoSettings: () => void;
  onOpenDetail: (id: string) => void;
  onOpenWindow: (windowId: string) => void;
}

function TodayPageLayout(props: TodayPageLayoutProps) {
  const {
    todayPageData,
    todayPageLoading,
    todayPageError,
    todayPageDateKey,
    viewMode,
    onViewModeChange,
    onlyWork,
    onOnlyWorkChange,
    searchKeyword,
    onSearchKeywordChange,
    categoryFilter,
    onCategoryFilterChange,
    onKeywordSelect,
    ignoredBlockIds,
    workReportSelectionMode,
    previewModalOpen,
    sidePanelDrawerOpen,
    onToggleDrawer,
    onRetry,
    onGoSettings,
    onOpenDetail,
    onOpenWindow,
  } = props;

  // 过滤时间轴：忽略列表 + 仅看工作 + 搜索，并按开始时间倒序（最近发生的事先看到）
  const filteredBlocks = useMemo(() => {
    if (!todayPageData) return [];
    const ignored = new Set(ignoredBlockIds);
    const kw = searchKeyword.trim().toLowerCase();
    const categoryObservationIds = new Set(
      categoryFilter
        ? todayPageData.activityOverview.windows
            .filter((window) => window.category === categoryFilter)
            .flatMap((window) => window.sourceObservationIds)
        : []
    );
    const keywordObservationIds = new Set(
      kw
        ? todayPageData.activityOverview.windows
            .filter((window) => `${window.title} ${window.summary} ${window.projectNames.join(" ")} ${window.topicTexts.join(" ")}`
              .toLowerCase()
              .includes(kw))
            .flatMap((window) => window.sourceObservationIds)
        : []
    );
    return todayPageData.timelineBlocks
      .filter((b) => {
        if (ignored.has(b.id)) return false;
        if (categoryFilter && !b.sourceObservationIds.some((id) => categoryObservationIds.has(id))) {
          return false;
        }
        if (onlyWork && !isWorkCategory(b.category)) return false;
        if (kw) {
          const hay = `${b.title} ${b.summary} ${b.projectNames.join(" ")} ${b.highlights.join(" ")}`.toLowerCase();
          const relatedEpisodeMatches = b.sourceObservationIds.some((id) => keywordObservationIds.has(id));
          if (!hay.includes(kw) && !relatedEpisodeMatches) return false;
        }
        return true;
      })
      .sort((a, b) => b.startAt.localeCompare(a.startAt));
  }, [todayPageData, ignoredBlockIds, categoryFilter, onlyWork, searchKeyword]);

  const dayMainThread = todayPageData?.dayMainThread ?? "还没有整理出这一天的主线。";
  const dateLabel = friendlyDateLabel(todayPageDateKey);
  const isHistorical = todayPageDateKey !== todayDateKey();

  const showSkeleton = todayPageLoading && !todayPageData;
  const showError = !todayPageLoading && todayPageError && !todayPageData;

  return (
    <div
      className={`today-page${sidePanelDrawerOpen ? " is-drawer-open" : ""}${
        workReportSelectionMode ? " is-select-mode" : ""
      }`}
    >
      <main className="timeline-main" aria-label="今日时间轴">
        <TimelineHeader dayMainThread={dayMainThread} dateLabel={dateLabel} historical={isHistorical} />

        {todayPageData && (
          <TodayVisualizationBand
            overview={todayPageData.activityOverview}
            historical={isHistorical}
            activeCategory={categoryFilter}
            onCategorySelect={onCategoryFilterChange}
            onKeywordSelect={onKeywordSelect}
            onOpenWindow={onOpenWindow}
          />
        )}

        <TimelineToolbar
          dateKey={todayPageDateKey}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          onlyWork={onlyWork}
          onOnlyWorkChange={onOnlyWorkChange}
          searchKeyword={searchKeyword}
          onSearchKeywordChange={onSearchKeywordChange}
        />

        {/* 日期不是今天时的轻提示 */}
        {todayPageDateKey !== todayDateKey() && (
          <div className="timeline-hint">
            正在查看 {dateLabel} 的记录。
          </div>
        )}

        {showError ? (
          <ErrorState
            title="加载记录失败"
            description={todayPageError ?? ""}
            primaryAction={{ label: "重试", onClick: onRetry }}
            secondaryAction={{ label: "去设置", onClick: onGoSettings }}
          />
        ) : (
          <TimelineList
            blocks={filteredBlocks}
            loading={showSkeleton}
            organizing={todayPageLoading && !!todayPageData && filteredBlocks.length === 0}
            viewMode={viewMode}
            onOpenDetail={(block) => onOpenDetail(block.id)}
          />
        )}

        {/* 选择模式入口提示（非选择模式且无可入日报片段） */}
        {!workReportSelectionMode &&
          todayPageData &&
          todayPageData.timelineBlocks.filter(
            (b) => b.reportable && b.privateRisk !== "high"
          ).length === 0 &&
          todayPageData.timelineBlocks.length > 0 && (
            <div className="timeline-hint timeline-hint--warn">
              {isHistorical ? "这一天" : "今天"}还没有适合写进工作日报的片段。你也可以手动选择时间轴中的工作内容。
            </div>
          )}
      </main>

      {/* 右侧面板：drawer 切换按钮 */}
      <button
        type="button"
        className="side-drawer-toggle"
        onClick={onToggleDrawer}
        aria-label={sidePanelDrawerOpen ? "收起结果面板" : "展开结果面板"}
        title={sidePanelDrawerOpen ? "收起结果面板" : "展开结果面板"}
      >
        <PanelRight size={16} />
        <span>{sidePanelDrawerOpen ? "收起" : "展开"}</span>
      </button>

      {/* 右侧面板遮罩（drawer 模式） */}
      {sidePanelDrawerOpen && (
        <div
          className="side-drawer-mask"
          onClick={onToggleDrawer}
          aria-hidden="true"
        />
      )}

      {/* 右侧面板内容 */}
      {todayPageData ? (
        workReportSelectionMode ? (
          <div className={`today-side-panel-wrap${sidePanelDrawerOpen ? " is-open" : ""}`}>
            <WorkReportSelectionPanel data={todayPageData} />
          </div>
        ) : (
          <div className={`today-side-panel-wrap${sidePanelDrawerOpen ? " is-open" : ""}`}>
            <TodaySidePanel data={todayPageData} />
          </div>
        )
      ) : (
        <div className={`today-side-panel-wrap${sidePanelDrawerOpen ? " is-open" : ""}`}>
          <aside className="today-side-panel today-side-panel--loading">
            <div className="side-section">
              <h2 className="side-section__title">今日主线</h2>
              <div className="skeleton" style={{ width: "80%", height: 14 }} />
              <div style={{ height: 6 }} />
              <div className="skeleton" style={{ width: "60%", height: 14 }} />
            </div>
          </aside>
        </div>
      )}

      {/* 预览弹层 */}
      {previewModalOpen && todayPageData && (
        <WorkReportPreviewModal data={todayPageData} />
      )}

      {/* 重新加载浮动按钮（任何时候都允许手动刷新，及时拉取 main 端新落盘的 blocks） */}
      {todayPageData && (
        <button
          type="button"
          className="today-retry-fab"
          onClick={onRetry}
          title="刷新今日页"
          aria-label="刷新今日页"
        >
          <RefreshCw size={16} />
        </button>
      )}
    </div>
  );
}
