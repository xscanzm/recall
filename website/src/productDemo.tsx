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

const demoProjects = [
  demoProject,
  {
    ...demoProject,
    id: "project-launch",
    name: "公开测试版发布",
    summary: "协调安装包、版本说明、下载流程和发布后的反馈收集。",
    lastActiveAt: `${demoDateKey}T16:50:00`,
    sourceFactIds: ["fact-launch"],
    sourceSceneIds: ["scene-launch"],
  },
  {
    ...demoProject,
    id: "project-content",
    name: "产品内容计划",
    summary: "持续整理用户案例、使用指南和产品设计背后的思考。",
    lastActiveAt: `${demoDateKey}T11:20:00`,
    sourceFactIds: ["fact-content"],
    sourceSceneIds: ["scene-content"],
  },
];

const demoPeople = [
  {
    id: "person-lin",
    name: "林然",
    role: "产品设计",
    organization: "Recall 团队",
    summary: "共同梳理产品体验与品牌表达，关注界面是否让用户感到清楚、安心。",
    relatedProjectIds: ["project-recall", "project-launch"],
    sourceFactIds: ["fact-copy", "fact-lin"],
    createdAt: `${demoDateKey}T09:30:00`,
    updatedAt: `${demoDateKey}T15:40:00`,
    deletedAt: null,
    relationship: null,
  },
  {
    id: "person-zhou",
    name: "周屿",
    role: "开发协作",
    organization: "Recall Contributors",
    summary: "负责发布流程与桌面端适配，经常一起确认构建、安装和兼容性问题。",
    relatedProjectIds: ["project-recall", "project-launch"],
    sourceFactIds: ["fact-release", "fact-zhou"],
    createdAt: `${demoDateKey}T10:10:00`,
    updatedAt: `${demoDateKey}T17:10:00`,
    deletedAt: null,
    relationship: null,
  },
  {
    id: "person-chen",
    name: "陈默",
    role: "早期体验者",
    organization: null,
    summary: "从日常知识工作场景提供体验反馈，尤其关心记忆搜索和隐私控制。",
    relatedProjectIds: ["project-content"],
    sourceFactIds: ["fact-chen"],
    createdAt: `${demoDateKey}T11:00:00`,
    updatedAt: `${demoDateKey}T14:20:00`,
    deletedAt: null,
    relationship: null,
  },
];

const demoTasks = [
  {
    id: "task-mobile",
    title: "完成移动端首页验收",
    status: "open",
    projectId: "project-launch",
    summary: "发布前确认长标题、产品界面和下载按钮。",
    dueHint: "发布前",
    priority: 2,
    confidence: 0.95,
    sourceFactIds: ["fact-release", "fact-zhou"],
    createdAt: `${demoDateKey}T16:20:00`,
    updatedAt: `${demoDateKey}T17:10:00`,
    completedAt: null,
    deletedAt: null,
  },
  {
    id: "task-feedback",
    title: "整理首轮体验反馈",
    status: "open",
    projectId: "project-content",
    summary: "归纳记忆搜索与隐私设置相关建议。",
    dueHint: "本周",
    priority: 1,
    confidence: 0.9,
    sourceFactIds: ["fact-chen"],
    createdAt: `${demoDateKey}T14:20:00`,
    updatedAt: `${demoDateKey}T14:20:00`,
    completedAt: null,
    deletedAt: null,
  },
];

const demoDecisions = [
  {
    id: "decision-story",
    title: "首页叙事方向",
    decision: "从用户的一天出发，而不是先介绍模型和截图能力。",
    projectId: "project-recall",
    rationale: "用户更容易理解产品为自己留下了什么。",
    confidence: 0.96,
    sourceFactIds: ["fact-copy", "fact-lin"],
    decidedAt: `${demoDateKey}T14:45:00`,
    createdAt: `${demoDateKey}T14:45:00`,
    updatedAt: `${demoDateKey}T14:45:00`,
    deletedAt: null,
  },
];

const demoScenes = demoTimeline.map((block, index) => ({
  id: block.sourceSceneIds[0],
  title: block.title,
  summary: block.summary,
  startAt: block.startAt,
  endAt: block.endAt,
  projectId: index < 2 ? "project-recall" : "project-launch",
  confidence: block.confidence ?? 0.9,
  factIds: block.sourceFactIds,
  observationIds: block.sourceObservationIds,
  entityNames: index === 0 ? ["周屿"] : index === 1 ? ["林然"] : [],
  createdAt: block.startAt,
  updatedAt: block.endAt,
  deletedAt: null,
}));

const personFacts = [
  ...demoFacts,
  { ...demoFacts[0], id: "fact-lin", content: "林然建议减少技术解释，让产品价值从具体的一天自然浮现。", sourceObservationIds: [] },
  { ...demoFacts[0], id: "fact-zhou", content: "周屿会在发布前核对安装包和 Windows 兼容性。", sourceObservationIds: [] },
  { ...demoFacts[0], id: "fact-chen", content: "陈默希望搜索结果始终能回到当时的上下文和来源。", sourceObservationIds: [] },
];

const projectDetailFor = (id: string) => {
  const project = demoProjects.find((item) => item.id === id) ?? demoProject;
  return {
    project,
    facts: personFacts.filter((item) => !item.projectId || item.projectId === id),
    scenes: demoScenes.filter((item) => item.projectId === id || id === "project-recall"),
    tasks: demoTasks.filter((item) => item.projectId === id),
    decisions: demoDecisions.filter((item) => item.projectId === id),
    people: demoPeople.filter((item) => item.relatedProjectIds.includes(id)),
    recentReports: [],
    unfinishedThreads: demoThreads.filter((item) => item.projectName === project.name),
  };
};

const personDetailFor = (id: string) => {
  const person = demoPeople.find((item) => item.id === id) ?? demoPeople[0];
  return {
    person,
    relatedProjects: demoProjects.filter((item) => person.relatedProjectIds.includes(item.id)),
    relatedScenes: demoScenes.filter((item) => item.entityNames.includes(person.name)),
    relatedTasks: demoTasks.filter((item) => item.sourceFactIds.some((factId) => person.sourceFactIds.includes(factId))),
    relatedFacts: personFacts.filter((item) => person.sourceFactIds.includes(item.id)),
  };
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
    matchReasons: [],
    sourceCount: 1,
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
    matchReasons: [],
    sourceCount: 1,
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
    matchReasons: [],
    sourceCount: 1,
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
  endOfDayReview: {
    enabled: true,
    firstTime: "17:30",
    secondTime: "18:00",
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
      scenes: demoScenes,
      tasks: demoTasks,
      decisions: demoDecisions,
      people: demoPeople,
      projects: demoProjects,
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
    getProjectDetail: ({ id }: { id: string }) => Promise.resolve(projectDetailFor(id)),
    getPersonDetail: ({ id }: { id: string }) => Promise.resolve(personDetailFor(id)),
    listProjects: () => Promise.resolve({ ok: true, projects: demoProjects }),
    listPeople: () => Promise.resolve({ ok: true, people: demoPeople }),
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
  const [storeModule, shellModule, todayModule, tasksModule, memoryModule, reportsModule, projectsModule, peopleModule] = await Promise.all([
    import("../../src/renderer/state/store"),
    import("../../src/renderer/components/AppShell"),
    import("../../src/renderer/pages/TodayPage"),
    import("../../src/renderer/pages/TasksPage"),
    import("../../src/renderer/pages/MemorySearchPage"),
    import("../../src/renderer/pages/ReportsPage"),
    import("../../src/renderer/pages/ProjectsPage"),
    import("../../src/renderer/pages/PeoplePage"),
  ]);

  const { useAppStore } = storeModule;
  const { AppShell } = shellModule;
  const { TodayPage } = todayModule;
  const { TasksPage } = tasksModule;
  const { MemorySearchPage } = memoryModule;
  const { ReportsPage } = reportsModule;
  const { ProjectsPage } = projectsModule;
  const { PeoplePage } = peopleModule;

  const requestedPage = new URLSearchParams(window.location.search).get("page");
  const initialPage = requestedPage === "tasks" || requestedPage === "memory" || requestedPage === "reports" || requestedPage === "projects" || requestedPage === "people"
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
      scenes: demoScenes,
      tasks: demoTasks,
      decisions: demoDecisions,
      people: demoPeople,
      projects: demoProjects,
    },
    unfinishedThreads: demoThreads,
    personalReview: demoReview,
    workReport: demoWorkReport,
    reportsDateKey: demoDateKey,
    searchQuery: "首页标题",
    searchResults,
    searchSearched: true,
    followupQuestion: "上次那个首页标题，最后是怎么定的？",
    aiMode: "answer",
    aiResult: {
      ok: true,
      mode: "answer",
      answer: "你最后决定从用户的一天出发，用“让认真度过的一天，被好好记住”作为首页主张。",
      sources: searchResults.slice(0, 2),
      candidateCount: 3,
    },
  });

  function DemoApp() {
    const page = useAppStore((state) => state.currentPage);
    let content: React.ReactNode;
    if (page === "tasks") content = <TasksPage />;
    else if (page === "memory") content = <MemorySearchPage />;
    else if (page === "reports") content = <ReportsPage />;
    else if (page === "projects") content = <ProjectsPage />;
    else if (page === "people") content = <PeoplePage />;
    else content = <TodayPage />;

    return (
      <div className="product-demo-root">
        <AppShell>{content}</AppShell>
      </div>
    );
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><DemoApp /></React.StrictMode>,
  );
}

void mountDemo();
