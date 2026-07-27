// src/renderer/components/AppShell.tsx
// 应用主框架（统一 Sidebar + MainContent 结构）
//
// 布局规范（已基于新 Logo 蓝紫渐变视觉、呼吸间距与精致导航栏进行了重构）：
// - 左侧窄导航栏：仅图标 + Logo，通过分组与优雅的间距解决过密问题，改善选中态指示器
// - 顶部状态栏（48px）：StatusPill + 暂停/恢复按钮
// - 主内容区：根据当前路由渲染对应页面

import { type ReactNode, type ComponentType, type PointerEvent as ReactPointerEvent } from "react";
import {
  CalendarDays,
  ListTodo,
  FileText,
  FolderKanban,
  Search,
  Users,
  Settings,
  Bug,
  Minus,
  Square,
  X,
  Bell,
} from "lucide-react";
import { useAppStore, type PageKey } from "../state/store";
import { StatusPill } from "./StatusPill";
import { UpdateBadge } from "./UpdateBadge";
import { getIpc } from "../state/ipc";

interface NavItem {
  key: PageKey;
  label: string;
  Icon: ComponentType<{ size?: string | number; className?: string }>;
}

/**
 * 主导航项（核心功能组：今日 / 待收尾 / 项目 / 人物 / 记忆库 / 报告）
 */
const CORE_NAV_ITEMS: NavItem[] = [
  { key: "today", label: "今日", Icon: CalendarDays },
  { key: "tasks", label: "待收尾", Icon: ListTodo },
  { key: "projects", label: "项目", Icon: FolderKanban },
  { key: "people", label: "人物", Icon: Users },
  { key: "memory", label: "记忆库", Icon: Search },
  { key: "reports", label: "报告", Icon: FileText },
];

/**
 * 工具辅助组（底部：设置）
 */
const UTILITY_NAV_ITEMS: NavItem[] = [
  { key: "settings", label: "设置", Icon: Settings },
];

const DEBUG_NAV_ITEM: NavItem = { key: "debug", label: "调试", Icon: Bug };

interface AppShellProps {
  children: ReactNode;
}

export const AppShell = ({ children }: AppShellProps) => {
  const currentPage = useAppStore((s) => s.currentPage);
  const setPage = useAppStore((s) => s.setPage);
  const unreadReportCount = useAppStore((s) => s.unreadReports.length);
  const markUnreadReportsRead = useAppStore((s) => s.markUnreadReportsRead);
  const appStatus = useAppStore((s) => s.appStatus);
  const isDebugEnabled = useAppStore((s) => s.settings?.debug?.enabled ?? false);

  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog);
  const confirmDialogTitle = useAppStore((s) => s.confirmDialogTitle);
  const confirmDialogMessage = useAppStore((s) => s.confirmDialogMessage);
  const confirmDialogConfirmText = useAppStore((s) => s.confirmDialogConfirmText);
  const closeConfirmDialog = useAppStore((s) => s.closeConfirmDialog);
  const executeConfirm = useAppStore((s) => s.executeConfirm);

  const isObserving = appStatus.observing && !appStatus.paused;

  // 动态合并工具辅助组（包含调试项）
  const utilityItems = isDebugEnabled
    ? [...UTILITY_NAV_ITEMS, DEBUG_NAV_ITEM]
    : UTILITY_NAV_ITEMS;

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

  const handleWindowAction = async (action: "minimize" | "toggleMaximize" | "close") => {
    try {
      await getIpc().window[action]();
    } catch (err) {
      console.error("窗口操作失败:", err);
    }
  };

  const sendWindowDrag = (phase: "start" | "move" | "end", event: ReactPointerEvent<HTMLElement>) => {
    void getIpc().window.drag({ phase, screenX: event.screenX, screenY: event.screenY })
      .catch((err) => console.error("窗口拖动失败:", err));
  };

  const handleWindowDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("button, a, input")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    sendWindowDrag("start", event);
  };

  const handleWindowDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if ((event.buttons & 1) === 0) {
      sendWindowDrag("end", event);
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    sendWindowDrag("move", event);
  };

  const handleWindowDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    sendWindowDrag("end", event);
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const windowDragProps = {
    onPointerDown: handleWindowDragStart,
    onPointerMove: handleWindowDragMove,
    onPointerUp: handleWindowDragEnd,
    onPointerCancel: handleWindowDragEnd,
  };

  const handleOpenUnreadReports = () => {
    setPage("reports");
    markUnreadReportsRead();
  };

  const renderNavButton = ({ key, label, Icon }: NavItem) => (
    <button
      key={key}
      type="button"
      className={`app-shell__nav-item${currentPage === key ? " is-active" : ""}`}
      onClick={() => setPage(key)}
      title={label}
      aria-label={label}
      aria-current={currentPage === key ? "page" : undefined}
    >
      <Icon size={18} className="app-shell__nav-icon" />
      <span className="app-shell__nav-label">{label}</span>
    </button>
  );

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand" {...windowDragProps}>
          <BrandMark />
          <span className="app-shell__brand-name">回声 Recall</span>
        </div>

        {/* 精致化分组导航 */}
        <div className="sidebar-nav-container">
          {/* 核心功能组 */}
          <nav className="sidebar-nav-group-main">
            {CORE_NAV_ITEMS.map(renderNavButton)}
          </nav>

          {/* 工具辅助组 (自动推到底部，带优雅分隔线) */}
          <nav className="sidebar-nav-group-utils">
            {utilityItems.map(renderNavButton)}
          </nav>
        </div>
      </aside>

      <main className="app-shell__main">
        <header className="app-shell__topbar" {...windowDragProps}>
          <StatusPill
            onClick={handlePauseToggle}
            actionLabel={isObserving ? "暂停观察" : "开始观察"}
          />
          <div className="app-shell__topbar-actions">
            {unreadReportCount > 0 && (
              <button
                type="button"
                className="app-shell__report-notice"
                onClick={handleOpenUnreadReports}
                aria-live="polite"
                title="打开报告页"
              >
                <Bell size={15} aria-hidden="true" />
                <span>
                  有新的未读报告
                  {unreadReportCount > 1 ? `（${unreadReportCount}）` : ""}
                </span>
              </button>
            )}
            <UpdateBadge />
            <div className="window-controls" aria-label="窗口控制">
              <button
                type="button"
                className="window-control"
                onClick={() => void handleWindowAction("minimize")}
                aria-label="最小化"
                title="最小化"
              >
                <Minus size={16} />
              </button>
              <button
                type="button"
                className="window-control"
                onClick={() => void handleWindowAction("toggleMaximize")}
                aria-label="最大化或还原"
                title="最大化或还原"
              >
                <Square size={13} />
              </button>
              <button
                type="button"
                className="window-control window-control--close"
                onClick={() => void handleWindowAction("close")}
                aria-label="关闭"
                title="关闭到托盘"
              >
                <X size={17} />
              </button>
            </div>
          </div>
        </header>
        <div className="app-shell__content">{children}</div>
      </main>

      {/* 全局二次确认对话框 */}
      {showConfirmDialog && (
        <div
          className="confirm-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
          onClick={closeConfirmDialog}
        >
          <div className="confirm-dialog__box" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-dialog-title" className="confirm-dialog__title">
              {confirmDialogTitle}
            </h3>
            <p className="confirm-dialog__message">{confirmDialogMessage}</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeConfirmDialog}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={executeConfirm}
              >
                {confirmDialogConfirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * 品牌 Logo 标识
 *
 * 整合新 Logo 设计：
 * - 采用层层递进、圆润优雅的波形与底部的凝聚力圆点设计
 * - 使用蓝紫渐变色展现「回声/共鸣/凝聚」的精神
 */
const BrandMark = () => (
  <svg
    className="app-shell__brand-mark"
    viewBox="0 0 100 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    style={{ width: "36px", height: "36px" }}
  >
    <defs>
      <linearGradient id="logo-ink-green" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stopColor="var(--recall-accent-soft-strong)" />
        <stop offset="55%" stopColor="var(--recall-accent)" />
        <stop offset="100%" stopColor="var(--recall-accent-hover)" />
      </linearGradient>
    </defs>

    {/* Concentric waves / loops echoing upwards */}
    <ellipse cx="50" cy="20" rx="40" ry="10" stroke="url(#logo-ink-green)" strokeWidth="3" strokeOpacity="0.35" />
    <ellipse cx="50" cy="38" rx="34" ry="8.5" stroke="url(#logo-ink-green)" strokeWidth="3.5" strokeOpacity="0.55" />
    <ellipse cx="50" cy="54" rx="27" ry="7" stroke="url(#logo-ink-green)" strokeWidth="4" strokeOpacity="0.75" />
    <ellipse cx="50" cy="68" rx="20" ry="5" stroke="url(#logo-ink-green)" strokeWidth="4.5" />

    {/* Solid center dot representing core memory/focus */}
    <circle cx="50" cy="84" r="10" fill="var(--recall-accent)" />
  </svg>
);
