// src/renderer/pages/today/TimelineToolbar.tsx
// 今日页工具栏（spec 行 1405-1416）
//
// 内容：
// - 日期选择：今天 / 前一天 / 后一天
// - 视图切换：片段 / 细节
// - 生成工作日报 / 我的复盘 / 仅看工作
// - 搜索今天
//
// 选择模式时，本组件切换为选择模式提示与操作组（spec 9.2）

import { ChevronLeft, ChevronRight, RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../state/store";
import {
  isToday,
  shiftDateKey,
  friendlyDateLabel,
  todayDateKey,
} from "./helpers";

export type TimelineViewMode = "segments" | "detail";

interface TimelineToolbarProps {
  dateKey: string;
  viewMode: TimelineViewMode;
  onViewModeChange: (mode: TimelineViewMode) => void;
  onlyWork: boolean;
  onOnlyWorkChange: (v: boolean) => void;
  searchKeyword: string;
  onSearchKeywordChange: (v: string) => void;
}

export function TimelineToolbar({
  dateKey,
  viewMode,
  onViewModeChange,
  onlyWork,
  onOnlyWorkChange,
  searchKeyword,
  onSearchKeywordChange,
}: TimelineToolbarProps) {
  const selectionMode = useAppStore((s) => s.workReportSelectionMode);
  const selectedBlockIds = useAppStore((s) => s.selectedBlockIds);
  const todayPageData = useAppStore((s) => s.todayPageData);
  const setWorkReportSelectionMode = useAppStore((s) => s.setWorkReportSelectionMode);
  const selectAllWorkBlocks = useAppStore((s) => s.selectAllWorkBlocks);
  const clearSelection = useAppStore((s) => s.clearSelection);
  const setPreviewModalOpen = useAppStore((s) => s.setPreviewModalOpen);
  const workReportGenerating = useAppStore((s) => s.workReportGenerating);
  const onDateChange = useAppStore((s) => s.setTodayPageDateKey);
  const personalReview = useAppStore((s) => s.todayPageData?.personalReview);
  const generatePersonalReview = useAppStore((s) => s.generatePersonalReview);
  const personalReviewGenerating = useAppStore((s) => s.personalReviewGenerating);
  const setPage = useAppStore((s) => s.setPage);
  const setReportsTab = useAppStore((s) => s.setReportsTab);
  const todayPageDateKey = useAppStore((s) => s.todayPageDateKey);
  const reorganizeTimelineDay = useAppStore((s) => s.reorganizeTimelineDay);
  const timelineBuildingDateKey = useAppStore((s) => s.timelineBuildingDateKey);

  const [searchFocused, setSearchFocused] = useState(false);

  // tablist 键盘导航（WAI-ARIA：方向键移动焦点并激活，Home/End 跳首尾）
  const handleViewTabsKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    );
    if (tabs.length === 0) return;
    const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = -1;
    if (event.key === "ArrowRight") {
      nextIndex = currentIndex >= 0 ? (currentIndex + 1) % tabs.length : 0;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        currentIndex >= 0 ? (currentIndex - 1 + tabs.length) % tabs.length : 0;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    tabs[nextIndex].focus();
    tabs[nextIndex].click();
  };

  const handleDateShift = (delta: number) => {
    const next = shiftDateKey(dateKey, delta);
    onDateChange(next);
  };

  const handleGoToday = () => {
    onDateChange(todayDateKey());
  };

  const handlePersonalReview = () => {
    if (personalReview) {
      setPage("reports");
      setReportsTab("personal");
    } else {
      void generatePersonalReview(todayPageDateKey);
    }
  };

  // 选择模式工具栏（spec 9.2）
  if (selectionMode) {
    const selectedCount = selectedBlockIds.length;
    const handleGenerate = () => {
      if (selectedCount === 0) return;
      setPreviewModalOpen(true);
    };
    return (
      <div className="timeline-toolbar timeline-toolbar--select">
        <div className="timeline-toolbar__select-hint">
          <strong>选择要写进工作日报的片段</strong>
          <span>未选择的内容不会进入本次日报生成。</span>
        </div>
        <div className="timeline-toolbar__select-actions">
          <button
            type="button"
            className="tb-btn"
            onClick={() => setWorkReportSelectionMode(false)}
          >
            取消
          </button>
          <button type="button" className="tb-btn" onClick={selectAllWorkBlocks}>
            仅选工作相关
          </button>
          <button type="button" className="tb-btn" onClick={clearSelection}>
            清空
          </button>
          <button
            type="button"
            className="tb-btn tb-btn--primary"
            onClick={handleGenerate}
            disabled={selectedCount === 0 || workReportGenerating}
          >
            生成日报（{selectedCount}）
          </button>
        </div>
      </div>
    );
  };

  // 日报生成失败提示由 TodayPage 顶层渲染，这里不重复

  const reportableCount = todayPageData
    ? todayPageData.timelineBlocks.filter(
        (b) => b.reportable && b.privateRisk !== "high"
      ).length
    : 0;

  return (
    <div className="timeline-toolbar">
      <div className="timeline-toolbar__left">
        <div className="date-nav">
          <button
            type="button"
            className="tb-icon-btn"
            onClick={() => handleDateShift(-1)}
            aria-label="前一天"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="date-nav__current"
            onClick={handleGoToday}
            disabled={isToday(dateKey)}
            title={isToday(dateKey) ? "今天" : "回到今天"}
          >
            {friendlyDateLabel(dateKey)}
          </button>
          <button
            type="button"
            className="tb-icon-btn"
            onClick={() => handleDateShift(1)}
            aria-label="后一天"
            disabled={isToday(dateKey)}
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div
          className="seg-control"
          role="tablist"
          aria-label="视图切换"
          onKeyDown={handleViewTabsKeyDown}
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "segments"}
            aria-controls="timeline-view-panel"
            tabIndex={viewMode === "segments" ? 0 : -1}
            className={`seg-control__btn${viewMode === "segments" ? " is-active" : ""}`}
            onClick={() => onViewModeChange("segments")}
          >
            片段
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "detail"}
            aria-controls="timeline-view-panel"
            tabIndex={viewMode === "detail" ? 0 : -1}
            className={`seg-control__btn${viewMode === "detail" ? " is-active" : ""}`}
            onClick={() => onViewModeChange("detail")}
          >
            细节
          </button>
        </div>
      </div>

      <div className="timeline-toolbar__right">
        <button type="button" className="tb-icon-btn" onClick={() => void reorganizeTimelineDay(dateKey)}
          disabled={timelineBuildingDateKey === dateKey} title="重整当天时间轴" aria-label="重整当天时间轴">
          <RefreshCw size={15} />
        </button>
        <label className={`search-today${searchFocused ? " is-focused" : ""}`}>
          <Search size={14} />
          <input
            type="search"
            placeholder="搜索记录"
            value={searchKeyword}
            onChange={(e) => onSearchKeywordChange(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            aria-label="搜索记录"
          />
        </label>

        <button
          type="button"
          className={`tb-btn${onlyWork ? " is-active" : ""}`}
          onClick={() => onOnlyWorkChange(!onlyWork)}
          title="只显示工作相关片段"
        >
          仅看工作
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={() => setWorkReportSelectionMode(true)}
          disabled={reportableCount === 0}
          title={
            reportableCount === 0
              ? `${isToday(dateKey) ? "今天" : "这一天"}还没有可写入日报的工作片段`
              : `选择片段生成日报（${reportableCount} 个可写入）`
          }
        >
          生成工作日报
        </button>

        <button
          type="button"
          className="tb-btn"
          onClick={handlePersonalReview}
          disabled={personalReviewGenerating}
          title={
            personalReview
              ? `查看${isToday(dateKey) ? "今天" : "这一天"}的个人复盘`
              : `生成${isToday(dateKey) ? "今天" : "这一天"}的个人复盘`
          }
        >
          {personalReviewGenerating
            ? "正在生成..."
            : personalReview
            ? "查看复盘"
            : "我的复盘"}
        </button>
      </div>
    </div>
  );
}
