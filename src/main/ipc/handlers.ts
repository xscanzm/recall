// src/main/ipc/handlers.ts
// IPC handler 注册（来自 06_TECHNICAL_ARCHITECTURE.md）
//
// 重要约束：
// - handler 必须校验参数（zod）
// - 不开放任意 SQL、任意文件路径读取、任意 shell
// - API Key 不通过 IPC 传递到 renderer
// - 截图文件真实路径不通过 IPC 暴露给 renderer

import { ipcMain, BrowserWindow } from "electron";
import type { AppStatus } from "../../shared/types";
import type { AppSettings } from "../models/types";
import type { SettingsService } from "../services/SettingsService";
import type { DefaultModelConsentService } from "../services/DefaultModelConsentService";
import type { SecretService } from "../services/SecretService";
import type { ModelGateway } from "../services/ModelGateway";
import type { HybridSearchService } from "../services/HybridSearchService";
import type { PrivacyGuard } from "../services/PrivacyGuard";
import type { ScreenshotCache } from "../services/ScreenshotCache";
import type { ActivityService } from "../services/ActivityService";
import type { CaptureService } from "../services/CaptureService";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { DB } from "../db/Database";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { MemoryObjectAdmissionService } from "../services/MemoryObjectAdmissionService";
import type { ProactiveItemRepository } from "../db/repositories/ProactiveItemRepository";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { ReporterWorker } from "../services/ReporterWorker";
import type { ReportScheduler } from "../services/ReportScheduler";
// Phase 2 新增
import type { TimelineBuilderWorker } from "../services/TimelineBuilderWorker";
import type { TimelineWindowCoordinator } from "../services/TimelineWindowCoordinator";
import type { PersonalReviewWriterWorker } from "../services/PersonalReviewWriterWorker";
import type { WorkReportWriterWorker } from "../services/WorkReportWriterWorker";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { ReportSelectionRepository } from "../db/repositories/ReportSelectionRepository";
import type { UnfinishedThreadRepository } from "../db/repositories/UnfinishedThreadRepository";
// 012 新增：ObjectMerge 审计
import type { ObjectMergeRepository } from "../db/repositories/ObjectMergeRepository";
import type { MemoryEdgeRepository } from "../db/repositories/MemoryEdgeRepository";
import type { ModelJobRepository } from "../db/repositories/ModelJobRepository";
import { logger } from "../services/Logger";
import type { DataLifecycleService } from "../services/DataLifecycleService";
import type { MemorySearchRepository } from "../db/repositories/MemorySearchRepository";
import type { CorrectionLifecycleRepository } from "../db/repositories/CorrectionLifecycleRepository";
import type { ProjectionInvalidationProcessor } from "../services/ProjectionInvalidationProcessor";
import type { EndOfDayReviewService } from "../services/EndOfDayReviewService";
import type { InfographicService } from "../services/InfographicService";
import type { UpdateService } from "../services/UpdateService";
import { handleValidated, ipcFail } from "./validated";
import { registerAppHandlers } from "./handlers/appHandlers";
import { registerDataLifecycleHandlers } from "./handlers/dataLifecycleHandlers";
import { registerMemorySearchHandlers } from "./handlers/memorySearchHandlers";
import { registerReportHandlers } from "./handlers/reportsHandlers";
import { registerTimelineHandlers, registerWorkReportHandlers } from "./handlers/timelineHandlers";
import { registerActivityHandlers } from "./handlers/activityHandlers";
import { registerUpdateHandlers } from "./handlers/updateHandlers";
import { registerEndOfDayReviewHandlers } from "./handlers/endOfDayReviewHandlers";
import { registerModelHandlers } from "./handlers/modelHandlers";
import { registerMemoryHandlers } from "./handlers/memoryHandlers";
import { registerDebugHandlers } from "./handlers/debugHandlers";
import { registerMacHandlers } from "./handlers/macHandlers";

/**
 * IpcDeps：handler 所需的 main 进程依赖
 * 通过依赖注入避免循环 import（app.ts ↔ handlers.ts）
 */
export interface IpcDeps {
  getStatus: () => AppStatus;
  setStatus: (patch: Partial<AppStatus>) => void;
  subscribeStatus: (listener: (status: AppStatus) => void) => () => void;
  getMainWindow: () => BrowserWindow | null;
  settingsService: SettingsService;
  modelGateway: ModelGateway;
  defaultModelConsentService?: DefaultModelConsentService;
  onDefaultModelConsentResolved?: () => void;
  /**
   * M8 新增：SecretService 用于 model:saveConfig 时写入 API Key
   * API Key 不进 renderer / SQLite / 日志
   */
  secretService?: SecretService;
  // M3 服务
  privacyGuard?: PrivacyGuard;
  screenshotCache?: ScreenshotCache;
  observationRepo?: ObservationRepository;
  activityService?: ActivityService;
  captureService?: CaptureService;
  // M4 Repositories（用于 memory:listToday 和 reminders:list 真实查询）
  factRepo?: FactRepository;
  sceneRepo?: SceneRepository;
  memoryObjectRepo?: MemoryObjectRepository;
  memoryObjectAdmissionService?: MemoryObjectAdmissionService;
  proactiveItemRepo?: ProactiveItemRepository;
  // M6 报告相关
  reportRepo?: ReportRepository;
  infographicService?: InfographicService;
  reporterWorker?: ReporterWorker;
  reportScheduler?: ReportScheduler;
  startObserving?: () => void | Promise<void>;
  pauseObserving?: () => void | Promise<void>;
  /**
   * M8 新增：数据库实例引用
   * 用于 data:clearAll / data:export 等 bulk 操作
   * 不暴露给 renderer，仅在 main 内使用
   */
  db?: DB;
  // Phase 2 新增：TimelineBuilder / PersonalReviewWriter / WorkReportWriter
  timelineBuilderWorker?: TimelineBuilderWorker;
  timelineWindowCoordinator?: TimelineWindowCoordinator;
  personalReviewWriterWorker?: PersonalReviewWriterWorker;
  workReportWriterWorker?: WorkReportWriterWorker;
  timelineBlockRepo?: TimelineBlockRepository;
  reportSelectionRepo?: ReportSelectionRepository;
  unfinishedThreadRepo?: UnfinishedThreadRepository;
  // 012 新增：ObjectMerge 审计 Repository
  objectMergeRepo?: ObjectMergeRepository;
  // 015 新增：记忆关系层 Repository
  memoryEdgeRepo?: MemoryEdgeRepository;
  // 调试模式：model_jobs 查询（DebugPage 用）
  modelJobRepo?: ModelJobRepository;
  dataLifecycleService?: DataLifecycleService;
  memorySearchRepo?: MemorySearchRepository;
  hybridSearchService?: HybridSearchService;
  correctionLifecycleRepo?: CorrectionLifecycleRepository;
  projectionInvalidationProcessor?: ProjectionInvalidationProcessor;
  endOfDayReviewService?: EndOfDayReviewService;
  // 版本更新服务（UpdateService，可选；为空时 update 相关 channel 返回 update_service_unavailable）
  updateService?: UpdateService;
}

/**
 * 注册全部 IPC handler
 * 必须在 app.whenReady() 之后调用
 */
export function registerIpcHandlers(deps: IpcDeps): void {

  // -------------------- settings --------------------
  handleValidated(ipcMain, "settings:get", () => {
    return deps.settingsService.getAll() satisfies AppSettings;
  });

  handleValidated(ipcMain, "settings:update", (_event, input) => {
    const updated = deps.settingsService.update(input as Partial<AppSettings>);
    const defaultConsent = input.defaultModelService?.consent;
    if (defaultConsent === "accepted" || defaultConsent === "declined") {
      deps.defaultModelConsentService?.resolve(defaultConsent === "accepted");
      deps.onDefaultModelConsentResolved?.();
    }
    // 调试模式开关：保存后立即同步到 Logger（无需重启应用）
    logger.setDevDebug(updated.debug?.enabled ?? false);
    return { ok: true, settings: updated };
  });

  // -------------------- privacy --------------------
  handleValidated(ipcMain, "privacy:listRules", () => {
    return deps.settingsService.listPrivacyRules();
  });

  handleValidated(ipcMain, "privacy:addRule", (_event, input) => {
    const rule = deps.settingsService.createPrivacyRule({
      type: input.type,
      pattern: input.pattern,
      action: input.action,
      enabled: input.enabled ?? true,
    });
    // 规则变更后刷新 PrivacyGuard 缓存
    deps.privacyGuard?.reloadRules();
    return rule;
  });

  handleValidated(ipcMain, "privacy:updateRule", (_event, input) => {
    // 只把显式传入的字段放进 patch：undefined 表示"不改"，不能覆盖成 null。
    const patch: Record<string, unknown> = {};
    if (input.pattern !== undefined) patch.pattern = input.pattern;
    if (input.action !== undefined) patch.action = input.action;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const updated = deps.settingsService.updatePrivacyRule(input.id, patch);
    if (!updated) {
      ipcFail("not_found", `privacy:updateRule 未找到规则 ${input.id}`);
    }
    // 规则变更后刷新 PrivacyGuard 缓存
    deps.privacyGuard?.reloadRules();
    return { ok: true, rule: updated };
  });

  handleValidated(ipcMain, "privacy:deleteRule", (_event, input) => {
    const deleted = deps.settingsService.deletePrivacyRule(input.id);
    // 规则变更后刷新 PrivacyGuard 缓存
    if (deleted) {
      deps.privacyGuard?.reloadRules();
    }
    return { ok: deleted };
  });

  // -------------------- reminders --------------------
  handleValidated(ipcMain, "reminders:list", () => {
    // M4：从 proactive_items 表读取今日提醒
    // - 默认返回今日的 proactive_items（按 created_at 降序）
    // - 包含所有状态（new/confirmed/ignored/snoozed/done/do_not_remind_again）
    //   renderer 端可按状态过滤展示
    try {
      return deps.proactiveItemRepo?.listToday() ?? [];
    } catch {
      return [];
    }
  });

  handleValidated(ipcMain, "reminders:updateStatus", (_event, input) => {
    if (!deps.proactiveItemRepo) {
      ipcFail("not_ready", "ProactiveItemRepository 未初始化");
    }
    const updated = deps.proactiveItemRepo.updateStatus(input.id, input.status);
    if (!updated) {
      ipcFail("not_found", `未找到提醒 ${input.id}`);
    }
    return { ok: true };
  });

  registerAppHandlers(deps);
  registerEndOfDayReviewHandlers(deps);
  registerModelHandlers(deps);
  registerMemoryHandlers(deps);
  registerMemorySearchHandlers(deps);
  registerDataLifecycleHandlers(deps);
  registerReportHandlers(deps);
  registerTimelineHandlers(deps);
  registerActivityHandlers(deps);
  registerWorkReportHandlers(deps);
  registerUpdateHandlers(deps);
  registerDebugHandlers(deps);
  registerMacHandlers(deps);
}
