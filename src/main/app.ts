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
import { MemorySearchRepository } from "./db/repositories/MemorySearchRepository";
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
import { SecretService } from "./services/SecretService";
import { SettingsService } from "./services/SettingsService";
import { ModelGateway } from "./services/ModelGateway";
import { ActivityService } from "./services/ActivityService";
import { CaptureService } from "./services/CaptureService";
import { PrivacyGuard } from "./services/PrivacyGuard";
import { ScreenshotCache } from "./services/ScreenshotCache";
import { getModelJobQueue } from "./services/ModelJobQueue";
import { ObserverExtractorWorker } from "./services/ObserverExtractorWorker";
import { ObservationNormalizer } from "./services/ObservationNormalizer";
import { LinkerSceneJudgeWorker } from "./services/LinkerSceneJudgeWorker";
import { EpisodeFactExtractorWorker } from "./services/EpisodeFactExtractorWorker";
import { ReporterWorker } from "./services/ReporterWorker";
import { ReportScheduler } from "./services/ReportScheduler";
import { TimelineBuilderWorker } from "./services/TimelineBuilderWorker";
import { TimelineBuildCheckpointRepository } from "./db/repositories/TimelineBuildCheckpointRepository";
import { PersonalReviewWriterWorker } from "./services/PersonalReviewWriterWorker";
import { WorkReportWriterWorker } from "./services/WorkReportWriterWorker";
import { EndOfDayReviewService } from "./services/EndOfDayReviewService";
import { SceneScheduler } from "./services/SceneScheduler";
import { CaptureBatcher } from "./services/CaptureBatcher";
import { BatchProcessor } from "./services/BatchProcessor";
import { DataLifecycleService } from "./services/DataLifecycleService";
import { ProjectionInvalidationProcessor } from "./services/ProjectionInvalidationProcessor";
import { SceneRelationProjector } from "./services/SceneRelationProjector";
import { CAPTURE_CANDIDATE_EVENT } from "./services/ActivityService";
import { MemoryPipeline, setMemoryPipeline } from "./services/MemoryPipeline";
import { logger } from "./services/Logger";
import { cascadeMarkAfterFactSceneDelete } from "./services/cascadeMark";
import { trayService } from "./services/TrayService";
import { startScreenshotCacheScheduler, stopScreenshotCacheScheduler } from "./services/ScreenshotCacheScheduler";
import { UpdateService } from "./services/UpdateService";
import { startUpdateCheckerScheduler, stopUpdateCheckerScheduler } from "./services/UpdateCheckerScheduler";
import { formatLocalDateKey } from "./utils/dateKey";

// 本项目 tsconfig 编译为 CommonJS，__dirname 在编译产物中可用

// ============================================================================
// 应用退出标志
// 由 TrayService 管理：当用户从托盘菜单"退出"时设置为 true，让 close handler 不再拦截
// ============================================================================
let isQuitting = false;
let shutdownStarted = false;

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
let endOfDayReviewService: EndOfDayReviewService | null = null;
// 版本更新服务
let updateService: UpdateService | null = null;
// 长会话场景调度器（C-3 修复：触发 long_session capture bundle）
let sceneScheduler: SceneScheduler | null = null;
// 阶段二：截图攒批合并提交器（12 帧 / 5 分钟超时）
let captureBatcher: CaptureBatcher | null = null;
let batchProcessor: BatchProcessor | null = null;
// Phase 2：TimelineBuilder 自动调度定时器（每 10 分钟为当天生成最新时间轴）
let timelineBuilderTimer: NodeJS.Timeout | null = null;

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
function pauseObserving(): void {
  if (!activityService || !captureService) return;

  captureService.setPaused(true);
  activityService.stop();
  captureService.stop();
  sceneScheduler?.stop();
  // 暂停前冲刷攒批（提交已积累的截图，避免暂停期间丢失数据）
  if (captureBatcher) {
    captureBatcher.flush().catch(() => {
      // flush 失败不阻断暂停流程
    });
  }

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

  // 启动后再显示，避免白屏
  win.once("ready-to-show", () => {
    if (!shouldStartHidden()) {
      win.show();
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

  win.webContents.on("render-process-gone", (_event, details) => {
    logger.error({
      status: "failed",
      errorCode: "renderer_process_gone",
      message: `renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`,
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

  // 加载 renderer
  if (isDev() && process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    // DevTools 默认改为手动打开，避免 Electron/Chromium 协议噪声刷到主进程日志。
    if (shouldAutoOpenDevTools()) {
      win.webContents.openDevTools({ mode: "detach" });
    }
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
      message: `child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`,
    });
  });

  // 初始化数据库与服务
  const db = getDatabase();
  const memorySearchRepo = new MemorySearchRepository(db);
  const correctionLifecycleRepo = new CorrectionLifecycleRepository(db);
  const settingsRepo = new SettingsRepository(db);
  // 注意：modelJobRepo 提升为模块级变量（用于启动时清理卡死任务）
  modelJobRepo = new ModelJobRepository(db);
  const obsRepo = new ObservationRepository(db);
  observationRepo = obsRepo;
  const secretService = new SecretService();
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
  // Phase 2 新增：TimelineBlock / ReportSelection / UnfinishedThread Repositories
  const timelineBlockRepo = new TimelineBlockRepository(db);
  const timelineBuildCheckpointRepo = new TimelineBuildCheckpointRepository(db);
  const reportSelectionRepo = new ReportSelectionRepository(db);
  const unfinishedThreadRepo = new UnfinishedThreadRepository(db);
  // 012 新增：ObjectMerge 审计 Repository
  const objectMergeRepo = createObjectMergeRepository(db);
  // 015 新增：记忆关系层 Repository
  const memoryEdgeRepo = createMemoryEdgeRepository(db);

  // 2. ModelJobQueue 单例（多模态统一并发 3）
  const modelJobQueue = getModelJobQueue(modelJobRepo);

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
  const projectionInvalidationProcessor = new ProjectionInvalidationProcessor({
    correctionLifecycleRepo,
    factRepo,
    sceneRepo,
    timelineBlockRepo,
    reportRepo,
    timelineBuilderWorker,
    sceneRelationProjector: new SceneRelationProjector({
      sceneRepo,
      factRepo,
      memoryObjectRepo,
      edgeRepo: memoryEdgeRepo,
    }),
  });
  void projectionInvalidationProcessor.processPending();

  // PersonalReviewWriterWorker：个人复盘撰写员
  // 职责：基于当天 TimelineBlock + UnfinishedThread + decisions 生成个人复盘
  // Phase 2 B1：注入 timelineBuilderWorker，报告生成前调用 buildTimeline 确保 timeline 最新
  const personalReviewWriterWorker = new PersonalReviewWriterWorker({
    modelGateway,
    modelJobQueue,
    timelineBlockRepo,
    unfinishedThreadRepo,
    factRepo,
    reportRepo,
    settingsService,
    timelineBuilderWorker,
  });

  // WorkReportWriterWorker：工作日报撰写员
  // 职责：基于用户选中的 TimelineBlock 生成工作日报（严格过滤 privateRisk=high）
  // Phase 2 B1：注入 timelineBuilderWorker，报告生成前调用 buildTimeline 确保 timeline 最新
  const workReportWriterWorker = new WorkReportWriterWorker({
    modelGateway,
    modelJobQueue,
    timelineBlockRepo,
    reportSelectionRepo,
    factRepo,
    reportRepo,
    settingsService,
    timelineBuilderWorker,
  });

  // Phase 2 B2：TimelineBuilder 自动调度（每 10 分钟增量落盘当天时间轴）
  // 2026-07-07 变更：从全量替换改为增量追加，历史 blocks 永不改动
  // - 失败不阻断应用，仅记录日志（catch 内吞错）
  // - 在 before-quit 中 clearInterval 避免退出时悬挂引用
  // - 修复：用本地日期工具（与 TimelineBuilderWorker.getLocalTodayStartIsoFromDateKey 保持一致），
  //   避免本地 0:00-8:00 期间被 UTC 切日误判为昨天
  timelineBuilderTimer = setInterval(() => {
    try {
      const today = formatLocalDateKey(new Date());
      void timelineBuilderWorker.buildTimeline(today).then((result) => {
        if (!result.ok) {
          logger.warn({
            jobType: "timeline_builder",
            status: "failed",
            errorCode: result.errorCode,
            message: result.errorMessage ?? "scheduled timeline build failed",
          });
        }
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({
          jobType: "timeline_builder",
          status: "failed",
          errorCode: "unknown_error",
          message: `scheduled timeline build threw: ${message.slice(0, 160)}`,
        });
      });
    } catch {
      // 同步异常兜底（理论上不会进入）
    }
  }, 10 * 60 * 1000);

  // ReportScheduler：定时调度日报/周报/个人复盘生成
  // - personalReviewWriterWorker：用于个人复盘（personal_daily_review）调度
  // - reportRepo：用于补跑时检查 DB 是否已有 type+dateKey 记录（避免 LLM 重复跑）
  // - 启动后立即跑 checkMissedSchedules()（修复：之前应用重启就丢 lastRunDate）
  reportScheduler = new ReportScheduler({
    reporterWorker,
    personalReviewWriterWorker,
    timelineBuilderWorker,
    reportRepo,
    settingsService,
  });
  reportScheduler.start();

  // 5. 创建 CaptureBatcher（L0 微批次：默认攒批 6 帧合并提交）
  //    - CaptureService 的 capture-bundle 交给 batcher 攒批（不再直接调 pipeline）
  //    - 攒满 6 帧或 5 分钟超时后 emit "batch-ready"
  //    - batch-ready 交给 MemoryPipeline.processBatchCaptureBundle 处理
  const captureInboxRepo = new CaptureInboxRepository(db);
  captureBatcher = new CaptureBatcher({ repository: captureInboxRepo });
  batchProcessor = new BatchProcessor(
    captureInboxRepo,
    memoryPipeline,
    async (_result, batchBundle) => {
      if (timelineBuilderWorker) {
        const dateKeys = Array.from(new Set(
          batchBundle.frames.map((frame) => formatLocalDateKey(new Date(frame.capturedAt)))
        ));
        for (const dateKey of dateKeys) {
          void timelineBuilderWorker.buildTimeline(dateKey).then((result) => {
            if (!result.ok) {
              logger.warn({
                jobType: "timeline_builder",
                status: "failed",
                errorCode: result.errorCode,
                message: result.errorMessage ?? "post-batch timeline build failed",
              });
            }
          }).catch((error) => {
            logger.warn({
              jobType: "timeline_builder",
              status: "failed",
              errorCode: "unknown_error",
              message: `post-batch timeline build threw: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        }
      }
      const immediatePaths = batchBundle.frames
        .filter((frame) => frame.retentionPolicy === "delete_immediately")
        .flatMap((frame) => [frame.stitchedImagePath, ...frame.imagePaths])
        .filter((filePath): filePath is string => !!filePath);
      await screenshotCache?.deleteFiles(immediatePaths);
    }
  );
  captureBatcher.on("batch-ready", () => batchProcessor?.notify());
  batchProcessor.start();

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
    }, facts, scenes),
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

  mainWindow = createMainWindow();

  endOfDayReviewService = new EndOfDayReviewService({
    settingsService,
    timelineBlockRepo,
    unfinishedThreadRepo,
    getMainWindow: () => mainWindow,
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

  // 版本更新服务
  updateService = new UpdateService({ settingsService });
  updateService.cleanupIncompleteDownloads(); // 启动时清理 .tmp 残留

  // 初始化托盘服务（M9：抽象到 TrayService，支持双击显示/动态菜单）
  initTray();

  // 启动截图缓存定时清理（每小时检查一次过期截图，来自 06 文档"性能原则"）
  startScreenshotCacheScheduler({
    screenshotCache,
    settingsService,
    intervalMs: 60 * 60 * 1000, // 1 小时
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
    // Phase 2 新增：TimelineBuilder / PersonalReviewWriter / WorkReportWriter + 相关 Repos
    timelineBuilderWorker,
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
    correctionLifecycleRepo,
    projectionInvalidationProcessor,
    endOfDayReviewService,
    updateService,
  });

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
});

// 应用退出前清理
app.on("before-quit", (event) => {
  isQuitting = true;
  trayService.notifyQuitting();
  if (shutdownStarted) return;

  event.preventDefault();
  shutdownStarted = true;
  logger.info({ message: "Recall app quitting" });
  // 停止截图缓存定时清理
  stopScreenshotCacheScheduler();
  // 版本更新：停止调度器 + 清理半成品下载
  stopUpdateCheckerScheduler();
  updateService?.cleanupIncompleteDownloads();
  // Phase 2 B2：停止 TimelineBuilder 自动调度
  if (timelineBuilderTimer) {
    clearInterval(timelineBuilderTimer);
    timelineBuilderTimer = null;
  }
  void (async () => {
    try {
      activityService?.stop();
      captureService?.stop();
      endOfDayReviewService?.stop();
      sceneScheduler?.stop();
      await captureService?.drain();
      if (captureBatcher) {
        await captureBatcher.drain();
      }
    } catch (error) {
      logger.error({
        status: "failed",
        errorCode: "shutdown_cleanup_failed",
        message: `shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      batchProcessor?.checkpoint();
      trayService.destroy();
      closeDatabase();
      app.exit(0);
    }
  })();
});
