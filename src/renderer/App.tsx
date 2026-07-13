// src/renderer/App.tsx
// 应用根组件
//
// 职责：
// - 启动时通过 IPC 拉取 AppStatus
// - 订阅 app:statusChanged 推送
// - 加载应用设置，检测首次启动
// - 首次启动（onboardingCompleted=false）显示 Onboarding 组件
// - 已完成引导则渲染 AppShell + 当前页面

import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { Onboarding } from "./components/Onboarding";
import { TodayPage } from "./pages/TodayPage";
import { RemindersPage } from "./pages/RemindersPage";
import { TasksPage } from "./pages/TasksPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ReportsPage } from "./pages/ReportsPage";
import { MemorySearchPage } from "./pages/MemorySearchPage";
import { PeoplePage } from "./pages/PeoplePage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrustCenterPage } from "./pages/TrustCenterPage";
import { DebugPage } from "./pages/DebugPage";
import { useAppStore, type AppSettingsState } from "./state/store";
import { getIpc } from "./state/ipc";

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage);
  const setAppStatus = useAppStore((s) => s.setAppStatus);
  const setReady = useAppStore((s) => s.setReady);
  const setError = useAppStore((s) => s.setError);
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootState, setBootState] = useState<"loading" | "ready" | "onboarding">("loading");

  useEffect(() => {
    const ipc = getIpc();
    const unsub = ipc.app.onNavigate((page) => {
      if (page === "today") useAppStore.getState().setPage("today");
    });
    return unsub;
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let cancelled = false;

    async function boot() {
      try {
        const ipc = getIpc();
        // 拉取初始状态
        const status = await ipc.app.getStatus();
        if (cancelled) return;
        setAppStatus(status);

        // 加载应用设置（含 onboardingCompleted）到 store
        await loadSettings();
        if (cancelled) return;

        setReady(true);
        // 直接通过 IPC 获取最新设置，避免 store 闭包陈旧导致启动闪烁
        try {
          const currentSettings = await ipc.settings.get<AppSettingsState>();
          if (cancelled) return;
          if (currentSettings && !currentSettings.onboardingCompleted) {
            setBootState("onboarding");
          } else {
            setBootState("ready");
          }
        } catch {
          // 设置加载失败时回退到主界面，避免阻塞启动
          setBootState("ready");
        }

        // 订阅状态变化
        unsub = ipc.app.onStatusChanged((next) => {
          setAppStatus(next);
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setBootError(message);
        setError(message);
      }
    }

    void boot();

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 引导完成回调：切换到主界面
   * 同时重新加载设置确保状态同步
   */
  const handleOnboardingComplete = () => {
    void loadSettings();
    setBootState("ready");
  };

  if (bootError) {
    return (
      <div className="boot-error">
        <h1>启动失败</h1>
        <p>{bootError}</p>
        <p>请重启应用，或检查 main 进程日志。</p>
        <style>{`
          .boot-error {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 24px;
            background-color: var(--recall-bg);
          }
          .boot-error h1 {
            font-size: 20px;
            margin: 0 0 12px 0;
            color: var(--recall-danger);
          }
          .boot-error p {
            font-size: 13px;
            margin: 0 0 8px 0;
            color: var(--recall-text-muted);
            line-height: 1.6;
            text-align: center;
          }
        `}</style>
      </div>
    );
  }

  if (bootState === "loading") {
    return (
      <div className="boot-loading">
        <p>正在加载 Recall...</p>
        <style>{`
          .boot-loading {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background-color: var(--recall-bg);
          }
          .boot-loading p {
            font-size: 14px;
            color: var(--recall-text-muted);
          }
        `}</style>
      </div>
    );
  }

  if (bootState === "onboarding" || (settings && !settings.onboardingCompleted)) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  return (
    <AppShell>
      {renderPage(currentPage)}
    </AppShell>
  );
}

function renderPage(page: string) {
  switch (page) {
    case "today":
      return <TodayPage />;
    case "reminders":
      return <RemindersPage />;
    case "tasks":
      return <TasksPage />;
    case "projects":
      return <ProjectsPage />;
    case "reports":
      return <ReportsPage />;
    case "memory":
      return <MemorySearchPage />;
    case "people":
      return <PeoplePage />;
    case "settings":
      return <SettingsPage />;
    case "trust":
      return <TrustCenterPage />;
    case "debug":
      return <DebugPage />;
    default:
      return <TodayPage />;
  }
}
