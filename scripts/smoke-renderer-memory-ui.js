const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "scripts", "output");
const preloadPath = path.join(outputDir, "smoke-renderer-preload.js");
const indexPath = path.join(rootDir, "dist", "renderer", "index.html");
const captureDir = process.env.RECALL_CAPTURE_DIR || null;
const now = "2026-07-09T10:08:00.000Z";
const dateKey = "2026-07-09";
const marketingCapture = Boolean(captureDir);

function writePreload() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(preloadPath, buildPreloadSource(), "utf8");
}

function buildPreloadSource() {
  return String.raw`
const { contextBridge } = require("electron");

const now = "${now}";
const dateKey = "${dateKey}";
const marketingCapture = ${marketingCapture};
const copy = marketingCapture ? {
  appName: "浏览器",
  windowTitle: "夏日市集活动方案",
  sceneTitle: "整理夏日市集的活动方案",
  sceneSummary: "从资料搜集、主题构思到页面文案，逐步整理出一份可以继续完善的活动方案。",
  taskFact: "发布前还需要确认移动端页面和报名链接。",
  decisionFact: "活动首页采用真实现场照片，不再使用抽象插画。",
  projectName: "夏日市集发布计划",
  projectSummary: "完成活动主题、首页内容、报名流程和发布前检查。",
  taskTitle: "检查移动端页面与报名链接",
  taskSummary: "桌面版内容已经完成，发布前还需要确认手机端显示和报名流程。",
  decisionTitle: "首页视觉方向",
  decisionText: "首页使用真实现场照片，让来访者第一眼感受到活动氛围。",
  timelineTitle: "完成夏日市集首页内容",
  timelineSummary: "整理活动主题、修改首页文案，并确认用真实现场照片作为首屏视觉。",
  highlights: ["首页叙事已经定稿", "确定使用真实现场照片", "报名流程已基本完成", "还需检查移动端"],
  unfinishedTitle: "发布前检查移动端页面",
  unfinishedReason: "桌面版已经完成，但手机端按钮和报名链接还没有最后确认。",
  unfinishedAction: "用手机走一遍报名流程，再发布活动页面。",
  reviewOverview: "今天终于把夏日市集从一个模糊的念头，整理成了可以发布的活动页面。",
  reviewThreads: ["完成活动首页", "确认视觉方向"],
  reviewProgress: ["首页文案定稿", "报名流程基本完成"],
  reviewUnfinished: "检查手机端页面和报名链接",
  reviewNext: "用手机完成一次报名测试",
  reviewMemory: "真实的现场照片，比抽象插画更能让人感受到活动。",
  tomorrow: "从移动端检查开始",
  reportText: "今日完成夏日市集首页内容与报名流程，确认首屏使用真实现场照片。",
  reportCompleted: "完成活动首页文案与页面结构",
  reportProgress: "报名流程已基本打通",
  reportRisk: "移动端显示仍需最后检查",
  reportPlan: "完成手机端测试并发布",
  searchTitle: "夏日市集首页视觉方向",
  searchSummary: "你决定使用真实现场照片，让来访者第一眼感受到活动氛围。",
} : null;
const appStatus = { observing: true, paused: false, pipelineState: "observing" };
const settings = {
  observation: {
    enabled: true,
    activeWindowStableSeconds: 10,
    contentChangeMinIntervalSeconds: 30,
    longSessionIntervalMinutes: 10,
    idleThresholdSeconds: 180,
  },
  screenshot: { retentionPolicy: "keep_7_days" },
  notification: {
    inAppReminders: true,
    desktopNotifications: false,
    dailyReportTime: "18:30",
    weeklyReportTime: "18:00",
  },
  dailyReport: { autoGenerate: false, time: "18:30" },
  onboardingCompleted: true,
  debug: { enabled: false, verboseModelIO: false },
};

const observations = Array.from({ length: 6 }, (_, index) => ({
  id: "obs_" + (index + 1),
  captureId: "capture_" + (index + 1),
  capturedAt: "2026-07-09T10:0" + index + ":00.000Z",
  appName: copy?.appName || "微信",
  windowTitle: copy?.windowTitle || "Recall 记忆系统讨论",
  urlOrDomain: null,
  captureReason: "batch_capture",
  sceneSummary: copy?.sceneSummary || ("讨论 Recall 记忆系统分层，第 " + (index + 1) + " 个瞬间。"),
  sensitivity: "low",
  confidence: 0.9,
  createdAt: now,
}));

const facts = [
  {
    id: "fact_task",
    type: "task",
    content: copy?.taskFact || "需要把 L0 先稳定为低判断观察层，再继续沉淀 L1 片段。",
    status: "active",
    projectId: "project_recall",
    projectHint: copy?.projectName || "Recall 记忆系统重构",
    importance: 4,
    confidence: 0.92,
    inferred: false,
    evidenceText: "微信讨论中明确提出先解决第一层。",
    sourceObservationIds: ["obs_1", "obs_2"],
    tags: ["memory", "l0"],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  },
  {
    id: "fact_decision",
    type: "decision",
    content: copy?.decisionFact || "Edges 作为关系层，不再作为 L4 页面呈现。",
    status: "active",
    projectId: "project_recall",
    projectHint: copy?.projectName || "Recall 记忆系统重构",
    importance: 5,
    confidence: 0.94,
    inferred: false,
    evidenceText: "讨论中确认关系层贯穿所有层。",
    sourceObservationIds: ["obs_3", "obs_4"],
    tags: ["edges"],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  },
];

const scenes = [
  {
    id: "scene_wechat_memory",
    title: copy?.sceneTitle || "微信讨论 Recall 记忆系统分层",
    summary: copy?.sceneSummary || "围绕 L-1、L0、L1、L2、L3 与关系层的职责边界展开讨论。",
    startAt: "2026-07-09T10:00:00.000Z",
    endAt: "2026-07-09T10:10:00.000Z",
    projectId: "project_recall",
    confidence: 0.91,
    factIds: ["fact_task", "fact_decision"],
    observationIds: observations.map((item) => item.id),
    entityNames: ["张三", "Recall 记忆系统重构"],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  },
];

const projects = [
  {
    id: "project_recall",
    name: copy?.projectName || "Recall 记忆系统重构",
    summary: copy?.projectSummary || "从重 L0 改为分层沉淀：观察、片段、记忆原子、长期对象和关系层。",
    status: "active",
    lastActiveAt: now,
    sourceFactIds: ["fact_task", "fact_decision"],
    sourceSceneIds: ["scene_wechat_memory"],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    aliases: ["记忆系统"],
  },
];

const tasks = [
  {
    id: "task_l0",
    title: copy?.taskTitle || "收束 L0 为低判断观察层",
    status: "open",
    projectId: "project_recall",
    summary: copy?.taskSummary || "减少单次结论负担，保留可重建的底层观察。",
    dueHint: "今天",
    priority: 4,
    confidence: 0.9,
    sourceFactIds: ["fact_task"],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
  },
];

const decisions = [
  {
    id: "decision_edges",
    title: copy?.decisionTitle || "关系层定位",
    decision: copy?.decisionText || "Edges 是贯穿 L0-L3 的关系层，不作为独立 L4 页面。",
    projectId: "project_recall",
    rationale: "这样避免把关系图过早产品化，同时保留证据链。",
    confidence: 0.94,
    sourceFactIds: ["fact_decision"],
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  },
];

const people = [
  {
    id: "person_zhangsan",
    name: "张三",
    role: "协作者",
    organization: "Recall",
    summary: "参与记忆系统分层设计讨论，关注 L0 稳定性。",
    relatedProjectIds: ["project_recall"],
    sourceFactIds: ["fact_task"],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    aliases: [],
  },
];

const today = { observations, facts, scenes, tasks, decisions, people, projects };
const timelineBlocks = [
  {
    id: "block_wechat_memory",
    dateKey,
    startAt: "2026-07-09T10:00:00.000Z",
    endAt: "2026-07-09T10:10:00.000Z",
    title: copy?.timelineTitle || "微信讨论 Recall 记忆系统分层",
    summary: copy?.timelineSummary || "讨论如何让 L0 只做识别，后续逐层沉淀为片段、记忆原子和长期对象。",
    category: "work",
    projectIds: ["project_recall"],
    projectNames: [copy?.projectName || "Recall 记忆系统重构"],
    highlights: copy?.highlights || ["L0 降低判断负担", "关系层用 Edges 承接证据链", "保留完整证据链", "前台使用自然语言"],
    generatedTasks: [copy?.taskTitle || "收束 L0 为低判断观察层"],
    generatedDecisions: [copy?.decisionFact || "Edges 不作为 L4 页面"],
    reportable: true,
    privateRisk: "medium",
    privateRiskReason: "讨论中提到了协作者和内部方案，分享前需要检查。",
    sourceSceneIds: ["scene_wechat_memory"],
    sourceFactIds: ["fact_task", "fact_decision"],
    sourceObservationIds: observations.map((item) => item.id),
    confidence: 0.92,
    createdAt: now,
    updatedAt: now,
  },
];

const unfinishedThreads = [
  {
    id: "unfinished_l0",
    title: copy?.unfinishedTitle || "确认 L0 批量观察边界",
    reason: copy?.unfinishedReason || "微信讨论里明确担心 L0 一旦失败会影响后续全部层级。",
    suggestedNextAction: copy?.unfinishedAction || "先用 6 帧批量观察验证低判断输出。",
    priority: "high",
    projectName: copy?.projectName || "Recall 记忆系统重构",
    lastSeenAt: now,
    sourceFactIds: ["fact_task"],
    sourceTimelineBlockIds: ["block_wechat_memory"],
    confidence: 0.9,
    status: "open",
    createdAt: now,
    updatedAt: now,
  },
];

const personalReview = {
  id: "personal_review_today",
  dateKey,
  title: "我的复盘",
  overview: copy?.reviewOverview || "今天把 Recall 记忆系统从一次性识别，重新拆成可追溯、可重试的分层链路。",
  mainThreads: copy?.reviewThreads || ["重新定义 L0-L3", "确认前台页面入口"],
  meaningfulProgress: copy?.reviewProgress || ["明确 L0 只保存观察", "确认待收尾页面定位"],
  unfinished: [
    {
      text: copy?.reviewUnfinished || "继续验证真实运行态数据流",
      suggestedNextAction: copy?.reviewNext || "跑 Electron 前台 smoke",
      sourceTimelineBlockIds: ["block_wechat_memory"],
      sourceFactIds: ["fact_task"],
    },
  ],
  worthRemembering: [
    {
      text: copy?.reviewMemory || "前台应忠实记录，不提前做对外降级。",
      reason: "这是产品呈现原则。",
      sourceFactIds: ["fact_decision"],
    },
  ],
  tomorrowStartHere: [copy?.tomorrow || "从真实 UI 验证开始"],
  createdAt: now,
  updatedAt: now,
};

const workReport = {
  id: "work_report_today",
  dateKey,
  title: "工作日报",
  plainText: copy?.reportText || "今日完成 Recall 记忆系统分层重构方案与前台入口验证。",
  sections: {
    completed: [copy?.reportCompleted || "完成 L0-L3 分层方案"],
    projectProgress: [copy?.reportProgress || "打通片段、事实、对象与关系层"],
    risks: [copy?.reportRisk || "真实模型输出仍需继续观察"],
    tomorrowPlan: [copy?.reportPlan || "继续做运行态验证"],
  },
  sourceTimelineBlockIds: ["block_wechat_memory"],
  sourceFactIds: ["fact_task", "fact_decision"],
  omittedForPrivacy: 0,
  warnings: [],
  createdAt: now,
  updatedAt: now,
};

const reports = [
  {
    id: "report_weekly",
    type: "weekly",
    dateKey,
    title: "Recall 记忆系统周报",
    contentJson: JSON.stringify({
      plainText: "本周完成 Recall 记忆系统分层重构。",
      sections: [{ title: "进展", items: ["打通 L0 到 L3 的证据链"] }],
    }),
    sourceFactIds: ["fact_task"],
    sourceSceneIds: ["scene_wechat_memory"],
    createdAt: now,
    updatedAt: now,
    projectId: "project_recall",
  },
];

const api = {
  app: {
    getStatus: async () => appStatus,
    startObserving: async () => appStatus,
    pauseObserving: async () => ({ ...appStatus, paused: true, observing: false }),
    getLaunchAtLogin: async () => ({ ok: true, enabled: false }),
    setLaunchAtLogin: async (input) => ({ ok: true, enabled: !!input.enabled }),
    getVersion: async () => ({ version: "0.3.0" }),
    onStatusChanged: () => () => undefined,
    onNavigate: () => () => undefined,
  },
  window: {
    minimize: async () => ({ ok: true }),
    toggleMaximize: async () => ({ ok: true }),
    close: async () => ({ ok: true }),
  },
  settings: {
    get: async () => settings,
    update: async () => ({ ok: true }),
  },
  model: {
    testConnection: async () => ({ ok: true }),
    listConfigs: async () => [],
    saveConfig: async () => ({ ok: true }),
    deleteConfig: async () => ({ ok: true }),
  },
  privacy: {
    listRules: async () => [],
    addRule: async (input) => input,
    updateRule: async () => ({ ok: true }),
    deleteRule: async () => ({ ok: true }),
  },
  memory: {
    listToday: async () => today,
    search: async () => ({
      results: [
        {
          id: "scene_wechat_memory",
          type: "scene",
          title: copy?.searchTitle || "微信讨论 Recall 记忆系统分层",
          summary: copy?.searchSummary || "L0 到 L3 的分层记忆链路。",
          createdAt: now,
          projectName: "Recall 记忆系统重构",
          projectId: "project_recall",
          sourceType: "scene",
          sourceId: "scene_wechat_memory",
          relevance: 5,
          matchReasons: ["标题"],
          sourceCount: 1,
        },
      ],
      total: 1,
      quality: "strong",
      queryTerms: ["recall", "记忆", "系统"],
    }),
    expandSearch: async () => ({ ok: true, expandedTerms: ["Recall", "记忆系统"], results: [], total: 0, quality: "none" }),
    getDetail: async ({ id, type }) => {
      const isTimeline = type === "timeline";
      const isFact = type === "fact";
      return {
        id,
        type,
        title: isTimeline ? (copy?.timelineTitle || "微信讨论 Recall 记忆系统分层") : isFact ? (facts.find((fact) => fact.id === id)?.content || "相关线索") : "微信讨论 Recall 记忆系统分层",
        summary: isTimeline ? (copy?.timelineSummary || "L0 到 L3 的分层记忆链路。") : isFact ? "微信讨论中明确提出先解决第一层。" : "L0 到 L3 的分层记忆链路。",
        createdAt: now,
        projectId: "project_recall",
        projectName: copy?.projectName || "Recall 记忆系统重构",
        fields: [{ label: "开始", value: now }],
        contentSections: [{ title: isTimeline ? "时间轴片段" : isFact ? "具体内容" : "工作片段", text: isFact ? (facts.find((fact) => fact.id === id)?.content || "相关线索") : "讨论 Recall 记忆系统分层。", items: ["L0 降低判断负担"] }],
        sources: [{ id: "obs_1", capturedAt: now, appName: copy?.appName || "微信", windowTitle: copy?.windowTitle || "Recall 讨论", url: null, summary: "讨论记忆分层", visibleContent: [{ type: "chat", summary: "讨论 L0-L3", fullText: "L0 降低判断负担\n叶商白（12群） 人间唢呐奖\nMatilda（19群） 人间唢呐奖", keyTextSnippets: ["L0 降低判断负担"] }], screenshotState: "none", screenshotCount: 0 }],
        relations: [],
        correctionType: isTimeline ? null : isFact ? "fact" : "scene",
      };
    },
    getSourcePreview: async () => ({ ok: false, code: "not_found", message: "截图不存在" }),
    openSourceUrl: async () => ({ ok: true }),
    updateFact: async () => ({ ok: true }),
    updateTask: async () => ({ ok: true }),
    deleteObject: async () => ({ ok: true }),
    ask: async ({ mode, question }) => ({
      ok: true,
      mode,
      answer: mode === "summary"
        ? "基于记录，今天重点是 L0-L3 分层。"
        : "针对追问“" + question + "”，记录显示应先稳定低判断观察层。",
      sources: [],
      candidateCount: 1,
    }),
    createUserFeedback: async () => ({ ok: true, feedback: {} }),
    getProjectDetail: async () => ({
      project: projects[0],
      facts,
      scenes,
      tasks,
      decisions,
      people,
      recentReports: reports,
    }),
    getPersonDetail: async () => ({
      person: people[0],
      relatedProjects: projects,
      relatedScenes: scenes,
      relatedTasks: tasks,
      relatedFacts: facts,
    }),
    mergeObjects: async () => ({ ok: true, merged: { ok: true, fromId: "a", toId: "b", objectType: "project", rewrittenFactsCount: 0, rewrittenScenesCount: 0, mergedAliases: [] } }),
    listMergeSuggestions: async () => ({ ok: true, items: [] }),
    rejectMergeSuggestion: async () => ({ ok: true }),
    listAllAliases: async () => ({ ok: true, projects: [], people: [] }),
    listPeople: async () => ({ ok: true, people }),
    listProjects: async () => ({ ok: true, projects }),
  },
  reminders: {
    list: async () => [],
    updateStatus: async () => ({ ok: true }),
  },
  reports: {
    list: async () => reports,
    get: async ({ id }) => reports.find((item) => item.id === id) || null,
    getImage: async () => ({ ok: true, data: null }),
    onImageReady: () => () => {},
    getEvidenceByIds: async ({ factIds = [], sceneIds = [], blockIds = [] }) => ({
      ok: true,
      data: {
        facts: facts.filter((item) => factIds.includes(item.id)),
        scenes: scenes.filter((item) => sceneIds.includes(item.id)),
        timelineBlocks: timelineBlocks.filter((item) => blockIds.includes(item.id)),
      },
    }),
    generate: async () => ({ ok: true, reportId: "generated_report" }),
    update: async () => ({ ok: true, report: {} }),
    delete: async () => true,
  },
  capture: { forgetRecent: async () => ({ ok: true, deletedObservations: 0, deletedScreenshots: 0 }) },
  screenshot: { clear: async () => ({ ok: true, deletedScreenshots: 0 }) },
  data: {
    export: async () => ({ ok: true, export: {} }),
    clearAll: async () => ({ ok: true, deletedScreenshots: 0 }),
    getCacheSize: async () => ({ ok: true, bytes: 0, fileCount: 0 }),
  },
  timeline: {
    build: async () => ({ ok: true, data: timelineBlocks }),
    get: async () => ({ ok: true, data: timelineBlocks }),
  },
  activity: {
    getDayOverview: async () => ({
      ok: true,
      data: {
        stats: {
          totalObservedMinutes: 120,
          categorizedMinutes: { coding: 90 },
          pendingMinutes: 30,
          sampleCount: 24,
        },
        episodes: [{
          id: "scene_wechat_memory",
          startAt: "2026-07-09T10:00:00.000Z",
          endAt: "2026-07-09T10:10:00.000Z",
          title: copy?.sceneTitle || "微信讨论 Recall 记忆系统分层",
          summary: copy?.sceneSummary || "围绕分层记忆与关系层职责边界展开讨论。",
          category: "communication",
          categoryConfidence: 0.91,
          sourceObservationIds: observations.map((item) => item.id),
          projectNames: [copy?.projectName || "Recall 记忆系统重构"],
          topicTexts: [copy?.decisionFact || "Edges 不作为 L4 页面"],
        }],
        windows: [{
          id: "activity-window:scene_wechat_memory",
          startAt: "2026-07-09T10:00:00.000Z",
          endAt: "2026-07-09T10:10:00.000Z",
          title: copy?.sceneTitle || "微信讨论 Recall 记忆系统分层",
          summary: copy?.sceneSummary || "围绕分层记忆与关系层职责边界展开讨论。",
          category: "communication",
          categoryConfidence: 0.91,
          sourceEpisodeIds: ["scene_wechat_memory"],
          sourceObservationIds: observations.map((item) => item.id),
          projectNames: [copy?.projectName || "Recall 记忆系统重构"],
          topicTexts: [copy?.decisionFact || "Edges 不作为 L4 页面"],
        }],
        observedStartAt: "2026-07-09T10:00:00.000Z",
        observedEndAt: "2026-07-09T10:10:00.000Z",
      },
    }),
  },
  personalReview: {
    generate: async () => ({ ok: true, data: personalReview }),
    get: async () => ({ ok: true, data: personalReview }),
  },
  workReport: {
    generate: async () => ({ ok: true, data: workReport }),
    get: async () => ({ ok: true, data: workReport }),
    saveSelection: async () => ({ ok: true }),
  },
  unfinishedThreads: {
    list: async ({ status } = {}) => ({ ok: true, data: status ? unfinishedThreads.filter((thread) => thread.status === status) : unfinishedThreads }),
    updateStatus: async ({ id, status }) => {
      const thread = unfinishedThreads.find((item) => item.id === id);
      if (thread) thread.status = status;
      return { ok: true, data: null };
    },
  },
  debug: {
    listJobs: async () => ({ ok: true, jobs: [] }),
    getJobDetails: async () => ({ ok: true, job: null }),
    getRelatedRecords: async () => ({ ok: true, data: {} }),
  },
  update: {
    check: async () => ({ ok: true }),
    download: async () => ({ ok: true }),
    installAndQuit: async () => ({ ok: true }),
    getStatus: async () => ({ state: "idle" }),
    dismissVersion: async () => ({ ok: true }),
    onProgress: () => () => undefined,
    onStatusChanged: () => () => undefined,
  },
};

contextBridge.exposeInMainWorld("recallAPI", api);
`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForText(win, text, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await win.webContents.executeJavaScript(
      `document.body && document.body.innerText.includes(${JSON.stringify(text)})`,
      true
    );
    if (found) return;
    await wait(100);
  }
  const bodyText = await getBodyText(win);
  const diagnostics = await win.webContents.executeJavaScript(`({ readyState: document.readyState, html: document.documentElement.outerHTML.slice(0, 1000) })`, true);
  throw new Error(`Timed out waiting for text: ${text}\nCurrent text:\n${bodyText.slice(0, 2000)}\nDiagnostics:\n${JSON.stringify(diagnostics)}`);
}

async function getBodyText(win) {
  return win.webContents.executeJavaScript("document.body ? document.body.innerText : ''", true);
}

async function clickByLabel(win, label) {
  const clicked = await win.webContents.executeJavaScript(
    `(() => {
      const label = ${JSON.stringify(label)};
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const node = nodes.find((el) => {
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const text = (el.innerText || el.textContent || '').trim();
        return aria === label || title === label || text.includes(label);
      });
      if (!node) return false;
      node.click();
      if (node.getAttribute('role') === 'button') {
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      return true;
    })()`,
    true
  );
  if (!clicked) {
    const bodyText = await getBodyText(win);
    throw new Error(`Could not click label: ${label}\nCurrent text:\n${bodyText.slice(0, 2000)}`);
  }
  await wait(250);
}

async function assertTexts(win, texts) {
  for (const text of texts) {
    await waitForText(win, text);
  }
}

async function assertTextAbsent(win, text, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const bodyText = await getBodyText(win);
    if (!bodyText.includes(text)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for text to disappear: ${text}`);
}

async function capturePage(win, fileName) {
  if (!captureDir) return;
  fs.mkdirSync(captureDir, { recursive: true });
  await wait(350);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(captureDir, fileName), image.toPNG());
}

async function run() {
  writePreload();
  if (!fs.existsSync(indexPath)) {
    throw new Error("Renderer build not found. Run npm run build:renderer first.");
  }

  await app.whenReady();
  const win = new BrowserWindow({
    width: 1365,
    height: 900,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const consoleMessages = [];
  const pageErrors = [];
  win.webContents.on("console-message", (_event, level, message) => {
    if (/Autofill\./.test(message)) return;
    consoleMessages.push({ level, message });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    pageErrors.push(`render-process-gone: ${details.reason}`);
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    pageErrors.push(`did-fail-load: ${errorCode} ${errorDescription}`);
  });

  await win.loadFile(indexPath);
  await waitForText(win, "今日");
  await assertTexts(win, [
    "微信讨论 Recall 记忆系统分层",
    "L0 降低判断负担",
    "确认 L0 批量观察边界",
    "我的复盘",
  ]);
  await capturePage(win, "today.png");
  await clickByLabel(win, "细节");
  await assertTexts(win, [
    "前台使用自然语言",
    "接下来要做",
    "收束 L0 为低判断观察层",
    "形成的决定",
    "Edges 不作为 L4 页面",
    "整理把握",
    "把握较高，记录之间相互印证",
    "隐私提醒",
    "讨论中提到了协作者和内部方案，分享前需要检查。",
    "6 个活动瞬间",
    "2 条记忆线索",
    "1 个工作片段",
  ]);
  await clickByLabel(win, "来自今天 18:00 的记录");
  await assertTexts(win, ["返回今日时间轴", "时间轴", "来源记录", "L0 降低判断负担"]);
  await clickByLabel(win, "返回今日时间轴");

  await clickByLabel(win, "待收尾");
  await assertTexts(win, ["待收尾", "确认 L0 批量观察边界", "先用 6 帧批量观察验证低判断输出"]);
  await capturePage(win, "unfinished.png");
  await clickByLabel(win, "查看来源");
  await assertTexts(win, ["来源", "需要把 L0 先稳定为低判断观察层"]);
  await clickByLabel(win, "需要把 L0 先稳定为低判断观察层");
  await assertTexts(win, ["返回待收尾来源", "具体内容", "来源记录", "L0 降低判断负担"]);
  await clickByLabel(win, "返回待收尾来源");
  await clickByLabel(win, "标记为完成");
  await assertTextAbsent(win, "确认 L0 批量观察边界");

  await clickByLabel(win, "项目");
  await assertTexts(win, ["项目", "Recall 记忆系统重构", "查看项目"]);
  await clickByLabel(win, "查看项目");
  await assertTexts(win, ["最近时间轴", "关键决策", "相关人物", "Edges 是贯穿 L0-L3 的关系层"]);

  await clickByLabel(win, "人物");
  await assertTexts(win, ["人物", "张三", "相关项目"]);
  await clickByLabel(win, "张三");
  await assertTexts(win, ["最近协作", "提到过的事", "需要把 L0 先稳定为低判断观察层"]);

  await clickByLabel(win, "记忆库");
  await assertTexts(win, ["记忆库", "找回过去的工作、资料、决策或人", "本地先找"]);
  await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('input[placeholder="搜索关键词，或直接描述你想找的记忆"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Recall 记忆系统');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
      return true;
    })()`,
    true
  );
  await assertTexts(win, ["找到 1 条相关记忆", "微信讨论 Recall 记忆系统分层", "AI总结", "AI回答"]);
  await clickByLabel(win, "AI总结");
  await assertTexts(win, ["基于记录，今天重点是 L0-L3 分层。", "基于 1 条候选记忆"]);
  await clickByLabel(win, "AI回答");
  await win.webContents.executeJavaScript(
    `(() => {
      const input = document.querySelector('input[aria-label="针对检索结果提问"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '为什么要先稳定观察层？');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').requestSubmit();
      return true;
    })()`,
    true
  );
  await assertTexts(win, ["针对追问“为什么要先稳定观察层？”，记录显示应先稳定低判断观察层。"]);
  await capturePage(win, "memory-search.png");
  await clickByLabel(win, "微信讨论 Recall 记忆系统分层");
  await assertTexts(win, ["返回搜索结果", "来源记录", "L0 降低判断负担"]);
  await clickByLabel(win, "返回搜索结果");

  await clickByLabel(win, "报告");
  await assertTexts(win, ["报告", "我的复盘", "工作日报", "今天把 Recall 记忆系统"]);
  await capturePage(win, "report.png");
  await clickByLabel(win, "工作日报");
  await assertTexts(win, ["今日完成 Recall 记忆系统分层重构方案", "查看来源"]);
  await clickByLabel(win, "查看来源");
  await assertTexts(win, ["工作日报来源", "来源事实", "时间轴片段", "需要把 L0 先稳定为低判断观察层"]);

  const severeMessages = consoleMessages.filter((item) => item.level >= 2);
  if (pageErrors.length > 0 || severeMessages.length > 0) {
    throw new Error(JSON.stringify({ pageErrors, severeMessages }, null, 2));
  }

  console.log(JSON.stringify({ ok: true, pages: ["今日", "待收尾", "项目", "人物", "记忆库", "报告"], preloadPath }, null, 2));
  win.close();
}

run()
  .then(() => {
    app.quit();
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    app.exit(1);
  });
