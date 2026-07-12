import React from "react";
import ReactDOM from "react-dom/client";
import {
  demoAppStatus,
  demoDateKey,
  demoDateLabel,
  demoReview,
  demoThreads,
  demoTimeline,
  demoTodayPageData,
  demoWorkReport,
} from "./demoData";
import "../../src/renderer/styles/global.css";
import "./productDemo.css";

const ok = <T,>(data: T) => Promise.resolve({ ok: true as const, data });

const demoFacts = demoTimeline.map((block, index) => ({
  id: block.sourceFactIds[0],
  type: index === 1 ? "decision" : "note",
  content: block.highlights[0] ?? block.summary,
  status: null,
  projectId: "project-recall",
  projectHint: "Recall 公开测试版",
  importance: 0.9,
  confidence: block.confidence ?? 0.9,
  inferred: false,
  evidenceText: block.summary,
  sourceObservationIds: block.sourceObservationIds,
  tags: ["发布准备"],
  createdAt: block.startAt,
  updatedAt: block.endAt,
  deletedAt: null,
}));

const demoProject = {
  id: "project-recall",
  name: "Recall 公开测试版",
  summary: "让电脑前流逝的工作上下文，变成可行动的记忆和提醒。",
  status: "active",
  lastActiveAt: `${demoDateKey}T17:35:00`,
  sourceFactIds: demoFacts.map((item) => item.id),
  sourceSceneIds: demoTimeline.flatMap((item) => item.sourceSceneIds),
  createdAt: `${demoDateKey}T09:00:00`,
  updatedAt: `${demoDateKey}T17:35:00`,
  archivedAt: null,
};

const searchResults = [
  {
    id: "search-decision",
    type: "decision" as const,
    title: "首页从用户的一天出发",
    summary: "不强调自动截图和模型能力，而是先讲清楚一天如何被接住、整理并重新找到。",
    createdAt: `${demoDateKey}T14:45:00`,
    projectName: demoProject.name,
    projectId: demoProject.id,
    sourceType: "fact" as const,
    sourceId: "fact-copy",
  },
  {
    id: "search-scene",
    type: "scene" as const,
    title: "把功能写成用户真正关心的事",
    summary: "确定首屏主张：让认真度过的一天，被好好记住。",
    createdAt: `${demoDateKey}T14:05:00`,
    projectName: demoProject.name,
    projectId: demoProject.id,
    sourceType: "scene" as const,
    sourceId: "scene-copy",
  },
  {
    id: "search-report",
    type: "report" as const,
    title: `${demoDateLabel}复盘`,
    summary: demoReview.overview,
    createdAt: `${demoDateKey}T18:00:00`,
    projectName: demoProject.name,
    projectId: demoProject.id,
    sourceType: "report" as const,
    sourceId: demoReview.id,
  },
];

const demoSettings = {
  observation: {
    enabled: true,
    activeWindowStableSeconds: 8,
    contentChangeMinIntervalSeconds: 20,
    longSessionIntervalMinutes: 10,
    idleThresholdSeconds: 120,
  },
  screenshot: { retentionPolicy: "today" as const },
  notification: {
    inAppReminders: true,
    desktopNotifications: true,
    dailyReportTime: "18:00",
    weeklyReportTime: "17:30",
  },
  dailyReport: { autoGenerate: false, time: "18:00" },
  onboardingCompleted: true,
  debug: { enabled: false, verboseModelIO: false },
};

const recallAPI = {
  app: {
    getStatus: () => Promise.resolve(demoAppStatus),
    onStatusChanged: () => () => undefined,
    startObserving: () => Promise.resolve(demoAppStatus),
    pauseObserving: () => Promise.resolve({ ...demoAppStatus, paused: true }),
  },
  settings: {
    get: () => Promise.resolve(demoSettings),
    update: (patch: object) => Promise.resolve({ settings: { ...demoSettings, ...patch } }),
  },
  timeline: {
    get: () => ok(demoTimeline),
    build: () => Promise.resolve({ ok: true }),
    reorganizeDay: () => Promise.resolve({ ok: true }),
  },
  unfinishedThreads: {
    list: ({ status }: { status?: string }) => ok(status ? demoThreads.filter((item) => item.status === status) : demoThreads),
    updateStatus: () => Promise.resolve({ ok: true }),
  },
  personalReview: {
    get: () => ok(demoReview),
    generate: () => Promise.resolve({ ok: true }),
  },
  workReport: {
    get: () => ok(demoWorkReport),
    generate: () => Promise.resolve({ ok: true }),
    saveSelection: () => Promise.resolve({ ok: true }),
  },
  memory: {
    listToday: () => Promise.resolve({
      observations: [],
      facts: demoFacts,
      scenes: [],
      tasks: [],
      decisions: [],
      people: [],
      projects: [demoProject],
    }),
    search: () => Promise.resolve({ results: searchResults, total: searchResults.length }),
    ask: ({ question }: { question: string }) => Promise.resolve({
      ok: true,
      answer: "你最后决定从用户的一天出发，用“让认真度过的一天，被好好记住”作为首页主张，并避免在宣传素材中使用个人真实数据。",
      sources: searchResults.slice(0, 2),
      searchCount: 3,
      question,
    }),
    createUserFeedback: () => Promise.resolve({ ok: true }),
  },
  reports: {
    list: () => Promise.resolve([]),
    update: () => Promise.resolve({ ok: true }),
    getEvidenceByIds: () => ok({ facts: demoFacts, scenes: [], timelineBlocks: demoTimeline }),
    findLatest: ({ type }: { type: string }) => Promise.resolve(type === "work_daily_report" ? demoWorkReport : demoReview),
  },
};

Object.defineProperty(window, "recallAPI", {
  value: recallAPI,
  configurable: false,
  writable: false,
});

async function mountDemo() {
  const [storeModule, shellModule, todayModule, tasksModule, memoryModule, reportsModule] = await Promise.all([
    import("../../src/renderer/state/store"),
    import("../../src/renderer/components/AppShell"),
    import("../../src/renderer/pages/TodayPage"),
    import("../../src/renderer/pages/TasksPage"),
    import("../../src/renderer/pages/MemorySearchPage"),
    import("../../src/renderer/pages/ReportsPage"),
  ]);

  const { useAppStore } = storeModule;
  const { AppShell } = shellModule;
  const { TodayPage } = todayModule;
  const { TasksPage } = tasksModule;
  const { MemorySearchPage } = memoryModule;
  const { ReportsPage } = reportsModule;

  const requestedPage = new URLSearchParams(window.location.search).get("page");
  const initialPage = requestedPage === "tasks" || requestedPage === "memory" || requestedPage === "reports"
    ? requestedPage
    : "today";

  useAppStore.setState({
    appStatus: demoAppStatus,
    currentPage: initialPage,
    isReady: true,
    settings: demoSettings,
    todayPageData: demoTodayPageData,
    todayPageDateKey: demoDateKey,
    todayPageFollowingToday: false,
    todayData: {
      observations: [],
      facts: demoFacts,
      scenes: [],
      tasks: [],
      decisions: [],
      people: [],
      projects: [demoProject],
    },
    unfinishedThreads: demoThreads,
    personalReview: demoReview,
    workReport: demoWorkReport,
    reportsDateKey: demoDateKey,
    searchQuery: "首页标题",
    searchResults,
    searchSearched: true,
    askQuestion: "上次那个首页标题，最后是怎么定的？",
    askResult: {
      ok: true,
      answer: "你最后决定从用户的一天出发，用“让认真度过的一天，被好好记住”作为首页主张。",
      sources: searchResults.slice(0, 2),
      searchCount: 3,
    },
  });

  function DemoApp() {
    const page = useAppStore((state) => state.currentPage);
    let content: React.ReactNode;
    if (page === "tasks") content = <TasksPage />;
    else if (page === "memory") content = <MemorySearchPage />;
    else if (page === "reports") content = <ReportsPage />;
    else content = <TodayPage />;

    return (
      <div className="product-demo-root">
        <div className="product-demo-disclosure">演示数据 · 非用户记录</div>
        <AppShell>{content}</AppShell>
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><DemoApp /></React.StrictMode>,
  );
}

void mountDemo();
