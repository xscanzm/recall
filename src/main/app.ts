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

import { app, BrowserWindow, dialog, powerMonitor } from "electron";
import * as path from "node:path";
import { registerIpcHandlers } from "./ipc/handlers";
import type { AppStatus, ReportGeneratedEvent } from "../shared/types";
import { APP_NAME_ZH } from "../shared/constants";
import { getDatabase, closeDatabase } from "./db/Database";
import { MemorySearchRepository } from "./db/repositories/MemorySearchRepository";
import { MemoryEmbeddingRepository } from "./db/repositories/MemoryEmbeddingRepository";
import { EmbeddingWorkerClient } from "./services/EmbeddingWorkerClient";
import { EmbeddingIndexerService } from "./services/EmbeddingIndexerService";
import { HybridSearchService } from "./services/HybridSearchService";
import { CorrectionLifecycleRepository } from "./db/repositories/CorrectionLifecycleRepository";
import { SettingsRepository } from "./db/repositories/SettingsRepository";
import { ModelJobRepository } from "./db/repositories/ModelJobRepository";
import { ObservationRepository } from "./db/repositories/ObservationRepository";
import { FactRepository } from "./db/repositories/FactRepository";
import { SceneRepository } from "./db/repositories/SceneRepository";
import { MemoryObjectRepository } from "./db/repositories/MemoryObjectRepository";
import { ProactiveItemRepository } from "./db/repositories/ProactiveItemRepository";
import { ReportRepository } from "./db/repositories/ReportRepository";
import { TimelineBlockRepository } from "./db/repositories/TimelineBlockRepository";
import { ReportSelectionRepository } from "./db/repositories/ReportSelectionRepository";
import { UnfinishedThreadRepository } from "./db/repositories/UnfinishedThreadRepository";
import { createObjectMergeRepository } from "./db/repositories/ObjectMergeRepository";
import { createMemoryEdgeRepository } from "./db/repositories/MemoryEdgeRepository";
import { CaptureInboxRepository } from "./db/repositories/CaptureInboxRepository";
import { TimelineGenerationWindowRepository } from "./db/repositories/TimelineGenerationWindowRepository";
import { SecretService } from "./services/SecretService";
import { migrateKeytarSecrets } from "./services/secretsMigration";
import { SettingsService } from "./services/SettingsService";
import { ModelGateway } from "./services/ModelGateway";
import { DefaultModelConsentService } from "./services/DefaultModelConsentService";
import { InstallationIdentityService } from "./services/InstallationIdentityService";
import { ActivityService } from "./services/ActivityService";
import { CaptureService } from "./services/CaptureService";
import { WindowFrameGrabber } from "./services/WindowFrameGrabber";
import { PrivacyGuard } from "./services/PrivacyGuard";
import { ScreenshotCache } from "./services/ScreenshotCache";
import { getModelJobQueue, type ModelJobQueue } from "./services/ModelJobQueue";
import { ObserverExtractorWorker } from "./services/ObserverExtractorWorker";
import { ObservationNormalizer } from "./services/ObservationNormalizer";
import { LinkerSceneJudgeWorker } from "./services/LinkerSceneJudgeWorker";
import { MemoryObjectAdmissionService } from "./services/MemoryObjectAdmissionService";
import { EpisodeFactExtractorWorker } from "./services/EpisodeFactExtractorWorker";
import { ReporterWorker } from "./services/ReporterWorker";
import { ReportScheduler } from "./services/ReportScheduler";
import { TimelineBuilderWorker } from "./services/TimelineBuilderWorker";
import { TimelineWindowCoordinator } from "./services/TimelineWindowCoordinator";
import { TimelineBuildCheckpointRepository } from "./db/repositories/TimelineBuildCheckpointRepository";
import { PersonalReviewWriterWorker } from "./services/PersonalReviewWriterWorker";
import { WorkReportWriterWorker } from "./services/WorkReportWriterWorker";
import { InfographicService } from "./services/InfographicService";
import { EndOfDayReviewService } from "./services/EndOfDayReviewService";
import { SceneScheduler } from "./services/SceneScheduler";
import { CaptureBatcher } from "./services/CaptureBatcher";
import { RapidOcrService } from "./services/RapidOcrService";
import { WindowsOcrService } from "./services/WindowsOcrService";
import type { ManagedOcrBatchService } from "./services/OcrService";
import { BatchProcessor } from "./services/BatchProcessor";
import { DataLifecycleService } from "./services/DataLifecycleService";
import { ProjectionInvalidationProcessor } from "./services/ProjectionInvalidationProcessor";
import { SceneRelationProjector } from "./services/SceneRelationProjector";
import {
  CAPTURE_CANDIDATE_EVENT,
  IDLE_STATE_CHANGED_EVENT,
  type IdleStateChangedEvent,
} from "./services/ActivityService";
import { MemoryPipeline, setMemoryPipeline } from "./services/MemoryPipeline";
import { logger } from "./services/Logger";
import { cascadeMarkAfterFactSceneDelete } from "./services/cascadeMark";
import { trayService } from "./services/TrayService";
import { startScreenshotCacheScheduler, stopScreenshotCacheScheduler } from "./services/ScreenshotCacheScheduler";
import { UpdateService } from "./services/UpdateService";
import { startUpdateCheckerScheduler, stopUpdateCheckerScheduler } from "./services/UpdateCheckerScheduler";
import { shutdownRuntime } from "./services/shutdownRuntime";
import { installNavigationGuards, type NavigationPolicy } from "./services/navigationGuard";
import type { Report } from "./models/types";

// 本项目 tsconfig 编译为 CommonJS，__dirname 在编译产物中可用

// ============================================================================
// Chromium 抓图后端选择（Windows）
//
// 必须在 app.whenReady() 之前执行，命令行开关在 Chromium 初始化后再改无效，
// 所以放在模块顶层而不是任何 ready 回调里。
//
// 为什么要动这个：Windows 上 Chromium 默认用 GDI PrintWindow(PW_RENDERFULLCONTENT)
// 抓窗口，它会向目标窗口发 WM_PRINT/WM_PRINTCLIENT，在**对方进程的 UI 线程**上
// 强制同步渲染一次。对钉钉这类 Chromium 套壳 + GPU 合成 + DirectComposition 的应用，
// 它不真正伺服 WM_PRINT，被打后合成表面可能停在空白态，直到窗口被标脏才重绘 ——
// 表现就是"偶发白屏，切一下窗口就好"。Windows.Graphics.Capture 走 DWM 读现成的
// 合成表面，不发任何消息给目标窗口，从根上消除这个副作用。
//
// 现有那套 analyzeCaptureVisualQuality 全黑退化检测 + screen crop 兜底，正是为了
// 对付 GDI 抓 GPU 合成窗口返回全黑 —— 它的存在本身就说明我们一直跑在 GDI 路径上。
//
// feature 名不是猜的：从 Electron 32.3.3 二进制里 grep 出来确认存在。
// flag 是否真生效也不靠猜：生效时 stderr 会出现 wgc_capture_session.cc 的日志。
// ============================================================================

/**
 * 合并式追加 Chromium feature 开关。
 *
 * 不能直接 appendSwitch("enable-features", x)：这个 API 是覆盖语义，第二次调用会
 * 冲掉第一次的值（也会冲掉用户/打包脚本从命令行传进来的值）。所以先读回来再合并。
 */
function appendChromiumFeatures(switchName: "enable-features" | "disable-features", names: string[]): void {
  const existing = app.commandLine.getSwitchValue(switchName);
  const merged = new Set(existing ? existing.split(",").filter(Boolean) : []);
  for (const name of names) merged.add(name);
  app.commandLine.appendSwitch(switchName, [...merged].join(","));
}

if (process.platform === "win32") {
  appendChromiumFeatures("enable-features", ["AllowWgcWindowCapturer", "AllowWgcScreenCapturer"]);
  // zero-Hz 模式下静止内容不产新帧，我们只抓单帧会一直等不到 frame 回调而超时。
  // 显式关掉，不依赖 Chromium 版本间的默认值差异。
  appendChromiumFeatures("disable-features", ["AllowWgcWindowZeroHz", "AllowWgcScreenZeroHz"]);
}

// ============================================================================
// 应用退出标志
// 由 TrayService 管理：当用户从托盘菜单"退出"时设置为 true，让 close handler 不再拦截
// ============================================================================
let isQuitting = false;
let shutdownStarted = false;

let embeddingIndexerService: EmbeddingIndexerService | undefined;
let embeddingWorkerClient: EmbeddingWorkerClient | undefined;

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
/** Renderer 尚未完成加载时暂存的报告生成事件，避免启动补跑丢失未读提醒。 */
let pendingReportGeneratedEvents: ReportGeneratedEvent[] = [];
/** 收工回顾服务创建前暂存的报告桌面卡片，避免启动补跑丢失弹窗。 */
let pendingReportNotifications: ReportGeneratedEvent[] = [];
let defaultModelConsentRequested = false;
// tray 由 TrayService 单例管理，不再需要模块级变量

// ============================================================================
// M3/M4 服务实例
// ============================================================================

let activityService: ActivityService | null = null;
let captureService: CaptureService | null = null;
let windowFrameGrabber: WindowFrameGrabber | null = null;
let privacyGuard: PrivacyGuard | null = null;
let screenshotCache: ScreenshotCache | null = null;
// 提升到模块级，让 startObserving 等函数能访问（原为 whenReady 内局部变量）
let settingsService: SettingsService | null = null;
// 提升到模块级，用于启动时清理卡死任务
let modelJobRepo: ModelJobRepository | null = null;
// M4：Pipeline 相关实例
let memoryPipeline: MemoryPipeline | null = null;
// M6：报告调度器
let reportScheduler: ReportScheduler | null = null;
let endOfDayReviewService: EndOfDayReviewService | null = null;
// 版本更新服务
let updateService: UpdateService | null = null;
// 长会话场景调度器（C-3 修复：触发 long_session capture bundle）
let sceneScheduler: SceneScheduler | null = null;
// 阶段二：截图攒批合并提交器（12 帧 / 5 分钟超时）
let captureBatcher: CaptureBatcher | null = null;
let ocrService: ManagedOcrBatchService | null = null;
let batchProcessor: BatchProcessor | null = null;
let modelJobQueueForShutdown: ModelJobQueue | null = null;
let timelineWindowCoordinator: TimelineWindowCoordinator | null = null;

function isDev(): boolean {
  return process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL;
}

function shouldAutoOpenDevTools(): boolean {
  const value = (process.env.RECALL_OPEN_DEVTOOLS ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function shouldStartHidden(): boolean {
  return process.argv.includes("--hidden") || process.argv.includes("--background");
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
 * settings.observation.enabled 只控制下次启动时是否自动恢复观察。
 * 手动恢复观察不能改写这项持久化偏好。
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
async function pauseObserving(): Promise<void> {
  if (!activityService || !captureService) return;

  captureService.setPaused(true);
  activityService.stop();
  captureService.stop();
  sceneScheduler?.stop();
  await timelineWindowCoordinator?.finalizeTail("pause");

  setStatus({ observing: false, paused: true, pipelineState: "idle" });
}

const STARTUP_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>回声 Recall</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; }
    body { display: grid; place-items: center; background: #f7f6f2; color: #17332c; font-family: "Microsoft YaHei UI", sans-serif; }
    main { display: flex; align-items: center; gap: 18px; }
    .mark { width: 42px; height: 42px; border: 2px solid #397866; border-radius: 50%; box-sizing: border-box; position: relative; }
    .mark::after { content: ""; position: absolute; inset: 9px; border: 2px solid #7fa295; border-radius: 50%; }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    p { margin: 5px 0 0; color: #668078; font-size: 14px; letter-spacing: 0; }
  </style>
</head>
<body><main><div class="mark"></div><div><h1>回声 Recall</h1><p>正在启动</p></div></main></body>
</html>`;

const STARTUP_PAGE_URL = `data:text/html;charset=UTF-8,${encodeURIComponent(STARTUP_PAGE_HTML)}`;

function loadStartupPage(win: BrowserWindow): Promise<void> {
  return win.loadURL(STARTUP_PAGE_URL);
}

/** 打包后 renderer 根目录：dist/main/app.js → dist/renderer */
function rendererRoot(): string {
  return path.join(__dirname, "..", "renderer");
}

function navigationPolicy(): NavigationPolicy {
  return {
    rendererRoot: rendererRoot(),
    devServerUrl: isDev() ? process.env.VITE_DEV_SERVER_URL : undefined,
    startupUrl: STARTUP_PAGE_URL,
  };
}

function loadMainWindowRenderer(win: BrowserWindow): Promise<void> {
  if (isDev() && process.env.VITE_DEV_SERVER_URL) {
    if (shouldAutoOpenDevTools()) {
      win.webContents.openDevTools({ mode: "detach" });
    }
    return win.loadURL(process.env.VITE_DEV_SERVER_URL);
  }
  const indexHtml = path.join(__dirname, "..", "renderer", "index.html");
  return win.loadFile(indexHtml);
}

function createMainWindow(options: { deferRendererLoad?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: `${APP_NAME_ZH} Recall`,
    backgroundColor: "#F7F6F2",
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  installNavigationGuards(win.webContents, navigationPolicy);

  // 启动后再显示，避免白屏
  win.once("ready-to-show", () => {
    if (!shouldStartHidden() || defaultModelConsentRequested) {
      win.show();
      if (defaultModelConsentRequested) win.focus();
    }
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

  win.webContents.on("did-finish-load", () => {
    if (win.webContents.getURL().startsWith("data:")) return;
    // 给 renderer 一次事件循环完成 IPC 订阅，再补发启动期间的报告事件。
    setTimeout(() => {
      if (mainWindow === win) flushPendingReportGeneratedEvents(win);
      if (mainWindow === win && defaultModelConsentRequested) {
        win.webContents.send("model:defaultConsentRequested");
      }
    }, 0);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error({
      status: "failed",
      errorCode: "renderer_process_gone",
      message: `renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`,
    });
  });

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    logger.error({
      status: "failed",
      errorCode: "renderer_preload_failed",
      message: `renderer preload failed: file=${path.basename(preloadPath)}, name=${error.name}, message=${error.message}`,
    });
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logger.error({
      status: "failed",
      errorCode: "renderer_load_failed",
      message: `renderer load failed: code=${errorCode}, description=${errorDescription}, local=${validatedURL.startsWith("file:")}`,
    });
  });

  if (!options.deferRendererLoad) {
    void loadMainWindowRenderer(win).catch((error) => {
      logger.error({
        status: "failed",
        errorCode: "renderer_load_rejected",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return win;
}

function requestDefaultModelConsent(): void {
  defaultModelConsentRequested = true;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.show();
  win.focus();
  if (!win.webContents.isLoading()) {
    win.webContents.send("model:defaultConsentRequested");
  }
}

function queuePendingReportGeneratedEvent(payload: ReportGeneratedEvent): void {
  pendingReportGeneratedEvents = [
    payload,
    ...pendingReportGeneratedEvents.filter((event) => event.reportId !== payload.reportId),
  ].slice(0, 50);
}

function flushPendingReportGeneratedEvents(win: BrowserWindow): void {
  if (win.isDestroyed() || pendingReportGeneratedEvents.length === 0) {
    return;
  }
  const pending = pendingReportGeneratedEvents;
  pendingReportGeneratedEvents = [];
  for (const payload of pending) {
    try {
      win.webContents.send("reports:generated", payload);
    } catch {
      queuePendingReportGeneratedEvent(payload);
    }
  }
}

function sendReportGeneratedEvent(payload: ReportGeneratedEvent): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isLoading()) {
    queuePendingReportGeneratedEvent(payload);
    return;
  }
  try {
    win.webContents.send("reports:generated", payload);
  } catch {
    queuePendingReportGeneratedEvent(payload);
  }
}

function queueReportNotification(payload: ReportGeneratedEvent): void {
  pendingReportNotifications = [
    payload,
    ...pendingReportNotifications.filter((event) => event.reportId !== payload.reportId),
  ].slice(0, 50);
}

function openReportsFromNotification(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  mainWindow.show();
  mainWindow.focus();
  if (!mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("app:navigate", "reports");
  } else {
    mainWindow.webContents.once("did-finish-load", () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("app:navigate", "reports");
      }
    });
  }
}

function notifyReportGenerated(report: Report): void {
  const payload: ReportGeneratedEvent = {
    reportId: report.id,
    type: report.type,
    title: report.title,
    dateKey: report.dateKey,
  };

  // 正文落库事件独立于信息图，信息图失败也不能影响未读提醒。
  // 窗口尚未加载时先暂存，待 renderer 完成加载后补发。
  sendReportGeneratedEvent(payload);

  // 报告生成是用户明确触发或已配置的自动任务，成功后只提示一次。
  // 复用收工回顾的独立桌面卡片，而不是使用 Windows 原生通知样式。
  try {
    if (endOfDayReviewService) {
      endOfDayReviewService.showReportNotification(payload);
    } else {
      queueReportNotification(payload);
    }
  } catch {
    // 桌面卡片不可用时保留未读事件，不影响正文已成功落库。
    queueReportNotification(payload);
  }
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

  process.on("uncaughtExceptionMonitor", (error, origin) => {
    logger.error({
      status: "failed",
      errorCode: "uncaught_exception",
      message: `uncaught exception: origin=${origin}, name=${error.name}, message=${error.message}`,
    });
  });
  process.on("unhandledRejection", (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({
      status: "failed",
      errorCode: "unhandled_rejection",
      message: `unhandled rejection: name=${error.name}, message=${error.message}`,
    });
  });
  app.on("child-process-gone", (_event, details) => {
    logger.error({
      status: "failed",
      errorCode: "child_process_gone",
      message: `child process gone: type=${details.type}, name=${details.name}, serviceName=${details.serviceName ?? "unknown"}, reason=${details.reason}, exitCode=${details.exitCode}`,
    });
  });

  // 先让窗口完成一次绘制。大库迁移备份和后台修复不能再表现为白屏。
  mainWindow = createMainWindow({ deferRendererLoad: true });
  try {
    await loadStartupPage(mainWindow);
  } catch (error) {
    // 启动占位页不是主体 UI；单独失败时继续加载真实 renderer。
    console.warn(
      "Recall startup placeholder failed to load:",
      error instanceof Error ? error.message : String(error)
    );
  }

  // 初始化数据库与服务
  const db = getDatabase();
  const memorySearchRepo = new MemorySearchRepository(db);
  const memoryEmbeddingRepo = new MemoryEmbeddingRepository(db);
  embeddingWorkerClient = new EmbeddingWorkerClient();
  embeddingIndexerService = new EmbeddingIndexerService(db, memoryEmbeddingRepo, embeddingWorkerClient);
  const hybridSearchService = new HybridSearchService(memorySearchRepo, memoryEmbeddingRepo, embeddingWorkerClient);
  embeddingIndexerService.startBackgroundIndexing();
  const correctionLifecycleRepo = new CorrectionLifecycleRepository(db);
  const settingsRepo = new SettingsRepository(db);
  // 注意：modelJobRepo 提升为模块级变量（用于启动时清理卡死任务）
  modelJobRepo = new ModelJobRepository(db);
  const obsRepo = new ObservationRepository(db);
  const secretService = new SecretService();
  // keytar → safeStorage 一次性迁移。必须在任何模型调用之前跑完，否则老用户
  // 第一次调用会因为读不到 key 而失败。迁移内部吞掉所有异常，不会挡启动。
  await migrateKeytarSecrets({ secretService });
  // 注意：settingsService 提升为模块级变量（让 startObserving 能检查 observation.enabled）
  settingsService = new SettingsService(settingsRepo, secretService);
  settingsService.init();
  // 调试模式：根据设置初始化 Logger devDebug（用户开启后立即生效，无需重启）
  logger.setDevDebug(settingsService.isDebugMode());

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

  const defaultModelConsentService = new DefaultModelConsentService(
    settingsService,
    requestDefaultModelConsent
  );
  const installationIdentityService = new InstallationIdentityService(app.getPath("userData"));

  // ModelGateway：统一调用 OpenAI-compatible endpoint
  const modelGateway = new ModelGateway({
    settingsService,
    secretService,
    modelJobRepo,
    defaultModelConsentService,
    installationIdentityService,
    clientVersion: app.getVersion(),
  });

  // -------- M3 服务初始化 --------
  // PrivacyGuard：注入 SettingsService 用于加载 privacy_rules
  privacyGuard = new PrivacyGuard();
  privacyGuard.setSettingsService(settingsService);
  privacyGuard.reloadRules();

  // ScreenshotCache：注入 ObservationRepository 用于更新 screenshot_retention
  screenshotCache = new ScreenshotCache();
  screenshotCache.setObservationRepository(obsRepo);
  const captureInboxRepo = new CaptureInboxRepository(db);

  // ActivityService：从 SettingsService 读取观察阈值配置
  const obsSettings = settingsService.getAll().observation;
  activityService = new ActivityService({
    activeWindowStableSeconds: obsSettings.activeWindowStableSeconds,
    contentChangeMinIntervalSeconds: obsSettings.contentChangeMinIntervalSeconds,
    longSessionIntervalMinutes: obsSettings.longSessionIntervalMinutes,
    idleThresholdSeconds: obsSettings.idleThresholdSeconds,
  });

  // CaptureService：注入所有依赖
  //
  // windowFrameSource 是首选采集后端：只对目标窗口开一次捕获会话，不去碰系统里
  // 其它窗口。它走不通时 CaptureService 会依次降级到整屏裁剪（带遮挡门禁），
  // 两条都不通就跳过这次采集 —— 不退回会打扰其它应用的旧全窗口路径。
  windowFrameGrabber = new WindowFrameGrabber();
  captureService = new CaptureService();
  captureService.setDependencies({
    activityService,
    privacyGuard,
    screenshotCache,
    settingsService,
    windowFrameSource: windowFrameGrabber,
  });

  // -------- M4 Pipeline 初始化 --------
  // 1. 创建 L0-L3 Repositories
  const factRepo = new FactRepository(db);
  const sceneRepo = new SceneRepository(db);
  const memoryObjectRepo = new MemoryObjectRepository(db);
  const memoryObjectAdmissionService = new MemoryObjectAdmissionService({
    factRepo,
    memoryObjectRepo,
  });
  const proactiveItemRepo = new ProactiveItemRepository(db);
  // Phase 2 新增：TimelineBlock / ReportSelection / UnfinishedThread Repositories
  const timelineBlockRepo = new TimelineBlockRepository(db);
  const timelineWindowRepo = new TimelineGenerationWindowRepository(db);
  const timelineBuildCheckpointRepo = new TimelineBuildCheckpointRepository(db);
  const reportSelectionRepo = new ReportSelectionRepository(db);
  const unfinishedThreadRepo = new UnfinishedThreadRepository(db);
  // 012 新增：ObjectMerge 审计 Repository
  const objectMergeRepo = createObjectMergeRepository(db);
  // 015 新增：记忆关系层 Repository
  const memoryEdgeRepo = createMemoryEdgeRepository(db);

  // 2. ModelJobQueue 单例（多模态统一并发 3）
  const modelJobQueue = getModelJobQueue(modelJobRepo);
  modelJobQueueForShutdown = modelJobQueue;

  // 3. 创建 2 个合并 Worker + ObservationNormalizer
  const observerExtractorWorker = new ObserverExtractorWorker({
    modelGateway,
    modelJobQueue,
    factRepo,
    observationRepo: obsRepo,
    memoryObjectRepo,
    settingsService,
  });
  const normalizer = new ObservationNormalizer({
    observationRepo: obsRepo,
    privacyGuard,
    screenshotCache,
  });
  const linkerSceneJudgeWorker = new LinkerSceneJudgeWorker({
    modelGateway,
    modelJobQueue,
    factRepo,
    sceneRepo,
    memoryObjectRepo,
    proactiveItemRepo,
    edgeRepo: memoryEdgeRepo,
    unfinishedThreadRepo,
    timelineBlockRepo,
    settingsService,
    admissionService: memoryObjectAdmissionService,
  });
  const episodeFactExtractorWorker = new EpisodeFactExtractorWorker({
    modelGateway,
    modelJobQueue,
    factRepo,
    observationRepo: obsRepo,
    sceneRepo,
    memoryObjectRepo,
    settingsService,
  });

  // 4. 创建 MemoryPipeline 协调器
  memoryPipeline = new MemoryPipeline({
    observerExtractorWorker,
    normalizer,
    linkerSceneJudgeWorker,
    episodeFactExtractorWorker,
    modelJobQueue,
    sceneRepo,
    factRepo,
    memoryObjectRepo,
    observationRepo: obsRepo,
    edgeRepo: memoryEdgeRepo,
    settingsService,
    modelJobRepo,
  });
  // 注册为单例（IPC handlers 和其他服务可通过 getMemoryPipeline() 访问）
  setMemoryPipeline(memoryPipeline);
  // 注入 AppStatus 更新回调
  memoryPipeline.setStatusCallback(setStatus);

  // -------- M6 Reporter + Scheduler 初始化 --------
  // ReportRepository：报告数据访问
  const reportRepo = new ReportRepository(db);
  // 信息图是正文落库后的异步能力；共享密钥只存在 Cloudflare Worker Secret。
  const infographicService = new InfographicService({
    onImageReady: (reportId) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reports:imageReady", { reportId });
      }
    },
  });

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
    infographicService,
    onReportGenerated: notifyReportGenerated,
  });

  // -------- Phase 2 新增 Workers --------
  // TimelineBuilderWorker：今日时间轴整理员
  // 职责：把当天 observations/facts/scenes 聚合为用户可读的 TimelineBlock
  const timelineBuilderWorker = new TimelineBuilderWorker({
    modelGateway,
    modelJobQueue,
    observationRepo: obsRepo,
    factRepo,
    sceneRepo,
    timelineBlockRepo,
    timelineBuildCheckpointRepo,
    settingsService,
  });
  const timelinePreflight = {
    preflightReport: async (dateKey: string) => {
      if (!timelineWindowCoordinator) throw new Error("TimelineWindowCoordinator 未初始化");
      await timelineWindowCoordinator.preflightReport(dateKey);
    },
  };
  const timelineRebuilder = {
    rebuildDate: async (dateKey: string) => {
      if (!timelineWindowCoordinator) throw new Error("TimelineWindowCoordinator 未初始化");
      await timelineWindowCoordinator.rebuildDate(dateKey);
    },
  };
  const projectionInvalidationProcessor = new ProjectionInvalidationProcessor({
    correctionLifecycleRepo,
    factRepo,
    sceneRepo,
    timelineBlockRepo,
    reportRepo,
    timelineRebuilder,
    sceneRelationProjector: new SceneRelationProjector({
      sceneRepo,
      factRepo,
      memoryObjectRepo,
      edgeRepo: memoryEdgeRepo,
    }),
  });

  // PersonalReviewWriterWorker：个人复盘撰写员
  // 职责：基于当天 TimelineBlock + UnfinishedThread + decisions 生成个人复盘
  // 报告读取时间轴前由窗口协调器冲刷、封窗并完成可生成尾窗。
  const personalReviewWriterWorker = new PersonalReviewWriterWorker({
    modelGateway,
    modelJobQueue,
    timelineBlockRepo,
    unfinishedThreadRepo,
    factRepo,
    reportRepo,
    settingsService,
    timelinePreflight,
    infographicService,
    onReportGenerated: notifyReportGenerated,
  });

  // WorkReportWriterWorker：工作日报撰写员
  // 职责：基于用户选中的 TimelineBlock 生成工作日报（严格过滤 privateRisk=high）
  // 报告读取时间轴前由窗口协调器冲刷、封窗并完成可生成尾窗。
  const workReportWriterWorker = new WorkReportWriterWorker({
    modelGateway,
    modelJobQueue,
    timelineBlockRepo,
    reportSelectionRepo,
    factRepo,
    reportRepo,
    settingsService,
    timelinePreflight,
    infographicService,
    onReportGenerated: notifyReportGenerated,
  });

  // ReportScheduler：定时调度日报/周报/个人复盘生成
  // - personalReviewWriterWorker：用于个人复盘（personal_daily_review）调度
  // - reportRepo：用于补跑时检查 DB 是否已有 type+dateKey 记录（避免 LLM 重复跑）
  // - 启动后立即跑 checkMissedSchedules()（修复：之前应用重启就丢 lastRunDate）
  reportScheduler = new ReportScheduler({
    reporterWorker,
    personalReviewWriterWorker,
    timelinePreflight,
    reportRepo,
    settingsService,
  });
  // 5. 创建 CaptureBatcher（L0 微批次：默认攒批 6 帧合并提交）
  //    - CaptureService 的 capture-bundle 交给 batcher 攒批（不再直接调 pipeline）
  //    - 攒满 6 帧或 5 分钟超时后 emit "batch-ready"
  //    - batch-ready 交给 MemoryPipeline.processBatchCaptureBundle 处理
  ocrService = new RapidOcrService({ fallback: new WindowsOcrService() });
  captureBatcher = new CaptureBatcher({
    repository: captureInboxRepo,
    ocrService,
  });
  batchProcessor = new BatchProcessor(
    captureInboxRepo,
    memoryPipeline,
    async (_result, batchBundle) => {
      const immediatePaths = batchBundle.frames
        .filter((frame) => frame.retentionPolicy === "delete_immediately")
        .flatMap((frame) => [frame.stitchedImagePath, ...frame.imagePaths])
        .filter((filePath): filePath is string => !!filePath);
      await screenshotCache?.deleteFiles(immediatePaths);
    },
    (status, bundle) => timelineWindowCoordinator?.onBatchSettled(status, bundle)
  );
  captureBatcher.on("batch-ready", () => batchProcessor?.notify());
  batchProcessor.start();
  timelineWindowCoordinator = new TimelineWindowCoordinator({
    windowRepo: timelineWindowRepo,
    observationRepo: obsRepo,
    captureInboxRepo,
    timelineBuilderWorker,
    captureService,
    captureBatcher,
    batchProcessor,
    timelineBlockRepo,
  });
  timelineWindowCoordinator.start();
  reportScheduler.start();
  void projectionInvalidationProcessor.processPending();

  const dataLifecycleService = new DataLifecycleService({
    db,
    observationRepo: obsRepo,
    factRepo,
    sceneRepo,
    screenshotCache,
    captureService,
    captureBatcher,
    batchProcessor,
    isObserving: () => getStatus().observing,
    pauseSources: pauseObserving,
    resumeSources: startObserving,
    cascade: (facts, scenes) => cascadeMarkAfterFactSceneDelete({
      db, factRepo, sceneRepo, memoryObjectRepo, reportRepo, memoryEdgeRepo,
      onReportsStale: (reportIds) => {
        for (const reportId of reportIds) void infographicService.deleteImage(reportId);
      },
    }, facts, scenes),
    infographicService,
    embeddingIndexerService,
  });

  // 6. 订阅 CaptureService 的 capture-bundle 事件
  //    - 每当 CaptureService 成功捕获一个 bundle，加入攒批队列
  //    - 攒批由 CaptureBatcher 管理（满 6 帧 / 5 分钟超时自动 flush）
  //    - 暂停状态由 CaptureService.setPaused 控制（暂停时不再 emit capture-bundle）
  captureService.on("capture-bundle", (bundle) => {
    if (!captureBatcher) return;
    captureBatcher.add(bundle);
  });

  // 7. 创建 SceneScheduler（所有 scheduler reason 仅冲刷 durable capture batch）
  //    - 监听 ActivityService 的 capture-candidate 事件，更新窗口/项目状态
  //    - 同一窗口/项目持续工作 >= longSessionIntervalMinutes 时发出 long_session bundle
  //    - long_session 作为 flush 信号：只冲刷攒批（提交已积累的截图），不再走无图单帧 pipeline
  sceneScheduler = new SceneScheduler({
    settingsService,
    activityService,
    emitCaptureBundle: async () => {
      await captureBatcher?.flush();
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

  endOfDayReviewService = new EndOfDayReviewService({
    settingsService,
    timelineBlockRepo,
    unfinishedThreadRepo,
    getMainWindow: () => mainWindow,
    openReports: openReportsFromNotification,
    openToday: () => {
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createMainWindow();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send("app:navigate", "today");
    },
    isDev,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });
  endOfDayReviewService.start();
  for (const report of pendingReportNotifications) {
    try {
      endOfDayReviewService.showReportNotification(report);
    } catch {
      // 窗口创建失败时保留右上角未读提醒即可。
    }
  }
  pendingReportNotifications = [];

  // 版本更新服务
  updateService = new UpdateService({ settingsService });
  updateService.cleanupIncompleteDownloads(); // 启动时清理 .tmp 残留

  // 初始化托盘服务（M9：抽象到 TrayService，支持双击显示/动态菜单）
  initTray();

  // 启动截图缓存定时清理（每小时检查一次过期截图，来自 06 文档"性能原则"）
  startScreenshotCacheScheduler({
    screenshotCache,
    settingsService,
    getProtectedImagePaths: () => captureBatcher?.getPendingImagePaths() ?? [],
    intervalMs: 60 * 60 * 1000, // 1 小时
  });
  activityService.on(IDLE_STATE_CHANGED_EVENT, (event: IdleStateChangedEvent) => {
    if (event.from === "active" && event.to === "idle") {
      void timelineWindowCoordinator?.finalizeTail("idle", {
        at: new Date(event.triggeredAt),
      });
    }
  });

  // 版本更新定时检查（启动后 10s 首检，之后每 4 小时检查一次）
  startUpdateCheckerScheduler({
    updateService,
    intervalMs: 4 * 60 * 60 * 1000,
    onHasUpdate: (info) => {
      logger.info({ message: `Update available: ${info.latestVersion}` });
    },
    onStatusChange: (status) => {
      // 推送状态到 renderer（让顶栏徽章实时响应）
      mainWindow?.webContents.send("update:statusChanged", status);
    },
  });

  // 注册 IPC handlers（注入 M4 repos 用于真实查询）
  registerIpcHandlers({
    getStatus,
    setStatus,
    subscribeStatus,
    getMainWindow: () => mainWindow,
    settingsService,
    modelGateway,
    defaultModelConsentService,
    onDefaultModelConsentResolved: () => {
      defaultModelConsentRequested = false;
    },
    // M8 新增：SecretService 用于 model:saveConfig 时写入 API Key
    secretService,
    privacyGuard,
    screenshotCache,
    observationRepo: obsRepo,
    factRepo,
    sceneRepo,
    memoryObjectRepo,
    memoryObjectAdmissionService,
    proactiveItemRepo,
    reportRepo,
    infographicService,
    reporterWorker,
    reportScheduler,
    activityService,
    captureService,
    startObserving,
    pauseObserving,
    // M8 新增：DB 实例用于 data:clearAll 等批量操作
    db,
    // Phase 2 新增：TimelineBuilder / PersonalReviewWriter / WorkReportWriter + 相关 Repos
    timelineBuilderWorker,
    timelineWindowCoordinator,
    personalReviewWriterWorker,
    workReportWriterWorker,
    timelineBlockRepo,
    reportSelectionRepo,
    unfinishedThreadRepo,
    // 012 新增：ObjectMerge 审计
    objectMergeRepo: objectMergeRepo,
    // 015 新增：记忆关系层
    memoryEdgeRepo: memoryEdgeRepo,
    // 调试模式：model_jobs 查询（DebugPage 用）
    modelJobRepo,
    dataLifecycleService,
    memorySearchRepo,
    hybridSearchService,
    correctionLifecycleRepo,
    projectionInvalidationProcessor,
    endOfDayReviewService,
    updateService,
  });

  // IPC 完整注册后再加载真实 renderer，避免首屏和 handler 注册竞态。
  await loadMainWindowRenderer(mainWindow);

  const admissionMaintenanceTimer = setTimeout(() => {
    const startedAt = Date.now();
    void memoryObjectAdmissionService.reassessHistorical(10, () => !isQuitting)
      .then((result) => {
        if (result.reviewed === 0) return;
        logger.info({
          jobType: "memory_object_admission",
          status: "succeeded",
          durationMs: Date.now() - startedAt,
          message: `historical admission reassessed: reviewed=${result.reviewed}, promoted=${result.promoted}, candidate=${result.candidate}, rejected=${result.rejected}`,
        });
      })
      .catch((error) => {
        logger.warn({
          jobType: "memory_object_admission",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }, 30_000);
  admissionMaintenanceTimer.unref();

  // 启动时自动恢复观察：用于 Windows 登录自启动后的后台连续记忆。
  if (settingsService.getAll().observation.enabled) {
    startObserving();
  }

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
    captureService?.setLocked(true);
    endOfDayReviewService?.setLocked(true);
    setStatus({ pipelineState: "idle" });
  });
  powerMonitor.on("unlock-screen", () => {
    captureService?.setLocked(false);
    endOfDayReviewService?.setLocked(false);
    // 解锁后不自动启动观察，等待用户操作
  });

  // macOS 重新激活时重建窗口（Windows 不会触发，但保留兼容）
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
}).catch((error) => {
  // 启动链路里任何未捕获异常都会走到这里。此前它是未处理拒绝：
  // 进程留在后台但没有窗口也没有托盘，用户只能去任务管理器杀。
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  logger.error({
    status: "failed",
    errorCode: "startup_failed",
    message: `Recall 启动失败: ${detail}`,
  });
  dialog.showErrorBox("Recall 启动失败", `${detail}\n\n日志位于 %APPDATA%/Recall/logs。`);
  app.exit(1);
});

// 应用退出前清理
app.on("before-quit", (event) => {
  isQuitting = true;
  trayService.notifyQuitting();
  if (shutdownStarted) return;

  event.preventDefault();
  shutdownStarted = true;
  logger.info({ message: "Recall app quitting" });
  // 抓图宿主是个隐藏 BrowserWindow，先关掉它再走 runtime 关停，避免残留窗口
  // 让 window-all-closed / before-quit 的时序变复杂。
  windowFrameGrabber?.dispose();
  windowFrameGrabber = null;
  void shutdownRuntime({
    reportScheduler,
    timelineWindowCoordinator,
    stopScreenshotCacheScheduler,
    stopUpdateCheckerScheduler,
    updateService,
    activityService,
    captureService,
    endOfDayReviewService,
    sceneScheduler,
    captureBatcher,
    ocrService,
    embeddingIndexerService,
    embeddingWorkerClient,
    batchProcessor,
    modelJobQueue: modelJobQueueForShutdown,
    trayService,
    closeDatabase,
  }).then(() => {
    app.exit(0);
  }).catch((error) => {
    logger.error({
      status: "failed",
      errorCode: "shutdown_failed",
      message: `Recall shutdown did not drain cleanly: ${error instanceof Error ? error.message : String(error)}`,
    });
    // Do not explicitly close SQLite when background work may still be active.
    app.exit(1);
  });
});
