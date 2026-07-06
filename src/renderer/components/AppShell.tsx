// src/renderer/components/AppShell.tsx
// 应用主框架（来自 08_UI_UX_BRAND_SPEC.md "App Shell 布局" 章节）
//
// 布局规范（来自 08 文档）：
// - 左侧窄导航栏：8 个导航项 + Logo
// - 顶部状态栏：StatusPill + 当前活动 app + 今日已整理数量 + 暂停/恢复按钮
// - 主内容区：根据当前路由渲染对应页面
// - 右侧可选上下文栏：用于提醒栏或来源信息（M5+ 用于提醒，今日页内嵌）
//
// 品牌约束：
// - 不使用眼睛/摄像头/大脑 logo
// - Logo 概念：回环线 + 3 节点
// - 中文 "回声" + 英文 "Recall"

import { type ReactNode, useMemo } from "react";
import { useAppStore, type PageKey } from "../state/store";
import { StatusPill } from "./StatusPill";
import { getIpc } from "../state/ipc";

interface NavItem {
  key: PageKey;
  label: string;
}

/**
 * 8 个页面路由（来自 08 文档）
 * 今日 / 提醒 / 任务 / 项目 / 报告 / 记忆库 / 设置 / 信任中心
 */
const NAV_ITEMS: NavItem[] = [
  { key: "today", label: "今日" },
  { key: "reminders", label: "提醒" },
  { key: "tasks", label: "任务" },
  { key: "projects", label: "项目" },
  { key: "reports", label: "报告" },
  { key: "memory", label: "记忆库" },
  { key: "settings", label: "设置" },
  { key: "trust", label: "信任中心" },
];

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const currentPage = useAppStore((s) => s.currentPage);
  const setPage = useAppStore((s) => s.setPage);
  const appStatus = useAppStore((s) => s.appStatus);
  const todayData = useAppStore((s) => s.todayData);

  const handlePauseToggle = async () => {
    try {
      const ipc = getIpc();
      if (appStatus.paused || !appStatus.observing) {
        await ipc.app.startObserving();
      } else {
        await ipc.app.pauseObserving();
      }
    } catch (err) {
      console.error("切换观察状态失败:", err);
    }
  };

  const isObserving = appStatus.observing && !appStatus.paused;

  // 今日已整理数量（observations + facts + scenes + tasks + decisions）
  const todayOrganizedCount = useMemo(() => {
    return (
      todayData.observations.length +
      todayData.facts.length +
      todayData.scenes.length +
      todayData.tasks.length +
      todayData.decisions.length
    );
  }, [todayData]);

  const currentApp = appStatus.currentWindow?.appName;
  const currentWindowTitle = appStatus.currentWindow?.windowTitle;

  return (
    <div className="app-shell">
      <aside className="app-shell__nav">
        <div className="app-shell__brand">
          <div className="app-shell__brand-logo">
            <BrandMark />
            <div className="app-shell__brand-text">
              <span className="app-shell__brand-zh">回声</span>
              <span className="app-shell__brand-en">Recall</span>
            </div>
          </div>
        </div>
        <nav className="app-shell__nav-list">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              className={
                "app-shell__nav-item" +
                (currentPage === item.key ? " app-shell__nav-item--active" : "")
              }
              onClick={() => setPage(item.key)}
              aria-current={currentPage === item.key ? "page" : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="app-shell__main">
        <header className="app-shell__topbar">
          <div className="app-shell__topbar-left">
            <StatusPill />
            {isObserving && currentApp && (
              <span
                className="app-shell__topbar-app"
                title={currentWindowTitle ?? undefined}
              >
                {currentApp}
              </span>
            )}
          </div>
          <div className="app-shell__topbar-right">
            <div className="app-shell__topbar-meta">
              <span
                className="app-shell__topbar-stat"
                title="今日 Recall 已整理的观察、线索、工作片段、任务和决策数量"
              >
                今日已整理 {todayOrganizedCount}
              </span>
            </div>
            <button
              className={isObserving ? "" : "primary"}
              onClick={handlePauseToggle}
              aria-label={isObserving ? "暂停观察" : "开始观察"}
            >
              {isObserving
                ? "暂停"
                : appStatus.paused
                ? "恢复"
                : "开始观察"}
            </button>
          </div>
        </header>
        <main className="app-shell__content">{children}</main>
      </div>
    </div>
  );
}

/**
 * 品牌 Logo 标识（来自 08 文档"Logo 建议"）
 *
 * 概念：回环线 + 3 节点
 *   3 个节点被一条柔和线连接，形成回声/回路感
 *
 * 重要约束：
 * - 不使用眼睛、摄像头、大脑 logo
 * - 使用 SVG 实现柔和的回环线 + 3 节点
 */
function BrandMark() {
  return (
    <svg
      className="app-shell__brand-mark"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* 柔和回环线：从左下节点出发，经过中间节点，再回到底部右侧节点 */}
      <path
        d="M4 16 Q 8 4, 12 12 Q 16 20, 20 8"
        stroke="var(--accent-green)"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      {/* 3 个节点 */}
      <circle cx="4" cy="16" r="2.2" fill="var(--accent-green)" />
      <circle cx="12" cy="12" r="2.2" fill="var(--accent-amber)" />
      <circle cx="20" cy="8" r="2.2" fill="var(--accent-green)" />
    </svg>
  );
}
