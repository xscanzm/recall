import type {
  AppStatus,
  PersonalReview,
  TodayPageData,
  TodayTimelineProjection,
  UnfinishedThread,
  WorkReport,
} from "../../src/shared/types";

const demoDate = new Date();
export const demoDateKey = [
  demoDate.getFullYear(),
  String(demoDate.getMonth() + 1).padStart(2, "0"),
  String(demoDate.getDate()).padStart(2, "0"),
].join("-");
export const demoDateLabel = `${demoDate.getMonth() + 1} 月 ${demoDate.getDate()} 日`;
const atTime = (time: string) => `${demoDateKey}T${time}:00`;

export const demoAppStatus: AppStatus = {
  observing: true,
  paused: false,
  pipelineState: "observing",
  currentWindow: {
    appName: "Visual Studio Code",
    windowTitle: "Recall 品牌网站",
    privacyState: "allowed",
  },
};

export const demoTimeline: TodayTimelineProjection[] = [
  {
    id: "demo-release",
    dateKey: demoDateKey,
    startAt: atTime("16:20"),
    endAt: atTime("17:35"),
    title: "完成网站的产品演示内容",
    summary: "把真实产品界面接入品牌网站，补齐隐私说明与下载前须知，并检查不同尺寸下的呈现。",
    category: "design",
    projectIds: ["project-recall"],
    projectNames: ["Recall 公开测试版"],
    highlights: ["产品展示改为真实界面与隔离演示数据", "完成桌面端首屏的发布检查"],
    generatedTasks: ["检查移动端首页", "确认下载链接和版本说明"],
    generatedDecisions: ["宣传素材不使用个人真实数据"],
    reportable: true,
    privateRisk: "low",
    sourceSceneIds: ["scene-release"],
    sourceFactIds: ["fact-release"],
    sourceObservationIds: ["observation-release"],
    confidence: 0.96,
  },
  {
    id: "demo-copy",
    dateKey: demoDateKey,
    startAt: atTime("14:05"),
    endAt: atTime("15:35"),
    title: "把功能写成用户真正关心的事",
    summary: "重写首页叙事，不再罗列技术名词，而是讲清楚一天如何被接住、整理并在需要时重新找到。",
    category: "writing",
    projectIds: ["project-recall"],
    projectNames: ["Recall 公开测试版"],
    highlights: ["确定首屏主张：让认真度过的一天，被好好记住"],
    generatedTasks: [],
    generatedDecisions: ["从用户的一天出发，而不是从自动截图能力出发"],
    reportable: true,
    privateRisk: "low",
    sourceSceneIds: ["scene-copy"],
    sourceFactIds: ["fact-copy"],
    sourceObservationIds: ["observation-copy"],
    confidence: 0.94,
  },
  {
    id: "demo-scope",
    dateKey: demoDateKey,
    startAt: atTime("10:30"),
    endAt: atTime("11:25"),
    title: "确认公开测试版发布范围",
    summary: "整理 Windows 首发版本的功能边界、模型配置要求和公开反馈渠道。",
    category: "focus_work",
    projectIds: ["project-recall"],
    projectNames: ["Recall 公开测试版"],
    highlights: ["首发支持 Windows x64", "下载前明确说明需自备模型服务"],
    generatedTasks: ["补齐安装包版本说明"],
    generatedDecisions: [],
    reportable: true,
    privateRisk: "low",
    sourceSceneIds: ["scene-scope"],
    sourceFactIds: ["fact-scope"],
    sourceObservationIds: ["observation-scope"],
    confidence: 0.91,
  },
  {
    id: "demo-research",
    dateKey: demoDateKey,
    startAt: atTime("09:10"),
    endAt: atTime("10:05"),
    title: "回看昨天留下的首页思路",
    summary: "找回前一天关于品牌表达的讨论和草稿，从已经想清楚的地方继续。",
    category: "research",
    projectIds: ["project-recall"],
    projectNames: ["Recall 公开测试版"],
    highlights: ["找回三条昨天未完成的叙事线索"],
    generatedTasks: [],
    generatedDecisions: [],
    reportable: false,
    privateRisk: "low",
    sourceSceneIds: ["scene-research"],
    sourceFactIds: ["fact-research"],
    sourceObservationIds: ["observation-research"],
    confidence: 0.89,
  },
];

export const demoThreads: UnfinishedThread[] = [
  {
    id: "thread-mobile",
    title: "检查移动端首页",
    reason: "桌面布局已经完成，发布前还没有确认窄屏下的按钮和长标题。",
    suggestedNextAction: "用手机尺寸检查首屏和下载按钮",
    priority: "high",
    projectName: "Recall 公开测试版",
    lastSeenAt: atTime("17:35"),
    sourceFactIds: ["fact-release"],
    sourceTimelineBlockIds: ["demo-release"],
    confidence: 0.95,
    status: "open",
  },
  {
    id: "thread-download",
    title: "确认下载链接和版本说明",
    reason: "发布清单中仍缺少最终安装包地址和校验信息。",
    suggestedNextAction: "核对 GitHub Release 中的安装包与版本号",
    priority: "medium",
    projectName: "Recall 公开测试版",
    lastSeenAt: atTime("16:50"),
    sourceFactIds: ["fact-scope"],
    sourceTimelineBlockIds: ["demo-scope"],
    confidence: 0.92,
    status: "open",
  },
];

export const demoReview: PersonalReview = {
  id: "review-demo",
  dateKey: demoDateKey,
  title: `${demoDateLabel}复盘`,
  overview: "今天主要围绕 Recall 公开测试版发布展开：讲清产品价值，完成真实界面展示，并把隐私边界放到用户看得见的地方。",
  mainThreads: ["品牌网站叙事", "真实产品展示", "公开测试版发布准备"],
  meaningfulProgress: ["完成品牌网站首屏与产品演示", "明确下载前须知和隐私说明"],
  unfinished: demoThreads.map((thread) => ({
    text: thread.title,
    suggestedNextAction: thread.suggestedNextAction,
    sourceTimelineBlockIds: thread.sourceTimelineBlockIds,
    sourceFactIds: thread.sourceFactIds,
  })),
  worthRemembering: [
    {
      text: "宣传内容应该真实，但不应该以暴露个人数据为代价。",
      reason: "这成为之后制作所有产品素材的共同原则。",
      sourceFactIds: ["fact-release"],
    },
  ],
  tomorrowStartHere: ["先检查移动端首页", "再确认下载链接与版本说明"],
};

export const demoWorkReport: WorkReport = {
  id: "report-demo",
  dateKey: demoDateKey,
  title: `${demoDateLabel}工作日报`,
  plainText: "完成 Recall 品牌网站首屏、真实产品界面展示及隐私说明，公开测试版发布准备继续推进。",
  sections: {
    completed: ["完成品牌网站首屏和真实产品界面展示", "补齐隐私说明与使用前须知"],
    projectProgress: ["Recall 公开测试版已进入发布前检查"],
    risks: ["移动端显示和最终下载链接仍需确认"],
    tomorrowPlan: ["完成多尺寸验收并核对 Release 信息"],
  },
  sourceTimelineBlockIds: demoTimeline.filter((item) => item.reportable).map((item) => item.id),
  sourceFactIds: ["fact-release", "fact-copy", "fact-scope"],
  omittedForPrivacy: 0,
  warnings: [],
};

export const demoTodayPageData: TodayPageData = {
  dateKey: demoDateKey,
  appStatus: demoAppStatus,
  dayMainThread: demoReview.overview,
  timelineBlocks: demoTimeline,
  unfinishedThreads: demoThreads,
  highlights: demoTimeline.flatMap((block, blockIndex) =>
    block.highlights.map((content, index) => ({ id: `highlight-${blockIndex}-${index}`, content })),
  ),
  decisions: demoTimeline.flatMap((block, blockIndex) =>
    block.generatedDecisions.map((content, index) => ({ id: `decision-${blockIndex}-${index}`, content })),
  ),
  personalReview: demoReview,
  workReport: demoWorkReport,
  tomorrowStartHere: demoReview.tomorrowStartHere,
};
