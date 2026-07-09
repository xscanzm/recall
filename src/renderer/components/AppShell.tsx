// src/renderer/components/AppShell.tsx
// 应用主框架（统一 Sidebar + MainContent 结构）
//
// 布局规范（doc 22 第 4 节 + doc 21 第 2.2 节 + doc 24 第 2 节）：
// - 左侧窄导航栏（76px）：仅图标 + Logo，hover tooltip 显示中文名称
// - 当前页图标使用低饱和青绿色背景 var(--recall-accent-soft)
// - 顶部状态栏（48px）：StatusPill + 暂停/恢复按钮
// - 主内容区：根据当前路由渲染对应页面（页面自行管理滚动与右侧面板）
//
// 品牌约束：
// - 不使用眼睛/摄像头/大脑 logo
// - Logo 概念：回环线 + 3 节点

import { type ReactNode, type ComponentType } from "react";
import {
  CalendarDays,
  ListTodo,
  FileText,
  FolderKanban,
  Search,
  Users,
  Settings,
  Pause,
  Play,
  Bug,
} from "lucide-react";
import { useAppStore, type PageKey } from "../state/store";
import { StatusPill } from "./StatusPill";
import { getIpc } from "../state/ipc";
import { Button } from "./Button";

interface NavItem {
  key: PageKey;
  label: string;
  Icon: ComponentType<{ size?: string | number; className?: string }>;
}

/**
 * 主导航项（顺序严格，来自记忆系统重构设计）
 * 今日 / 待收尾 / 项目 / 人物 / 记忆库 / 报告 / 设置
 */
const NAV_ITEMS: NavItem[] = [
  { key: "today", label: "今日", Icon: CalendarDays },
  { key: "tasks", label: "待收尾", Icon: ListTodo },
  { key: "projects", label: "项目", Icon: FolderKanban },
  { key: "people", label: "人物", Icon: Users },
  { key: "memory", label: "记忆库", Icon: Search },
  { key: "reports", label: "报告", Icon: FileText },
  { key: "settings", label: "设置", Icon: Settings },
];

/** 调试导航项（仅当 settings.debug.enabled 时由组件内条件拼接） */
const DEBUG_NAV_ITEM: NavItem = { key: "debug", label: "调试", Icon: Bug };

interface AppShellProps {
  children: ReactNode;
}

export const AppShell = ({ children }: AppShellProps) => {
  const currentPage = useAppStore((s) => s.currentPage);
  const setPage = useAppStore((s) => s.setPage);
  const appStatus = useAppStore((s) => s.appStatus);
  const isDebugEnabled = useAppStore((s) => s.settings?.debug?.enabled ?? false);

  const isObserving = appStatus.observing && !appStatus.paused;
  const navItems = isDebugEnabled ? [...NAV_ITEMS, DEBUG_NAV_ITEM] : NAV_ITEMS;

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

  return (
    <div className="app-shell">
      <aside className="app-shell__sidebar">
        <div className="app-shell__brand">
          <BrandMark />
        </div>
        <nav className="app-shell__nav">
          {navItems.map(({ key, label, Icon }) => (
            <button
              key={key}
              type="button"
              className={`app-shell__nav-item${currentPage === key ? " is-active" : ""}`}
              onClick={() => setPage(key)}
              title={label}
              aria-label={label}
              aria-current={currentPage === key ? "page" : undefined}
            >
              <Icon size={18} />
              <span className="app-shell__nav-label">{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="app-shell__main">
        <header className="app-shell__topbar">
          <StatusPill />
          <div className="app-shell__topbar-actions">
            <Button
              variant={isObserving ? "secondary" : "primary"}
              size="sm"
              onClick={handlePauseToggle}
              aria-label={isObserving ? "暂停观察" : "开始观察"}
            >
              {isObserving ? (
                <>
                  <Pause size={14} style={{ marginRight: 4 }} />
                  暂停观察
                </>
              ) : (
                <>
                  <Play size={14} style={{ marginRight: 4 }} />
                  开始观察
                </>
              )}
            </Button>
          </div>
        </header>
        <div className="app-shell__content">{children}</div>
      </main>
    </div>
  );
};

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
const BrandMark = () => (
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
      stroke="var(--recall-accent)"
      strokeWidth="1.8"
      strokeLinecap="round"
      fill="none"
    />
    {/* 3 个节点 */}
    <circle cx="4" cy="16" r="2.2" fill="var(--recall-accent)" />
    <circle cx="12" cy="12" r="2.2" fill="var(--recall-amber)" />
    <circle cx="20" cy="8" r="2.2" fill="var(--recall-accent)" />
  </svg>
);
