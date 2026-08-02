// src/main/ipc/handlers.ts
// IPC handler 注册（来自 06_TECHNICAL_ARCHITECTURE.md）
//
// 重要约束：
// - handler 必须校验参数（zod）
// - 不开放任意 SQL、任意文件路径读取、任意 shell
// - API Key 不通过 IPC 传递到 renderer
// - 截图文件真实路径不通过 IPC 暴露给 renderer
//
// M0 实现：app:getStatus 完整实现；其余 channel 返回安全空状态占位，
// 后续 Milestone 逐步填充真实业务逻辑。

import { macPermissionsService } from "../services/MacPermissionsService";
import { ipcMain, BrowserWindow } from "electron";
import type { AppStatus } from "../../shared/types";
import { isInvokeChannel } from "./channels";
import { z } from "zod";
import {
  DebugListJobsInputSchema,
  DebugRelatedRecordsInputSchema,
  MemoryDeleteObjectInputSchema,
  MemoryUpdateFactInputSchema,
  MemoryUpdateTaskInputSchema,
  MemoryUpdatePersonInputSchema,
  MergeObjectsInputSchema,
  ModelDeleteConfigInputSchema,
  ModelSaveConfigInputSchema,
  ModelTestConnectionInputSchema,
  ProjectDetailInputSchema,
  UserFeedbackInputSchema,
} from "../models/schemas";
import type { ModelConfig } from "../../shared/types";
import type { SecretService } from "../services/SecretService";
import type { AppSettings } from "../models/types";
import type { SettingsService } from "../services/SettingsService";
import type { ModelGateway } from "../services/ModelGateway";
import type { HybridSearchService } from "../services/HybridSearchService";
import type { DefaultModelConsentService } from "../services/DefaultModelConsentService";
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
import type { Fact, Scene } from "../models/types";
import {
  cascadeMarkAfterFactSceneDelete,
  applyCorrection,
  mergeObjects,
} from "../services/cascadeMark";
import { logger } from "../services/Logger";
import type { DataLifecycleService } from "../services/DataLifecycleService";
import type { MemorySearchRepository } from "../db/repositories/MemorySearchRepository";
import type { CorrectionLifecycleRepository } from "../db/repositories/CorrectionLifecycleRepository";
import type { ProjectionInvalidationProcessor } from "../services/ProjectionInvalidationProcessor";
import type { EndOfDayReviewService } from "../services/EndOfDayReviewService";
import type { InfographicService } from "../services/InfographicService";
import { handleValidated, ipcFail } from "./validated";
import { registerAppHandlers } from "./handlers/appHandlers";
import { registerDataLifecycleHandlers } from "./handlers/dataLifecycleHandlers";
import { registerMemorySearchHandlers } from "./handlers/memorySearchHandlers";
import { registerReportHandlers } from "./handlers/reportsHandlers";
import { registerTimelineHandlers, registerWorkReportHandlers } from "./handlers/timelineHandlers";
import { registerActivityHandlers } from "./handlers/activityHandlers";
import type { UpdateService } from "../services/UpdateService";
import { registerUpdateHandlers } from "./handlers/updateHandlers";

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
 * 标准错误返回（renderer 端通过 err.message 区分错误类型）
 */
function fail(code: string, message: string): never {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  throw err;
}

/**
 * 安全空状态占位
 */
const EMPTY_TODAY = {
  observations: [],
  facts: [],
  scenes: [],
  tasks: [],
  decisions: [],
  people: [],
  projects: [],
};

/**
 * 注册全部 IPC handler（23 个 channel）
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

  ipcMain.handle("endOfDayReview:get", () => deps.endOfDayReviewService?.getCurrentReview() ?? null);
  ipcMain.handle("endOfDayReview:viewToday", () => {
    deps.endOfDayReviewService?.viewToday();
    return { ok: true };
  });
  ipcMain.handle("endOfDayReview:snooze", () => {
    deps.endOfDayReviewService?.snooze(30);
    return { ok: true };
  });
  ipcMain.handle("endOfDayReview:dismiss", () => {
    deps.endOfDayReviewService?.dismiss();
    return { ok: true };
  });
  ipcMain.handle("endOfDayReview:expired", () => {
    deps.endOfDayReviewService?.markExpired();
    return { ok: true };
  });
  ipcMain.handle("reports:notification:get", () =>
    deps.endOfDayReviewService?.getCurrentReportNotification() ?? null
  );
  ipcMain.handle("reports:notification:dismiss", () => {
    deps.endOfDayReviewService?.dismissReportNotification();
    return { ok: true };
  });
  ipcMain.handle("reports:notification:open", () => {
    deps.endOfDayReviewService?.openReportNotification();
    return { ok: true };
  });

  // -------------------- model --------------------
  ipcMain.handle("model:testConnection", async (_event, input: unknown) => {
    const parsed = ModelTestConnectionInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `model:testConnection 参数校验失败: ${parsed.error.message}`);
    }
    const { kind, endpoint, model, apiKey } = parsed.data;
    // 调用 ModelGateway.testConnection 真实测试 OpenAI-compatible endpoint
    // 安全约束：apiKey 不进日志、不进 renderer、不进 SQLite
    // 失败时不显示完整 API Key（由 ModelGateway 内部 sanitize）
    const result = await deps.modelGateway.testConnection({
      kind,
      endpoint,
      model,
      apiKey,
    });
    if (result.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      code: result.errorCode ?? "unknown_error",
      message: result.errorMessage ?? "未知错误",
    };
  });

  ipcMain.handle("model:defaultConsent:resolve", (_event, input: unknown) => {
    const parsed = z.object({ accepted: z.boolean() }).safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `model:defaultConsent:resolve 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.defaultModelConsentService) fail("not_ready", "默认模型授权服务未初始化");
    deps.defaultModelConsentService.resolve(parsed.data.accepted);
    deps.onDefaultModelConsentResolved?.();
    return { ok: true };
  });

  // -------- M8 新增：模型配置 CRUD --------
  /**
   * model:listConfigs
   * 列出全部模型配置（不返回 API Key）
   * renderer 通过 kind 过滤 vision / language
   */
  ipcMain.handle("model:listConfigs", (_event, input: unknown) => {
    const opts: { kind?: "vision" | "language" | "multimodal"; enabled?: boolean } = {};
    if (input && typeof input === "object") {
      const obj = input as Record<string, unknown>;
      if (obj.kind === "vision" || obj.kind === "language" || obj.kind === "multimodal") opts.kind = obj.kind;
      if (typeof obj.enabled === "boolean") opts.enabled = obj.enabled;
    }
    return deps.settingsService.listModelConfigs(opts);
  });

  /**
   * model:saveConfig
   * 创建或更新模型配置，并把 API Key 写入 SecretService
   * - 输入 id：更新现有配置
   * - 不输入 id：创建新配置
   * - 输入 apiKey：写入 SecretService（覆盖原有 key）
   * - 不输入 apiKey：保留原有 key（用于只改 endpoint/model）
   *
   * 安全约束：
   * - apiKey 不进 SQLite / 不进日志 / 不返回 renderer
   * - 删除模型配置时同时删除 SecretService 中的 key（由 SettingsService.deleteModelConfig 处理）
   */
  ipcMain.handle("model:saveConfig", async (_event, input: unknown) => {
    const parsed = ModelSaveConfigInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `model:saveConfig 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.secretService) {
      fail("not_ready", "SecretService 未初始化");
    }
    const { id, kind, providerName, endpoint, model, apiKey, enabled, temperature, maxTokens } = parsed.data;

    // Phase 7：把 temperature/maxTokens 写入 options_json
    // - 留空（undefined）时从 options_json 中删除对应键，使用模型默认值
    // - 更新模式下与现有 optionsJson 合并，保留其他自定义键
    // - ModelGateway 从 options_json 读取 temperature / max_tokens（snake_case）
    const buildOptionsJson = (existing: string | null | undefined): string => {
      let existingOptions: Record<string, unknown> = {};
      if (existing) {
        try {
          const parsedExisting = JSON.parse(existing);
          if (parsedExisting && typeof parsedExisting === "object" && !Array.isArray(parsedExisting)) {
            existingOptions = parsedExisting as Record<string, unknown>;
          }
        } catch {
          // 旧 optionsJson 损坏时忽略，从空对象开始
        }
      }
      const next: Record<string, unknown> = { ...existingOptions };
      if (temperature !== undefined) {
        next.temperature = temperature;
      } else {
        delete next.temperature;
      }
      if (maxTokens !== undefined) {
        next.max_tokens = maxTokens;
      } else {
        delete next.max_tokens;
      }
      return JSON.stringify(next);
    };

    let saved: ModelConfig;
    if (id) {
      // 更新现有配置
      const existing = deps.settingsService.getModelConfigById(id);
      if (!existing) {
        fail("not_found", `未找到模型配置 ${id}`);
      }
      const optionsJson = buildOptionsJson(existing.optionsJson);
      const updated = deps.settingsService.updateModelConfig(id, {
        providerName,
        endpoint,
        model,
        enabled,
        optionsJson,
      });
      if (!updated) {
        fail("not_found", `更新模型配置失败 ${id}`);
      }
      saved = updated;
    } else {
      // 创建新配置
      const optionsJson = buildOptionsJson(undefined);
      saved = deps.settingsService.createModelConfig({
        kind,
        providerName,
        endpoint,
        model,
        enabled: enabled ?? true,
        optionsJson,
      });
    }

    // 写入 API Key 到 SecretService（即使没传 apiKey 也保留原有 key）
    if (apiKey) {
      try {
        await deps.secretService!.setApiKey(saved.id, apiKey);
      } catch {
        // SecretService 写入失败不阻断配置保存
        // 但要在返回中提示用户 key 未保存
        return {
          ok: true,
          config: saved,
          warning: "API Key 未能写入系统安全存储，请稍后重试或检查系统权限。",
        };
      }
    }

    // 返回配置（不含 API Key）
    return { ok: true, config: saved };
  });

  /**
   * model:deleteConfig
   * 删除模型配置，同时删除 SecretService 中的 API Key
   */
  ipcMain.handle("model:deleteConfig", async (_event, input: unknown) => {
    const parsed = ModelDeleteConfigInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `model:deleteConfig 参数校验失败: ${parsed.error.message}`);
    }
    const { id } = parsed.data;
    const deleted = await deps.settingsService.deleteModelConfig(id);
    return { ok: deleted };
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

  // -------------------- memory --------------------
  ipcMain.handle("memory:listToday", () => {
    // M4：从 Repositories 读取今日数据
    // - observations：今日捕获的 L0 观察记录
    // - facts：由今日 observations / scenes 反推出的今日事实（避免混入历史全局 facts）
    // - scenes：今日的 L2 场景
    // - tasks：未删除的 L3 任务（按 updated_at 降序）
    // - decisions：未删除的 L3 决策
    // - people：未删除的 L3 人物
    // - projects：未归档的 L3 项目
    try {
      const observations = deps.observationRepo?.listToday() ?? [];
      const scenes = deps.sceneRepo?.listToday() ?? [];
      const factMap = new Map<string, Fact>();

      if (deps.factRepo) {
        const sceneFactIds = Array.from(new Set(scenes.flatMap((scene) => scene.factIds)));
        for (const fact of deps.factRepo.listByIds(sceneFactIds)) {
          factMap.set(fact.id, fact);
        }

        for (const observation of observations) {
          for (const fact of deps.factRepo.listBySourceObservationId(observation.id)) {
            factMap.set(fact.id, fact);
          }
        }
      }

      const facts = Array.from(factMap.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);

      return {
        observations,
        facts,
        scenes,
        tasks: deps.memoryObjectRepo?.listTasks({ includeDeleted: false }) ?? [],
        decisions: deps.memoryObjectRepo?.listDecisions({ includeDeleted: false }) ?? [],
        people: deps.memoryObjectRepo?.listPeople({ includeDeleted: false }) ?? [],
        projects: deps.memoryObjectRepo?.listProjects({ includeArchived: false }) ?? [],
      };
    } catch {
      // 查询失败时返回空状态（避免 renderer 端崩溃）
      return EMPTY_TODAY;
    }
  });

  ipcMain.handle("memory:updateFact", (_event, input: unknown) => {
    const parsed = MemoryUpdateFactInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:updateFact 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.factRepo) {
      fail("not_ready", "FactRepository 未初始化");
    }
    // 重要约束（来自 spec.md "删除和纠错"）：不覆盖 source ids
    // 这里只更新传入的字段（content/importance/status/tags），不动 source_observation_ids_json
    const patch: Record<string, unknown> = {};
    if (parsed.data.content !== undefined) patch.content = parsed.data.content;
    if (parsed.data.importance !== undefined) patch.importance = parsed.data.importance;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.tags !== undefined) patch.tags = parsed.data.tags;
    const updated = deps.factRepo.update(parsed.data.id, patch);
    if (!updated) {
      fail("not_found", `未找到线索 ${parsed.data.id}`);
    }
    return { ok: true, fact: updated };
  });

  ipcMain.handle("memory:updateTask", (_event, input: unknown) => {
    const parsed = MemoryUpdateTaskInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:updateTask 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.memoryObjectRepo) {
      fail("not_ready", "MemoryObjectRepository 未初始化");
    }
    // 重要约束：不覆盖 source ids
    const patch: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) patch.title = parsed.data.title;
    if (parsed.data.status !== undefined) patch.status = parsed.data.status;
    if (parsed.data.projectId !== undefined) patch.projectId = parsed.data.projectId;
    if (parsed.data.summary !== undefined) patch.summary = parsed.data.summary;
    // 标记完成时同步设置 completedAt
    if (parsed.data.status === "done") {
      patch.completedAt = new Date().toISOString();
    }
    const updated = deps.memoryObjectRepo.updateTask(parsed.data.id, patch);
    if (!updated) {
      fail("not_found", `未找到任务 ${parsed.data.id}`);
    }
    return { ok: true, task: updated };
  });

  ipcMain.handle("memory:updatePerson", (_event, input: unknown) => {
    const parsed = MemoryUpdatePersonInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:updatePerson 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.memoryObjectRepo) {
      fail("not_ready", "MemoryObjectRepository 未初始化");
    }
    // 重要约束：Person.summary 是非空 string，null 转为 ""（允许用户清空简介）
    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.role !== undefined) patch.role = parsed.data.role;
    if (parsed.data.organization !== undefined) patch.organization = parsed.data.organization;
    if (parsed.data.relationship !== undefined) patch.relationship = parsed.data.relationship;
    if (parsed.data.summary !== undefined) patch.summary = parsed.data.summary === null ? "" : parsed.data.summary;
    const updated = deps.memoryObjectRepo.updatePerson(parsed.data.id, patch);
    if (!updated) {
      fail("not_found", `未找到人物 ${parsed.data.id}`);
    }
    return { ok: true, person: updated };
  });

  ipcMain.handle("memory:deleteObject", (_event, input: unknown) => {
    const parsed = MemoryDeleteObjectInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:deleteObject 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.db || !deps.memoryObjectRepo || !deps.factRepo || !deps.sceneRepo) {
      fail("not_ready", "Repositories 未初始化");
    }
    // soft delete + 级联标记整体纳入事务（better-sqlite3 transaction 为同步 API：
    // 事务体内禁止 await / async 函数，任一步失败整体回滚，不再吞错返回成功）
    const { id, type } = parsed.data;
    let staleReportIds: string[] = [];
    deps.db.transaction(() => {
      let deleted = false;
      let deletedFact: Fact | null = null;
      let deletedScene: Scene | null = null;
      switch (type) {
        case "fact":
          // 先取出 fact（用于级联标记），再 soft delete
          deletedFact = deps.factRepo!.getByIdActive(id);
          deleted = deps.factRepo!.softDelete(id);
          break;
        case "scene":
          deletedScene = deps.sceneRepo!.getByIdActive(id);
          deleted = deps.sceneRepo!.softDelete(id);
          break;
        case "task":
          deleted = deps.memoryObjectRepo!.softDeleteTask(id);
          break;
        case "person":
          deleted = deps.memoryObjectRepo!.softDeletePerson(id);
          break;
        case "decision":
          deleted = deps.memoryObjectRepo!.softDeleteDecision(id);
          break;
        case "project":
          // 项目使用 archive 而非删除（保留 source 链路）
          deleted = deps.memoryObjectRepo!.archiveProject(id);
          break;
        default:
          fail("schema_invalid", `不支持的删除类型: ${type}`);
      }
      if (!deleted) {
        fail("not_found", `未找到 ${type} ${id} 或已删除`);
      }
      // 级联标记：fact / scene 软删除后触发 reports.markStale + L3 orphan 标记
      // （12.5 / 12.7 / 12.8 / 22.11）。事务内只收集受影响的 reportIds，
      // deleteImage（异步副作用）必须在事务提交之后执行。
      try {
        cascadeMarkAfterFactSceneDelete(
          {
            ...deps,
            onReportsStale: (reportIds) => {
              staleReportIds = reportIds;
            },
          },
          deletedFact ? [deletedFact] : [],
          deletedScene ? [deletedScene] : []
        );
      } catch (err) {
        // 级联失败 → 整个事务回滚，返回结构化错误（不再吞错返回成功）
        fail(
          "delete_cascade_failed",
          `级联标记失败，删除已回滚: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();

    // 事务提交成功后，再触发信息图清理（异步副作用，不得在事务内执行）
    for (const reportId of staleReportIds) {
      void deps.infographicService?.deleteImage(reportId);
    }

    return { ok: true };
  });


  // -------------------- memory: 用户纠错（来自 spec.md "用户纠错"） --------------------
  /**
   * 处理逻辑（来自 spec.md Flow 6）：
   * 1. 保存 edit history（通过 patch 更新对应对象）
   * 2. 更新对应对象（不覆盖 source ids）
   * 3. 把纠错写入 user_feedback
   * 4. 后续 Judge 和 Linker 调用时带入用户反馈摘要
   *
   * 纠错类型映射：
   * - content_wrong -> 更新 content
   * - not_important -> 降低 importance
   * - wrong_project -> 更新 projectId
   * - task_done -> 更新 status=done + completedAt
   * - not_a_task -> soft delete
   * - do_not_record -> soft delete + 写入 user_feedback
   * - sensitive_delete -> hard delete（敏感内容才硬删除）
   */
  ipcMain.handle("memory:createUserFeedback", (_event, input: unknown) => {
    const parsed = UserFeedbackInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:createUserFeedback 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.settingsService) {
      fail("not_ready", "SettingsService 未初始化");
    }

    const { targetType, targetId, feedbackType, note, patch: objectPatch } = parsed.data;

    if (!deps.db || !deps.correctionLifecycleRepo) {
      fail("not_ready", "Correction lifecycle repository 未初始化");
    }

    const feedback = deps.db.transaction(() => {
      const before = readCorrectionTarget(deps, targetType, targetId);
      if (before === null) fail("not_found", `未找到纠错目标 ${targetType}:${targetId}`);

      applyCorrection(deps, targetType, targetId, feedbackType, objectPatch);
      const after = readCorrectionTarget(deps, targetType, targetId);
      deps.correctionLifecycleRepo!.recordRevision({ targetType, targetId, feedbackType, before, after });

      return deps.settingsService.createUserFeedback({
        targetType,
        targetId,
        feedbackType,
        note: JSON.stringify({ note: note ?? null, before, after }),
      });
    })();

    void deps.projectionInvalidationProcessor?.processPending();

    return { ok: true, feedback };
  });

  // -------------------- memory: 项目详情（来自 spec.md "项目详情"） --------------------
  /**
   * 返回项目主线 + 最近场景 + 任务 + 决策 + 人物 + 报告片段
   */
  ipcMain.handle("memory:getProjectDetail", (_event, input: unknown) => {
    const parsed = ProjectDetailInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:getProjectDetail 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.memoryObjectRepo || !deps.sceneRepo || !deps.factRepo || !deps.reportRepo) {
      fail("not_ready", "Repositories 未初始化");
    }
    const { id } = parsed.data;

    const project = deps.memoryObjectRepo.getProjectByIdActive(id);
    if (!project) {
      fail("not_found", `未找到项目 ${id}`);
    }

    // 项目主线：summary + 最近 facts/scenes
    const sceneCandidates = [
      ...deps.sceneRepo.listByProjectId(id, { includeDeleted: false, limit: 20 }),
      ...project.sourceSceneIds
        .map((sceneId) => deps.sceneRepo!.getByIdActive(sceneId))
        .filter((scene): scene is NonNullable<typeof scene> => !!scene),
    ];
    const scenes = Array.from(new Map(sceneCandidates.map((scene) => [scene.id, scene])).values())
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 10);
    const facts = Array.from(
      new Map([
        ...deps.factRepo
          .listByProjectId(id, { includeDeleted: false, limit: 20 })
          .map((fact) => [fact.id, fact] as const),
        ...deps.factRepo
          .listByIds(Array.from(new Set(scenes.flatMap((scene) => scene.factIds))))
          .map((fact) => [fact.id, fact] as const),
      ]).values()
    )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
    const tasks = Array.from(
      new Map([
        ...deps.memoryObjectRepo
          .listTasks({ projectId: id, includeDeleted: false, limit: 50 })
          .map((task) => [task.id, task] as const),
        ...Array.from(new Set(scenes.flatMap((scene) => scene.taskIds)))
          .map((taskId) => deps.memoryObjectRepo!.getTaskByIdActive(taskId))
          .filter((task): task is NonNullable<typeof task> => !!task)
          .map((task) => [task.id, task] as const),
      ]).values()
    )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
    const decisions = Array.from(
      new Map([
        ...deps.memoryObjectRepo
          .listDecisions({ projectId: id, includeDeleted: false, limit: 20 })
          .map((decision) => [decision.id, decision] as const),
        ...Array.from(new Set(scenes.flatMap((scene) => scene.decisionIds)))
          .map((decisionId) => deps.memoryObjectRepo!.getDecisionByIdActive(decisionId))
          .filter((decision): decision is NonNullable<typeof decision> => !!decision)
          .map((decision) => [decision.id, decision] as const),
      ]).values()
    )
      .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
      .slice(0, 20);
    const people = deps.memoryObjectRepo
      .listPeople({ includeDeleted: false, limit: 50 })
      .filter((p) => p.relatedProjectIds.includes(id));

    // 报告片段：列出 source_fact_ids 或 source_scene_ids 命中项目相关证据的 reports
    const projectFactIds = new Set(facts.map((f) => f.id));
    const projectSceneIds = new Set(scenes.map((scene) => scene.id));
    const recentReports = deps.reportRepo.list({ limit: 10 }).filter((r) =>
      r.sourceFactIds.some((fid) => projectFactIds.has(fid)) ||
      r.sourceSceneIds.some((sid) => projectSceneIds.has(sid))
    );

    return {
      project,
      facts,
      scenes,
      tasks,
      decisions,
      people,
      recentReports,
    };
  });

  ipcMain.handle("memory:getPersonDetail", (_event, input: unknown) => {
    const parsed = ProjectDetailInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:getPersonDetail 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.memoryObjectRepo || !deps.sceneRepo || !deps.factRepo) {
      fail("not_ready", "Repositories 未初始化");
    }

    const { id } = parsed.data;
    const person = deps.memoryObjectRepo.getPersonByIdActive(id);
    if (!person) {
      fail("not_found", `未找到人物 ${id}`);
    }

    const knownNames = new Set<string>([person.name, ...(person.aliases ?? [])].filter(Boolean));

    const personEdges = deps.memoryEdgeRepo
      ? [
          ...deps.memoryEdgeRepo.listFrom("person", id, { status: "active", limit: 500 }),
          ...deps.memoryEdgeRepo.listTo("person", id, { status: "active", limit: 500 }),
        ]
      : [];
    const edgeIds = (types: string[]) => new Set(
      personEdges.flatMap((edge) => {
        if (edge.fromType === "person" && edge.fromId === id && types.includes(edge.toType)) return [edge.toId];
        if (edge.toType === "person" && edge.toId === id && types.includes(edge.fromType)) return [edge.fromId];
        return [];
      })
    );
    const edgeFactIds = edgeIds(["fact", "atom"]);
    const edgeSceneIds = edgeIds(["scene", "episode"]);
    const edgeTaskIds = edgeIds(["task"]);
    const edgeProjectIds = edgeIds(["project"]);

    const heuristicFacts = Array.from(
      new Map([
        ...deps.factRepo.listByIds(person.sourceFactIds).map((fact) => [fact.id, fact] as const),
        ...deps.factRepo
          .list({ includeDeleted: false, limit: 500 })
          .filter((fact) => {
            if (fact.peopleHints?.some((name) => knownNames.has(name))) return true;
            return Array.from(knownNames).some((name) => fact.content.includes(name));
          })
          .map((fact) => [fact.id, fact] as const),
      ]).values()
    )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 120);
    const relatedFacts = edgeFactIds.size > 0
      ? deps.factRepo.listByIds(Array.from(edgeFactIds))
      : heuristicFacts;

    const relatedFactIds = new Set(relatedFacts.map((fact) => fact.id));

    const heuristicScenes = deps.sceneRepo
      .listByStartAt({ includeDeleted: false, limit: 500 })
      .filter((scene) => {
        if (scene.entityNames.some((name) => knownNames.has(name))) return true;
        return scene.factIds.some((factId) => relatedFactIds.has(factId));
      })
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 80);
    const relatedScenes = edgeSceneIds.size > 0
      ? deps.sceneRepo.listByIds(Array.from(edgeSceneIds))
      : heuristicScenes;

    const allTasks = deps.memoryObjectRepo
      .listTasks({ includeDeleted: false, limit: 300 })
    const relatedTasks = allTasks
      .filter((task) => edgeTaskIds.size > 0
        ? edgeTaskIds.has(task.id)
        : task.sourceFactIds.some((factId) => relatedFactIds.has(factId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);

    const relatedProjectIds = new Set<string>([
      ...person.relatedProjectIds,
      ...edgeProjectIds,
      ...relatedFacts
        .map((fact) => fact.projectId)
        .filter((projectId): projectId is string => !!projectId),
      ...relatedScenes
        .map((scene) => scene.projectId)
        .filter((projectId): projectId is string => !!projectId),
      ...relatedTasks
        .map((task) => task.projectId)
        .filter((projectId): projectId is string => !!projectId),
    ]);

    const relatedProjects = Array.from(relatedProjectIds)
      .map((projectId) => deps.memoryObjectRepo!.getProjectByIdActive(projectId))
      .filter((project): project is NonNullable<typeof project> => !!project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      person,
      relatedProjects,
      relatedScenes,
      relatedTasks,
      relatedFacts,
    };
  });

  // -------------------- memory: 合并对象（来自 spec.md "合并对象基础能力"） --------------------
  /**
   * 当 Linker 输出 mergeSuggestions 时，写入 proactive_items 作为 needs_confirmation。
   * 用户在提醒页确认合并时，调用合并 API。
   *
   * 012 增强：
   * - facts.projectHint / projectId 改写（项目合并）
   * - facts.people_hints 改写（人物合并）
   * - scenes.entityNames 改写
   * - to.aliases 追加 from.name
   * - object_merges 审计
   */
  ipcMain.handle("memory:mergeObjects", (_event, input: unknown) => {
    const parsed = MergeObjectsInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:mergeObjects 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.memoryObjectRepo || !deps.factRepo || !deps.sceneRepo) {
      fail("not_ready", "Repositories 未初始化");
    }
    const { objectType, fromId, toId, reason } = parsed.data;

    const merged = mergeObjects(deps, objectType, fromId, toId, {
      source: "user_manual",
      reason,
    });
    return { ok: true, merged };
  });

  // -------------------- memory: 合并建议（来自 Linker 输出的 mergeSuggestions） --------------------
  /**
   * 012/013 新增：列出所有 merge_suggestion 类型的 proactive_item
   * - 用于前端"合并建议"列表（默认 status='new'）
   * - 配合 mergeSuggestion payloadJson 解析后展示 from/to 详情
   */
  ipcMain.handle("memory:listMergeSuggestions", (_event, input: unknown) => {
    const parsed = z
      .object({
        status: z.enum(["new", "confirmed", "ignored", "all"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .safeParse(input ?? {});
    if (!parsed.success) {
      fail("schema_invalid", `memory:listMergeSuggestions 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.proactiveItemRepo) {
      fail("not_ready", "ProactiveItemRepository 未初始化");
    }
    const opts: { status?: string; limit?: number } = { limit: parsed.data.limit ?? 200 };
    if (parsed.data.status && parsed.data.status !== "all") {
      opts.status = parsed.data.status;
    }
    const items = deps.proactiveItemRepo.listMergeSuggestions(opts);
    return { ok: true, items };
  });

  /**
   * 012/013 新增：拒绝某个 merge_suggestion
   * - 不执行合并，仅把 proactive_item 状态改为 ignored
   * - 用户后续可以再通过"合并到..."手动发起
   */
  ipcMain.handle("memory:rejectMergeSuggestion", (_event, input: unknown) => {
    const parsed = z
      .object({ id: z.string().min(1) })
      .safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `memory:rejectMergeSuggestion 参数校验失败: ${parsed.error.message}`);
    }
    if (!deps.proactiveItemRepo) {
      fail("not_ready", "ProactiveItemRepository 未初始化");
    }
    const item = deps.proactiveItemRepo.getById(parsed.data.id);
    if (!item) {
      fail("not_found", `merge_suggestion ${parsed.data.id} 不存在`);
    }
    if (item!.type !== "merge_suggestion") {
      fail("invalid_input", `proactive_item ${parsed.data.id} 不是 merge_suggestion 类型`);
    }
    deps.proactiveItemRepo.updateStatus(parsed.data.id, "ignored");
    return { ok: true };
  });

  /**
   * 012/013 新增：列出所有已知别名（项目 + 人物）
   * - 用于 Linker / Extractor prompt 注入，让模型识别到 from.name 时映射到 to
   * - 返回简化格式：{projects: [{id, name, aliases}], people: [{id, name, aliases}]}
   */
  ipcMain.handle("memory:listAllAliases", () => {
    if (!deps.memoryObjectRepo) {
      fail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return {
      ok: true,
      projects: deps.memoryObjectRepo.listProjectAliases(),
      people: deps.memoryObjectRepo.listPersonAliases(),
    };
  });

  /**
   * 012 新增：列出所有人物
   * - 用于人物页 PeoplePage 渲染
   * - 返回 Person 完整字段（含 aliases）
   */
  ipcMain.handle("memory:listPeople", (_event, input?: {
    includeDeleted?: boolean;
    admissionStatus?: "promoted" | "candidate" | "rejected";
    includeNonPromoted?: boolean;
  }) => {
    if (!deps.memoryObjectRepo) {
      fail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return { ok: true, people: deps.memoryObjectRepo.listPeople({
      includeDeleted: input?.includeDeleted ?? false,
      admissionStatus: input?.admissionStatus,
      includeNonPromoted: input?.includeNonPromoted,
      limit: 500,
    }) };
  });

  /**
   * 012 新增：列出所有项目
   * - 用于项目页 ProjectsPage 渲染
   * - 返回 Project 完整字段（含 aliases）
   */
  ipcMain.handle("memory:listProjects", (_event, input?: {
    includeArchived?: boolean;
    admissionStatus?: "promoted" | "candidate" | "rejected";
    includeNonPromoted?: boolean;
  }) => {
    if (!deps.memoryObjectRepo) {
      fail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return { ok: true, projects: deps.memoryObjectRepo.listProjects({
      includeArchived: input?.includeArchived ?? false,
      admissionStatus: input?.admissionStatus,
      includeNonPromoted: input?.includeNonPromoted,
      limit: 500,
    }) };
  });

  ipcMain.handle("memory:reviewAdmission", (_event, input: unknown) => {
    if (!deps.memoryObjectAdmissionService) {
      fail("not_ready", "MemoryObjectAdmissionService 未初始化");
    }
    if (!input || typeof input !== "object") fail("schema_invalid", "准入审核参数无效");
    const value = input as Record<string, unknown>;
    if (!["project", "person"].includes(String(value.objectType))
      || typeof value.id !== "string"
      || !["promote", "reject", "restore"].includes(String(value.decision))) {
      fail("schema_invalid", "准入审核参数无效");
    }
    const updated = deps.memoryObjectAdmissionService.review(value as {
      objectType: "project" | "person";
      id: string;
      decision: "promote" | "reject" | "restore";
    });
    if (!updated) fail("not_found", "未找到待审核对象");
    return { ok: true };
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


  // -------------------- debug --------------------
  // 调试模式专用：3 个 handler 均强制校验 settingsService.isDebugMode()
  // 关闭时返回 error，防止通过 IPC 绕过 UI 开关

  ipcMain.handle("debug:listJobs", (_event, input: unknown) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    const parsed = DebugListJobsInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: `参数校验失败: ${parsed.error.message}`, code: "schema_invalid" };
    }
    if (!deps.modelJobRepo) {
      return { ok: false as const, error: "ModelJobRepository 未初始化", code: "not_ready" };
    }
    try {
      const jobs = deps.modelJobRepo.listByTimeRange(
        parsed.data.startAt,
        parsed.data.endAt,
        parsed.data.limit ?? 200
      );
      return { ok: true as const, data: jobs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  ipcMain.handle("debug:getJobDetails", (_event, input: unknown) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    const parsed = z.object({ jobId: z.string() }).safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: `参数校验失败: ${parsed.error.message}`, code: "schema_invalid" };
    }
    if (!deps.modelJobRepo) {
      return { ok: false as const, error: "ModelJobRepository 未初始化", code: "not_ready" };
    }
    try {
      const job = deps.modelJobRepo.getById(parsed.data.jobId);
      return { ok: true as const, data: job };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  ipcMain.handle("debug:getRelatedRecords", (_event, input: unknown) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    const parsed = DebugRelatedRecordsInputSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: `参数校验失败: ${parsed.error.message}`, code: "schema_invalid" };
    }
    const { createdAt, windowSeconds = 30 } = parsed.data;
    const start = new Date(Date.parse(createdAt) - windowSeconds * 1000).toISOString();
    const end = new Date(Date.parse(createdAt) + windowSeconds * 1000).toISOString();
    try {
      const observations = deps.observationRepo?.listByTimeRange(start, end) ?? [];
      const facts = deps.factRepo?.listByTimeRange(start, end) ?? [];
      const scenes = deps.sceneRepo?.listByTimeRange(start, end) ?? [];
      const proactiveItems = deps.proactiveItemRepo?.listByTimeRange(start, end) ?? [];
      return { ok: true as const, data: { observations, facts, scenes, proactiveItems } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  // macOS 专属支持 handlers
  ipcMain.handle("mac:checkPermissions", async () => {
    const data = macPermissionsService.checkPermissions();
    // 同步更新 AppStatus 并推送给 renderer，让权限引导横幅能刷新
    if (data.isMac) {
      deps.setStatus({
        macPermissions: {
          screenCaptureGranted: data.screenCaptureGranted,
          accessibilityGranted: data.accessibilityGranted,
          permissionsChecked: true,
        },
      });
    }
    return { ok: true as const, data };
  });

  ipcMain.handle("mac:openSystemSettings", async (_event, input: unknown) => {
    const parsed = z.object({ privacyType: z.enum(["screen", "accessibility"]) }).safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: "invalid privacy type", code: "schema_invalid" };
    }
    const success = await macPermissionsService.openSystemSettings(parsed.data.privacyType);
    return { ok: true as const, data: { success } };
  });

  // -------------------- 白名单校验 --------------------
  // 额外安全网：捕获未注册的 channel 调用（理论上不会发生，因为 ipcMain.handle 已限定）
  // 这里仅作为开发期检查：断言所有 channel 都已注册
  const registeredChannels = ALL_INVOKE_CHANNELS_EXPECTED;
  for (const ch of registeredChannels) {
    if (!isInvokeChannel(ch)) {
      fail("internal_error", `internal: unknown channel ${ch}`);
    }
  }
  registerAppHandlers(deps);
  registerMemorySearchHandlers(deps);
  registerDataLifecycleHandlers(deps);
  registerReportHandlers(deps);
  registerTimelineHandlers(deps);
  registerActivityHandlers(deps);
  registerWorkReportHandlers(deps);
  registerUpdateHandlers(deps);
}

function readCorrectionTarget(
  deps: IpcDeps,
  targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder",
  targetId: string
): unknown {
  switch (targetType) {
    case "fact": return deps.factRepo?.getByIdActive(targetId) ?? null;
    case "scene": return deps.sceneRepo?.getByIdActive(targetId) ?? null;
    case "project": return deps.memoryObjectRepo?.getProjectByIdActive(targetId) ?? null;
    case "task": return deps.memoryObjectRepo?.getTaskByIdActive(targetId) ?? null;
    case "person": return deps.memoryObjectRepo?.getPersonByIdActive(targetId) ?? null;
    case "decision": return deps.memoryObjectRepo?.getDecisionByIdActive(targetId) ?? null;
    case "reminder": return deps.proactiveItemRepo?.getById(targetId) ?? null;
  }
}

/**
 * 期望注册的全部 channel（用于完整性自检）
 */
const ALL_INVOKE_CHANNELS_EXPECTED = [
  "app:getStatus",
  "app:startObserving",
  "app:pauseObserving",
  "app:getLaunchAtLogin",
  "app:setLaunchAtLogin",
  "window:minimize",
  "window:toggleMaximize",
  "window:drag",
  "window:close",
  "settings:get",
  "settings:update",
  "model:testConnection",
  "model:defaultConsent:resolve",
  // M8 新增：模型配置 CRUD
  "model:listConfigs",
  "model:saveConfig",
  "model:deleteConfig",
  "privacy:listRules",
  "privacy:addRule",
  "privacy:updateRule",
  "privacy:deleteRule",
  "memory:listToday",
  "memory:search",
  "memory:expandSearch",
  "memory:getDetail",
  "memory:getSourcePreview",
  "memory:openSourceUrl",
  "memory:updateFact",
  "memory:updateTask",
  "memory:deleteObject",
  // M7 新增：轻量问答 / 用户纠错 / 项目详情 / 合并对象
  "memory:ask",
  "memory:createUserFeedback",
  "memory:getProjectDetail",
  "memory:getPersonDetail",
  "memory:mergeObjects",
  "reminders:list",
  "reminders:updateStatus",
  "reports:list",
  "reports:get",
  "reports:getEvidenceByIds",
  "reports:generate",
  "reports:update",
  "reports:delete",
  "capture:forgetRecent",
  "screenshot:clear",
  // M8 新增：数据导出/清空 + 缓存大小查询
  "data:export",
  "data:clearAll",
  "data:getCacheSize",
  // Phase 2 新增：时间轴 / 个人复盘 / 工作日报 / 待收尾
  "timeline:build",
  "timeline:reorganizeDay",
  "timeline:get",
  "activity:getDayOverview",
  "personalReview:generate",
  "personalReview:get",
  "workReport:generate",
  "workReport:get",
  "workReport:saveSelection",
  "unfinishedThreads:list",
  "unfinishedThreads:updateStatus",
  // 调试模式
  "debug:listJobs",
  "debug:getJobDetails",
  "debug:getRelatedRecords",
  // 版本更新
  "app:getVersion",
  "update:check",
  "update:download",
  "update:installAndQuit",
  "update:getStatus",
  "update:dismissVersion",
] as const;
