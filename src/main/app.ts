// src/main/app.ts
// Electron 主进程入口（来自 06_TECHNICAL_ARCHITECTURE.md）
//
// 职责：
// - 创建 BrowserWindow
// - 维护全局 AppStatus
// - 注册 IPC handlers
// - 托盘骨架（暂停/恢复/显示主界面）
// - 后台常驻能力
//
// 严格约束（来自 spec）：
// - API Key 不进 renderer/SQLite/日志
// - Renderer 不能直接调用模型、写 SQLite、访问截图真实路径
// - 所有 main 进程通过 IPC 与 renderer 通信

import { app, BrowserWindow, powerMonitor } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc/handlers";
import type { AppStatus } from "../shared/types";
import { APP_NAME_ZH } from "../shared/constants";
import { getDatabase, closeDatabase } from "./db/Database";
import { SettingsRepository } from "./db/repositories/SettingsRepository";
import { ModelJobRepository } from "./db/repositories/ModelJobRepository";
import { ObservationRepository } from "./db/repositories/ObservationRepository";
import { FactRepository } from "./db/repositories/FactRepository";
import { SceneRepository } from "./db/repositories/SceneRepository";
import { MemoryObjectRepository } from "./db/repositories/MemoryObjectRepository";
import { ProactiveItemRepository } from "./db/repositories/ProactiveItemRepository";
import { ReportRepository } from "./db/repositories/ReportRepository";
import { SecretService } from "./services/SecretService";
import { SettingsService } from "./services/SettingsService";
import { ModelGateway } from "./services/ModelGateway";
import { ActivityService } from "./services/ActivityService";
import { CaptureService } from "./services/CaptureService";
import { PrivacyGuard } from "./services/PrivacyGuard";
import { ScreenshotCache } from "./services/ScreenshotCache";
import { getModelJobQueue } from "./services/ModelJobQueue";
import { ObserverWorker } from "./services/ObserverWorker";
import { ObservationNormalizer } from "./services/ObservationNormalizer";
import { ExtractorWorker } from "./services/ExtractorWorker";
import { LinkerWorker } from "./services/LinkerWorker";
import { SceneBuilderWorker } from "./services/SceneBuilderWorker";
import { JudgeWorker } from "./services/JudgeWorker";
import { ReporterWorker } from "./services/ReporterWorker";
import { ReportScheduler } from "./services/ReportScheduler";
import { SceneScheduler } from "./services/SceneScheduler";
import { CAPTURE_CANDIDATE_EVENT } from "./services/ActivityService";
import { MemoryPipeline, setMemoryPipeline } from "./services/MemoryPipeline";
import { logger } from "./services/Logger";
import { trayService } from "./services/TrayService";
import { startScreenshotCacheScheduler, stopScreenshotCacheScheduler } from "./services/ScreenshotCacheScheduler";

// 本项目 tsconfig 编译为 CommonJS，__dirname 在编译产物中可用

// ============================================================================
// 应用退出标志
// 由 TrayService 管理：当用户从托盘菜单"退出"时设置为 true，让 close handler 不再拦截
// ============================================================================
let isQuitting = false;

// ============================================================================
// AppStatus 全局状态
// ============================================================================

function createInitialAppStatus(): AppStatus {
  return {
    observing: false,
    paused: false,
    pipelineState: "idle",
  };
}

let appStatus: AppStatus = createInitialAppStatus();
const statusListeners = new Set<(status: AppStatus) => void>();

function getStatus(): AppStatus {
  // 返回副本，避免外部误改
  return { ...appStatus, currentWindow: appStatus.currentWindow ? { ...appStatus.currentWindow } : undefined };
}

function setStatus(patch: Partial<AppStatus>): void {
  appStatus = { ...appStatus, ...patch };
  // 推送给所有订阅者（renderer 通过 app:statusChanged channel 接收）
  for (const listener of statusListeners) {
    try {
      listener(appStatus);
    } catch {
      // 单个 listener 报错不影响其他 listener
    }
  }
}

function subscribeStatus(listener: (status: AppStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

// ============================================================================
// BrowserWindow
// ============================================================================

let mainWindow: BrowserWindow | null = null;
// tray 由 TrayService 单例管理，不再需要模块级变量

// ============================================================================
// M3/M4 服务实例
// ============================================================================

let activityService: ActivityService | null = null;
let captureService: CaptureService | null = null;
let privacyGuard: PrivacyGuard | null = null;
let screenshotCache: ScreenshotCache | null = null;
let observationRepo: ObservationRepository | null = null;
// 提升到模块级，让 startObserving 等函数能访问（原为 whenReady 内局部变量）
let settingsService: SettingsService | null = null;
// 提升到模块级，用于启动时清理卡死任务
let modelJobRepo: ModelJobRepository | null = null;
// M4：Pipeline 相关实例
let memoryPipeline: MemoryPipeline | null = null;
// M6：报告调度器
let reportScheduler: ReportScheduler | null = null;
// 长会话场景调度器（C-3 修复：触发 long_session capture bundle）
let sceneScheduler: SceneScheduler | null = null;

function isDev(): boolean {
  return process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL;
}

// ============================================================================
// 观察启停控制（M3）
// ============================================================================

/**
 * 启动观察
 * - 启动 ActivityService（监听窗口 + idle 检测 + 触发事件）
 * - 启动 CaptureService（订阅 ActivityService 事件 + 截图）
 * - 设置 isPaused = false
 * - 更新 AppStatus
 *
 * 注意：settings.observation.enabled 在原版中未被 startObserving 检查。
 * 该字段当前仅作为设置项存在（SettingsPage 可切换），语义待产品层面重新定义。
 * 在此处检查会导致 settings 默认 enabled=false 时无法启动观察，
 * 且 lastError 会被前台 TodayPage 误判为"模型连接失败"。
 */
function startObserving(): void {
  if (!activityService || !captureService) return;

  captureService.setPaused(false);
  if (!activityService.isObserving()) {
    activityService.start();
  }
  captureService.start();
  // 启动长会话场景调度器（暂停时停止，恢复时重启）
  sceneScheduler?.start();

  setStatus({ observing: true, paused: false, pipelineState: "observing", lastError: undefined });
}

/**
 * 暂停观察
 * - 设置 isPaused = true（CaptureService 不再处理 capture-candidate 事件）
 * - 停止 ActivityService（不再发出事件，不补采暂停期间内容）
 * - 停止 CaptureService（取消订阅）
 * - 停止 SceneScheduler（不再触发 long_session）
 * - 正在进行的截图任务可完成，但不再新增
 * - 更新 AppStatus
 */
function pauseObserving(): void {
  if (!activityService || !captureService) return;

  captureService.setPaused(true);
  activityService.stop();
  captureService.stop();
  sceneScheduler?.stop();

  setStatus({ observing: false, paused: true, pipelineState: "idle" });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: `${APP_NAME_ZH} Recall`,
    backgroundColor: "#F7F6F2",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 启动后再显示，避免白屏
  win.once("ready-to-show", () => {
    win.show();
  });

  // 关闭时隐藏到托盘而不是退出（后台常驻）
  // TrayService 通过 isQuitting 标志判断是否真正退出
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  // 加载 renderer
  if (isDev() && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    // 开发期自动打开 DevTools
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // 生产环境加载打包后的 index.html
    const indexHtml = path.join(__dirname, "..", "renderer", "index.html");
    void win.loadFile(indexHtml);
  }

  return win;
}

// ============================================================================
// 托盘服务初始化（M9：使用 TrayService 抽象）
// ============================================================================

function initTray(): void {
  trayService.init({
    getStatus,
    startObserving,
    pauseObserving,
    getMainWindow: () => mainWindow,
    createMainWindow: () => {
      mainWindow = createMainWindow();
      return mainWindow;
    },
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
}

// ============================================================================
// 应用生命周期
// ============================================================================

// 防止多实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// Electron 会在所有窗口关闭时退出；本应用需要后台常驻，所以拦截
// 注意：window-all-closed 回调签名在 Electron 中不接受 event 参数
app.on("window-all-closed", () => {
  // 不调用 app.quit()，保持后台常驻
  // 用户通过托盘菜单"退出"才会真正退出
});

app.whenReady().then(async () => {
  // 初始化日志系统（必须在 app.whenReady 之后调用，依赖 app.getPath）
  logger.init();
  logger.info({ message: "Recall app starting" });

  // 初始化数据库与服务
  const db = getDatabase();
  const settingsRepo = new SettingsRepository(db);
  // 注意：modelJobRepo 提升为模块级变量（用于启动时清理卡死任务）
  modelJobRepo = new ModelJobRepository(db);
  const obsRepo = new ObservationRepository(db);
  observationRepo = obsRepo;
  const secretService = new SecretService();
  // 注意：settingsService 提升为模块级变量（让 startObserving 能检查 observation.enabled）
  settingsService = new SettingsService(settingsRepo, secretService);
  settingsService.init();

  // 启动时清理：把上次进程异常退出留下的 status='running' 卡死任务标记为 failed
  // 修复：原版未清理，导致 model_jobs 表中有 2 条任务永远停留在 running 状态
  try {
    const cleaned = modelJobRepo.markStaleRunningJobs();
    if (cleaned > 0) {
      logger.warn({
        message: `启动时清理 ${cleaned} 个卡死的 running 任务`,
      });
    }
  } catch {
    // 清理失败不阻断启动
  }

  // ModelGateway：统一调用 OpenAI-compatible endpoint
  const modelGateway = new ModelGateway({
    settingsService,
    secretService,
    modelJobRepo,
  });

  // -------- M3 服务初始化 --------
  // PrivacyGuard：注入 SettingsService 用于加载 privacy_rules
  privacyGuard = new PrivacyGuard();
  privacyGuard.setSettingsService(settingsService);
  privacyGuard.reloadRules();

  // ScreenshotCache：注入 ObservationRepository 用于更新 screenshot_retention
  screenshotCache = new ScreenshotCache();
  screenshotCache.setObservationRepository(obsRepo);

  // 应用启动时清理过期截图（按 settings 中的 retention policy）
  try {
    const settings = settingsService.getAll();
    await screenshotCache.cleanupExpired(settings.screenshot.retentionPolicy);
  } catch {
    // 清理失败不阻断启动
  }

  // ActivityService：从 SettingsService 读取观察阈值配置
  const obsSettings = settingsService.getAll().observation;
  activityService = new ActivityService({
    activeWindowStableSeconds: obsSettings.activeWindowStableSeconds,
    contentChangeMinIntervalSeconds: obsSettings.contentChangeMinIntervalSeconds,
    longSessionIntervalMinutes: obsSettings.longSessionIntervalMinutes,
    idleThresholdSeconds: obsSettings.idleThresholdSeconds,
  });

  // CaptureService：注入所有依赖
  captureService = new CaptureService();
  captureService.setDependencies({
    activityService,
    privacyGuard,
    screenshotCache,
    settingsService,
  });

  // -------- M4 Pipeline 初始化 --------
  // 1. 创建 L0-L3 Repositories
  const factRepo = new FactRepository(db);
  const sceneRepo = new SceneRepository(db);
  const memoryObjectRepo = new MemoryObjectRepository(db);
  const proactiveItemRepo = new ProactiveItemRepository(db);

  // 2. ModelJobQueue 单例（视觉任务并发 1-2，LLM 串行）
  const modelJobQueue = getModelJobQueue(modelJobRepo);

  // 3. 创建 5 个 Worker + ObservationNormalizer
  const observerWorker = new ObserverWorker({
    modelGateway,
    modelJobQueue,
  });
  const normalizer = new ObservationNormalizer({
    observationRepo: obsRepo,
    privacyGuard,
  });
  const extractorWorker = new ExtractorWorker({
    modelGateway,
    modelJobQueue,
    factRepo,
    observationRepo: obsRepo,
    memoryObjectRepo,
    settingsService,
  });
  const linkerWorker = new LinkerWorker({
    modelGateway,
    modelJobQueue,
    memoryObjectRepo,
    sceneRepo,
    proactiveItemRepo,
    factRepo,
    settingsService,
  });
  const sceneBuilderWorker = new SceneBuilderWorker({
    modelGateway,
    modelJobQueue,
    sceneRepo,
    factRepo,
    memoryObjectRepo,
  });
  const judgeWorker = new JudgeWorker({
    modelGateway,
    modelJobQueue,
    proactiveItemRepo,
    sceneRepo,
    memoryObjectRepo,
    factRepo,
    settingsService,
  });

  // 4. 创建 MemoryPipeline 协调器
  memoryPipeline = new MemoryPipeline({
    observerWorker,
    normalizer,
    extractorWorker,
    linkerWorker,
    sceneBuilderWorker,
    judgeWorker,
    modelJobQueue,
    sceneRepo,
    factRepo,
    settingsService,
  });
  // 注册为单例（IPC handlers 和其他服务可通过 getMemoryPipeline() 访问）
  setMemoryPipeline(memoryPipeline);
  // 注入 AppStatus 更新回调
  memoryPipeline.setStatusCallback(setStatus);

  // -------- M6 Reporter + Scheduler 初始化 --------
  // ReportRepository：报告数据访问
  const reportRepo = new ReportRepository(db);

  // ReporterWorker：日报/周报生成
  const reporterWorker = new ReporterWorker({
    modelGateway,
    modelJobQueue,
    reportRepo,
    sceneRepo,
    factRepo,
    memoryObjectRepo,
    proactiveItemRepo,
    settingsService,
  });

  // ReportScheduler：定时调度日报/周报生成
  reportScheduler = new ReportScheduler({
    reporterWorker,
    settingsService,
  });
  reportScheduler.start();

  // 5. 订阅 CaptureService 的 capture-bundle 事件
  //    - 每当 CaptureService 成功捕获一个 bundle，触发 AI Pipeline 处理
  //    - 失败不阻断 capture 流程（pipeline 内部 try/catch）
  //    - 暂停状态由 CaptureService.setPaused 控制（暂停时不再 emit capture-bundle）
  captureService.on("capture-bundle", (bundle) => {
    if (!memoryPipeline) return;
    // 异步处理，不阻塞 EventEmitter
    memoryPipeline.processCaptureBundle(bundle).catch(() => {
      // pipeline 单次失败不阻断后续捕获
    });
  });

  // 6. 创建 SceneScheduler（C-3 修复：长会话触发 long_session capture bundle）
  //    - 监听 ActivityService 的 capture-candidate 事件，更新窗口/项目状态
  //    - 同一窗口/项目持续工作 >= longSessionIntervalMinutes 时发出 long_session bundle
  //    - 该 bundle 直接交给 MemoryPipeline 处理（不经过 CaptureService，无截图）
  sceneScheduler = new SceneScheduler({
    settingsService,
    activityService,
    emitCaptureBundle: (bundle) => {
      if (!memoryPipeline) return;
      memoryPipeline.processCaptureBundle(bundle).catch(() => {
        // pipeline 单次失败不阻断后续调度
      });
    },
  });
  // 订阅 ActivityService 的 capture-candidate 事件，转发给 SceneScheduler 更新状态
  // 仅在窗口/项目变化时更新（window_focus_changed / project_switch / scene_boundary）
  activityService.on(CAPTURE_CANDIDATE_EVENT, (event) => {
    sceneScheduler?.updateActivity({
      windowId: event.window.windowId,
      projectName: event.window.appName,
    });
  });

  mainWindow = createMainWindow();
  // 初始化托盘服务（M9：抽象到 TrayService，支持双击显示/动态菜单）
  initTray();

  // 启动截图缓存定时清理（每小时检查一次过期截图，来自 06 文档"性能原则"）
  startScreenshotCacheScheduler({
    screenshotCache,
    settingsService,
    intervalMs: 60 * 60 * 1000, // 1 小时
  });

  // 注册 IPC handlers（注入 M4 repos 用于真实查询）
  registerIpcHandlers({
    getStatus,
    setStatus,
    subscribeStatus,
    getMainWindow: () => mainWindow,
    settingsService,
    modelGateway,
    // M8 新增：SecretService 用于 model:saveConfig 时写入 API Key
    secretService,
    privacyGuard,
    screenshotCache,
    observationRepo: obsRepo,
    factRepo,
    sceneRepo,
    memoryObjectRepo,
    proactiveItemRepo,
    reportRepo,
    reporterWorker,
    reportScheduler,
    activityService,
    captureService,
    startObserving,
    pauseObserving,
    // M8 新增：DB 实例用于 data:clearAll 等批量操作
    db,
  });

  // AppStatus 变化时主动推送给 renderer，并刷新托盘菜单
  subscribeStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("app:statusChanged", status);
    }
    // 状态变化后刷新托盘菜单（暂停/恢复文案切换）
    trayService.updateMenu();
  });

  // 监听系统锁屏/解锁事件，更新 AppStatus（不采集锁屏期间内容）
  powerMonitor.on("lock-screen", () => {
    setStatus({ pipelineState: "idle" });
  });
  powerMonitor.on("unlock-screen", () => {
    // 解锁后不自动启动观察，等待用户操作
  });

  // macOS 重新激活时重建窗口（Windows 不会触发，但保留兼容）
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

// 应用退出前清理
app.on("before-quit", () => {
  isQuitting = true;
  trayService.notifyQuitting();
  logger.info({ message: "Recall app quitting" });
  // 停止截图缓存定时清理
  stopScreenshotCacheScheduler();
  // 停止 M3 服务
  try {
    activityService?.stop();
    captureService?.stop();
    sceneScheduler?.stop();
  } catch {
    // 退出时忽略错误
  }
  // 销毁托盘
  trayService.destroy();
  closeDatabase();
});
