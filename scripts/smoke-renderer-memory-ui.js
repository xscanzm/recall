const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "scripts", "output");
const preloadPath = path.join(outputDir, "smoke-renderer-preload.js");
const indexPath = path.join(rootDir, "dist", "renderer", "index.html");
const now = "2026-07-09T10:08:00.000Z";
const dateKey = "2026-07-09";

function writePreload() {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(preloadPath, buildPreloadSource(), "utf8");
}

function buildPreloadSource() {
  return String.raw`
const { contextBridge } = require("electron");

const now = "${now}";
const dateKey = "${dateKey}";
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
  appName: "微信",
  windowTitle: "Recall 记忆系统讨论",
  urlOrDomain: null,
  captureReason: "batch_capture",
  sceneSummary: "讨论 Recall 记忆系统分层，第 " + (index + 1) + " 个瞬间。",
  sensitivity: "low",
  confidence: 0.9,
  createdAt: now,
}));

const facts = [
  {
    id: "fact_task",
    type: "task",
    content: "需要把 L0 先稳定为低判断观察层，再继续沉淀 L1 片段。",
    status: "active",
    projectId: "project_recall",
    projectHint: "Recall 记忆系统重构",
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
    content: "Edges 作为关系层，不再作为 L4 页面呈现。",
    status: "active",
    projectId: "project_recall",
    projectHint: "Recall 记忆系统重构",
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
    title: "微信讨论 Recall 记忆系统分层",
    summary: "围绕 L-1、L0、L1、L2、L3 与关系层的职责边界展开讨论。",
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
    name: "Recall 记忆系统重构",
    summary: "从重 L0 改为分层沉淀：观察、片段、记忆原子、长期对象和关系层。",
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
    title: "收束 L0 为低判断观察层",
    status: "open",
    projectId: "project_recall",
    summary: "减少单次结论负担，保留可重建的底层观察。",
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
    title: "关系层定位",
    decision: "Edges 是贯穿 L0-L3 的关系层，不作为独立 L4 页面。",
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
    title: "微信讨论 Recall 记忆系统分层",
    summary: "讨论如何让 L0 只做识别，后续逐层沉淀为片段、记忆原子和长期对象。",
    category: "work",
    projectIds: ["project_recall"],
    projectNames: ["Recall 记忆系统重构"],
    highlights: ["L0 降低判断负担", "关系层用 Edges 承接证据链", "保留完整证据链", "前台使用自然语言"],
    generatedTasks: ["收束 L0 为低判断观察层"],
    generatedDecisions: ["Edges 不作为 L4 页面"],
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
    title: "确认 L0 批量观察边界",
    reason: "微信讨论里明确担心 L0 一旦失败会影响后续全部层级。",
    suggestedNextAction: "先用 6 帧批量观察验证低判断输出。",
    priority: "high",
    projectName: "Recall 记忆系统重构",
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
  overview: "今天把 Recall 记忆系统从一次性识别，重新拆成可追溯、可重试的分层链路。",
  mainThreads: ["重新定义 L0-L3", "确认前台页面入口"],
  meaningfulProgress: ["明确 L0 只保存观察", "确认待收尾页面定位"],
  unfinished: [
    {
      text: "继续验证真实运行态数据流",
      suggestedNextAction: "跑 Electron 前台 smoke",
      sourceTimelineBlockIds: ["block_wechat_memory"],
      sourceFactIds: ["fact_task"],
    },
  ],
  worthRemembering: [
    {
      text: "前台应忠实记录，不提前做对外降级。",
      reason: "这是产品呈现原则。",
      sourceFactIds: ["fact_decision"],
    },
  ],
  tomorrowStartHere: ["从真实 UI 验证开始"],
  createdAt: now,
  updatedAt: now,
};

const workReport = {
  id: "work_report_today",
  dateKey,
  title: "工作日报",
  plainText: "今日完成 Recall 记忆系统分层重构方案与前台入口验证。",
  sections: {
    completed: ["完成 L0-L3 分层方案"],
    projectProgress: ["打通片段、事实、对象与关系层"],
    risks: ["真实模型输出仍需继续观察"],
    tomorrowPlan: ["继续做运行态验证"],
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
    onStatusChanged: () => () => undefined,
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
          title: "微信讨论 Recall 记忆系统分层",
          summary: "L0 到 L3 的分层记忆链路。",
          createdAt: now,
          projectName: "Recall 记忆系统重构",
          projectId: "project_recall",
          sourceType: "scene",
          sourceId: "scene_wechat_memory",
        },
      ],
      total: 1,
    }),
    updateFact: async () => ({ ok: true }),
    updateTask: async () => ({ ok: true }),
    deleteObject: async () => ({ ok: true }),
    ask: async () => ({ ok: true, answer: "基于记录，今天重点是 L0-L3 分层。", sources: [], searchCount: 1 }),
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
    list: async () => ({ ok: true, data: unfinishedThreads }),
    updateStatus: async () => ({ ok: true }),
  },
  debug: {
    listJobs: async () => ({ ok: true, jobs: [] }),
    getJobDetails: async () => ({ ok: true, job: null }),
    getRelatedRecords: async () => ({ ok: true, data: {} }),
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
  throw new Error(`Timed out waiting for text: ${text}\nCurrent text:\n${bodyText.slice(0, 2000)}`);
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
  await assertTexts(win, ["工作片段 (1)", "scene_wechat_memory", "记忆线索 (2)", "fact_task", "活动瞬间 (6)", "obs_1"]);
  await clickByLabel(win, "关闭");

  await clickByLabel(win, "待收尾");
  await assertTexts(win, ["待收尾", "确认 L0 批量观察边界", "先用 6 帧批量观察验证低判断输出"]);
  await clickByLabel(win, "查看来源");
  await assertTexts(win, ["来源", "需要把 L0 先稳定为低判断观察层"]);
  await clickByLabel(win, "关闭");

  await clickByLabel(win, "项目");
  await assertTexts(win, ["项目", "Recall 记忆系统重构", "查看项目"]);
  await clickByLabel(win, "查看项目");
  await assertTexts(win, ["最近时间轴", "关键决策", "相关人物", "Edges 是贯穿 L0-L3 的关系层"]);

  await clickByLabel(win, "人物");
  await assertTexts(win, ["人物", "张三", "相关项目"]);
  await clickByLabel(win, "张三");
  await assertTexts(win, ["最近协作", "提到过的事", "需要把 L0 先稳定为低判断观察层"]);

  await clickByLabel(win, "记忆库");
  await assertTexts(win, ["记忆库", "帮你找回过去的工作、资料、决策或人", "问回声"]);

  await clickByLabel(win, "报告");
  await assertTexts(win, ["报告", "我的复盘", "工作日报", "今天把 Recall 记忆系统"]);
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
