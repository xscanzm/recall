// src/main/preload.ts
// Electron preload 脚本
//
// 职责：在 renderer 与 main 之间建立受控的 IPC 桥
//
// 安全原则：
// - contextIsolation: true（启用上下文隔离）
// - nodeIntegration: false（renderer 无 Node API）
// - 只通过 contextBridge.exposeInMainWorld 暴露白名单 API
// - 不暴露 ipcRenderer.on/send 原始方法（防止任意 channel 注入）
// - API Key 不通过此桥暴露

import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";
import type { AppStatus, IpcResult, ReportGeneratedEvent } from "../shared/types";
import { invokeValidated } from "./ipc/invokeValidated";
import type { IpcRequest } from "../shared/ipcContracts";

/**
 * Renderer 调用的 IPC API 表面
 *
 * 每个 invoke 方法对应一个 IpcChannel（23 个）
 * 每个 on 方法对应一个 push channel（如 app:statusChanged）
 */
const recallApi = {
  // -------------------- app --------------------
  app: {
    getStatus: () => invokeValidated(ipcRenderer, "app:getStatus"),
    startObserving: () => invokeValidated(ipcRenderer, "app:startObserving"),
    pauseObserving: () => invokeValidated(ipcRenderer, "app:pauseObserving"),
    getLaunchAtLogin: () => invokeValidated(ipcRenderer, "app:getLaunchAtLogin"),
    setLaunchAtLogin: (input: IpcRequest<"app:setLaunchAtLogin">) => invokeValidated(ipcRenderer, "app:setLaunchAtLogin", input),
    getVersion: () => invokeValidated(ipcRenderer, "app:getVersion"),
    onStatusChanged: (callback: (status: AppStatus) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: AppStatus): void => callback(status);
      ipcRenderer.on("app:statusChanged", handler);
      return () => {
        ipcRenderer.removeListener("app:statusChanged", handler);
      };
    },
    onNavigate: (callback: (page: string) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, page: string): void => callback(page);
      ipcRenderer.on("app:navigate", handler);
      return () => ipcRenderer.removeListener("app:navigate", handler);
    },
  },

  // -------------------- window --------------------
  window: {
    minimize: () => invokeValidated(ipcRenderer, "window:minimize"),
    toggleMaximize: () => invokeValidated(ipcRenderer, "window:toggleMaximize"),
    close: () => invokeValidated(ipcRenderer, "window:close"),
  },

  // -------------------- settings --------------------
  settings: {
    get: <T>(): Promise<T> => ipcRenderer.invoke("settings:get"),
    update: <T>(input: unknown): Promise<{ ok: true; settings: T }> =>
      ipcRenderer.invoke("settings:update", input),
  },

  endOfDayReview: {
    get: <T>(): Promise<T | null> => ipcRenderer.invoke("endOfDayReview:get"),
    viewToday: (): Promise<{ ok: true }> => ipcRenderer.invoke("endOfDayReview:viewToday"),
    snooze: (): Promise<{ ok: true }> => ipcRenderer.invoke("endOfDayReview:snooze"),
    dismiss: (): Promise<{ ok: true }> => ipcRenderer.invoke("endOfDayReview:dismiss"),
    expired: (): Promise<{ ok: true }> => ipcRenderer.invoke("endOfDayReview:expired"),
  },

  // -------------------- model --------------------
  model: {
    resolveDefaultConsent: (accepted: boolean): Promise<{ ok: true }> =>
      ipcRenderer.invoke("model:defaultConsent:resolve", { accepted }),
    onDefaultConsentRequested: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on("model:defaultConsentRequested", handler);
      return () => ipcRenderer.removeListener("model:defaultConsentRequested", handler);
    },
    testConnection: (input: {
      kind: "vision" | "language" | "multimodal";
      endpoint: string;
      model: string;
      apiKey: string;
    }): Promise<{ ok: boolean; code?: string; message?: string }> =>
      ipcRenderer.invoke("model:testConnection", input),
    // M8 新增：列出模型配置（不返回 API Key）
    listConfigs: <T>(input?: {
      kind?: "vision" | "language" | "multimodal";
      enabled?: boolean;
    }): Promise<T[]> => ipcRenderer.invoke("model:listConfigs", input),
    // M8 新增：保存模型配置（创建或更新），apiKey 可选（不传则保留原 key）
    saveConfig: (input: {
      id?: string;
      kind: "vision" | "language" | "multimodal";
      providerName: string;
      endpoint: string;
      model: string;
      apiKey?: string;
      enabled?: boolean;
    }): Promise<{
      ok: boolean;
      config?: unknown;
      warning?: string;
      code?: string;
      message?: string;
    }> => ipcRenderer.invoke("model:saveConfig", input),
    // M8 新增：删除模型配置（同时删除 SecretService 中的 API Key）
    deleteConfig: (input: { id: string }): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("model:deleteConfig", input),
  },

  // -------------------- privacy --------------------
  privacy: {
    listRules: <T>(): Promise<T[]> => ipcRenderer.invoke("privacy:listRules"),
    addRule: <T>(input: unknown): Promise<T> => ipcRenderer.invoke("privacy:addRule", input),
    updateRule: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("privacy:updateRule", input),
    deleteRule: (input: { id: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("privacy:deleteRule", input),
  },

  // -------------------- memory --------------------
  memory: {
    listToday: <T>(): Promise<T> => ipcRenderer.invoke("memory:listToday"),
    search: (input: IpcRequest<"memory:search">) => invokeValidated(ipcRenderer, "memory:search", input),
    expandSearch: (input: IpcRequest<"memory:expandSearch">) => invokeValidated(ipcRenderer, "memory:expandSearch", input),
    getDetail: (input: IpcRequest<"memory:getDetail">) => invokeValidated(ipcRenderer, "memory:getDetail", input),
    getSourcePreview: (input: IpcRequest<"memory:getSourcePreview">) => invokeValidated(ipcRenderer, "memory:getSourcePreview", input),
    openSourceUrl: (input: IpcRequest<"memory:openSourceUrl">) => invokeValidated(ipcRenderer, "memory:openSourceUrl", input),
    updateFact: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:updateFact", input),
    updateTask: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:updateTask", input),
    updatePerson: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:updatePerson", input),
    deleteObject: (input: { id: string; type: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:deleteObject", input),
    // M7 新增：轻量问答
    ask: (input: IpcRequest<"memory:ask">) => invokeValidated(ipcRenderer, "memory:ask", input),
    // M7 新增：用户纠错
    createUserFeedback: (input: {
      targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder";
      targetId: string;
      feedbackType:
        | "content_wrong"
        | "not_important"
        | "wrong_project"
        | "task_done"
        | "not_a_task"
        | "do_not_record"
        | "sensitive_delete";
      note?: string;
      patch?: Record<string, unknown>;
    }): Promise<{ ok: true; feedback: unknown }> =>
      ipcRenderer.invoke("memory:createUserFeedback", input),
    // M7 新增：项目详情（聚合 project + facts + scenes + tasks + decisions + people + reports）
    getProjectDetail: (input: { id: string }): Promise<{
      project: unknown;
      facts: unknown[];
      scenes: unknown[];
      tasks: unknown[];
      decisions: unknown[];
      people: unknown[];
      recentReports: unknown[];
    }> => ipcRenderer.invoke("memory:getProjectDetail", input),
    getPersonDetail: (input: { id: string }): Promise<{
      person: unknown;
      relatedProjects: unknown[];
      relatedScenes: unknown[];
      relatedTasks: unknown[];
      relatedFacts: unknown[];
    }> => ipcRenderer.invoke("memory:getPersonDetail", input),
    // M7 新增：合并对象（基于 Linker mergeSuggestions）
    mergeObjects: (input: {
      objectType: "project" | "task" | "person" | "decision";
      fromId: string;
      toId: string;
      reason?: string;
    }): Promise<{
      ok: true;
      merged: {
        ok: true;
        fromId: string;
        toId: string;
        objectType: string;
        rewrittenFactsCount: number;
        rewrittenScenesCount: number;
        mergedAliases: string[];
      };
    }> => ipcRenderer.invoke("memory:mergeObjects", input),
    // 012/013 新增：合并建议列表
    listMergeSuggestions: (input?: {
      status?: "new" | "confirmed" | "ignored" | "all";
      limit?: number;
    }): Promise<{ ok: true; items: unknown[] }> =>
      ipcRenderer.invoke("memory:listMergeSuggestions", input ?? {}),
    // 012/013 新增：拒绝某个 merge_suggestion
    rejectMergeSuggestion: (input: { id: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:rejectMergeSuggestion", input),
    // 012/013 新增：列出所有已知别名
    listAllAliases: (): Promise<{
      ok: true;
      projects: Array<{ id: string; name: string; aliases: string[] }>;
      people: Array<{ id: string; name: string; aliases: string[] }>;
    }> => ipcRenderer.invoke("memory:listAllAliases"),
    // 012 新增：列出所有人物 / 项目（人物/项目页用）
    listPeople: <T>(input?: {
      includeDeleted?: boolean;
      admissionStatus?: "promoted" | "candidate" | "rejected";
      includeNonPromoted?: boolean;
    }): Promise<{ ok: true; people: T[] }> => ipcRenderer.invoke("memory:listPeople", input),
    listProjects: <T>(input?: {
      includeArchived?: boolean;
      admissionStatus?: "promoted" | "candidate" | "rejected";
      includeNonPromoted?: boolean;
    }): Promise<{ ok: true; projects: T[] }> => ipcRenderer.invoke("memory:listProjects", input),
    reviewAdmission: (input: {
      objectType: "project" | "person";
      id: string;
      decision: "promote" | "reject" | "restore";
    }): Promise<{ ok: true }> => ipcRenderer.invoke("memory:reviewAdmission", input),
  },

  // -------------------- reminders --------------------
  reminders: {
    list: <T>(): Promise<T[]> => ipcRenderer.invoke("reminders:list"),
    updateStatus: (input: { id: string; status: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("reminders:updateStatus", input),
  },

  // -------------------- reports --------------------
  reports: {
    list: <T>(input?: unknown): Promise<T[]> => ipcRenderer.invoke("reports:list", input),
    get: <T>(input: { id: string }): Promise<T | null> => ipcRenderer.invoke("reports:get", input),
    getImage: (input: IpcRequest<"reports:getImage">) =>
      invokeValidated(ipcRenderer, "reports:getImage", input),
    getNotification: () => invokeValidated(ipcRenderer, "reports:notification:get"),
    dismissNotification: () => invokeValidated(ipcRenderer, "reports:notification:dismiss"),
    openNotification: () => invokeValidated(ipcRenderer, "reports:notification:open"),
    getEvidenceByIds: (input: {
      factIds?: string[];
      sceneIds?: string[];
      blockIds?: string[];
    }): Promise<IpcResult<{
      facts: unknown[];
      scenes: unknown[];
      timelineBlocks: unknown[];
    }>> => ipcRenderer.invoke("reports:getEvidenceByIds", input),
    generate: (input: {
      type: "daily" | "weekly" | "monthly" | "retrospective";
      dateKey: string;
      projectId?: string;
      generationRequirement?: string;
    }): Promise<{ ok: boolean; reportId?: string; code?: string; message?: string }> =>
      ipcRenderer.invoke("reports:generate", input),
    update: (input: { id: string; contentJson: string }): Promise<{ ok: true; report?: unknown }> =>
      ipcRenderer.invoke("reports:update", input),
    delete: (input: { id: string }): Promise<boolean> =>
      ipcRenderer.invoke("reports:delete", input),
    onImageReady: (callback: (payload: { reportId: string }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: { reportId: string }): void => callback(payload);
      ipcRenderer.on("reports:imageReady", handler);
      return () => ipcRenderer.removeListener("reports:imageReady", handler);
    },
    onGenerated: (callback: (payload: ReportGeneratedEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: ReportGeneratedEvent): void => callback(payload);
      ipcRenderer.on("reports:generated", handler);
      return () => ipcRenderer.removeListener("reports:generated", handler);
    },
  },

  // -------------------- capture --------------------
  capture: {
    forgetRecent: (input: IpcRequest<"capture:forgetRecent">) => invokeValidated(ipcRenderer, "capture:forgetRecent", input),
  },

  // -------------------- screenshot --------------------
  screenshot: {
    clear: () => invokeValidated(ipcRenderer, "screenshot:clear"),
  },

  // -------------------- data（M8 新增） --------------------
  data: {
    // JSON 导出全部结构化记忆（默认不含截图）
    export: (input?: IpcRequest<"data:export">) => invokeValidated(ipcRenderer, "data:export", input),
    // 清空所有结构化记忆数据 + 截图缓存（保留 settings/model_configs/privacy_rules/user_feedback）
    clearAll: () => invokeValidated(ipcRenderer, "data:clearAll"),
    // 查询截图缓存当前大小
    getCacheSize: () => invokeValidated(ipcRenderer, "data:getCacheSize"),
  },

  // -------------------- Phase 2 新增：timeline / personalReview / workReport / unfinishedThreads --------------------
  /**
   * timeline：今日时间轴
   * - build：触发 TimelineBuilder 生成当天时间轴（调用 LLM）
   * - get：获取当天已持久化的 timeline blocks（不调用 LLM）
   */
  timeline: {
    build: (dateKey: IpcRequest<"timeline:build">) => invokeValidated(ipcRenderer, "timeline:build", dateKey),
    reorganizeDay: (dateKey: IpcRequest<"timeline:reorganizeDay">) => invokeValidated(ipcRenderer, "timeline:reorganizeDay", dateKey),
    get: (dateKey: IpcRequest<"timeline:get">) => invokeValidated(ipcRenderer, "timeline:get", dateKey),
  },

  activity: {
    getDayOverview: (dateKey: IpcRequest<"activity:getDayOverview">) =>
      invokeValidated(ipcRenderer, "activity:getDayOverview", dateKey),
  },

  /**
   * personalReview：个人复盘
   * - generate：生成给用户自己看的今日复盘（type=personal_daily_review）
   * - get：获取已生成的个人复盘（按 dateKey 查询）
   */
  personalReview: {
    generate: (input: {
      dateKey: string;
      generationRequirement?: string;
    }): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("personalReview:generate", input),
    get: (dateKey: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("personalReview:get", dateKey),
  },

  /**
   * workReport：工作日报
   * - generate：基于用户选中的 TimelineBlock 生成工作日报（type=work_daily_report）
   * - get：获取已生成的工作日报
   * - saveSelection：保存用户选区（不生成日报）
   */
  workReport: {
    generate: (input: IpcRequest<"workReport:generate">) => invokeValidated(ipcRenderer, "workReport:generate", input),
    get: (dateKey: IpcRequest<"workReport:get">) => invokeValidated(ipcRenderer, "workReport:get", dateKey),
    saveSelection: (input: IpcRequest<"workReport:saveSelection">) => invokeValidated(ipcRenderer, "workReport:saveSelection", input),
  },

  /**
   * unfinishedThreads：待收尾列表
   * - list：查询待收尾（按 status / dateKey 过滤，默认返回 open）
   * - updateStatus：更新状态（open / done / snoozed / ignored）
   */
  unfinishedThreads: {
    list: (input?: {
      dateKey?: string;
      status?: "open" | "done" | "snoozed" | "ignored";
    }): Promise<IpcResult<unknown[]>> =>
      ipcRenderer.invoke("unfinishedThreads:list", input),
    updateStatus: (input: {
      id: string;
      status: "open" | "done" | "snoozed" | "ignored";
    }): Promise<IpcResult<null>> =>
      ipcRenderer.invoke("unfinishedThreads:updateStatus", input),
  },

  // -------------------- debug --------------------
  /**
   * debug：调试模式专用（DebugPage 用）
   * - listJobs：按时间范围查询 model_jobs 列表
   * - getJobDetails：查询单条 model_job 详情（含 rawInputJson / debugEventsJson）
   * - getRelatedRecords：按 job.createdAt ± N 秒查询关联落库记录
   *
   * 安全约束：main 进程 3 个 handler 均强制校验 isDebugMode()，关闭时返回 error
   */
  debug: {
    listJobs: (input: {
      startAt: string;
      endAt: string;
      limit?: number;
    }): Promise<
      | { ok: true; data: unknown[] }
      | { ok: false; error: string; code?: string }
    > => ipcRenderer.invoke("debug:listJobs", input),
    getJobDetails: (
      jobId: string
    ): Promise<
      | { ok: true; data: unknown }
      | { ok: false; error: string; code?: string }
    > => ipcRenderer.invoke("debug:getJobDetails", { jobId }),
    getRelatedRecords: (input: {
      createdAt: string;
      windowSeconds?: number;
    }): Promise<
      | {
          ok: true;
          data: {
            observations: unknown[];
            facts: unknown[];
            scenes: unknown[];
            proactiveItems: unknown[];
          };
        }
      | { ok: false; error: string; code?: string }
    > => ipcRenderer.invoke("debug:getRelatedRecords", input),
  },

  // -------------------- update（版本更新） --------------------
  update: {
    check: (input?: IpcRequest<"update:check">) => invokeValidated(ipcRenderer, "update:check", input),
    download: () => invokeValidated(ipcRenderer, "update:download"),
    installAndQuit: (input: IpcRequest<"update:installAndQuit">) => invokeValidated(ipcRenderer, "update:installAndQuit", input),
    getStatus: () => invokeValidated(ipcRenderer, "update:getStatus"),
    dismissVersion: (input: IpcRequest<"update:dismissVersion">) => invokeValidated(ipcRenderer, "update:dismissVersion", input),
    onProgress: (callback: (progress: { bytesDownloaded: number; bytesTotal: number; percent: number }) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, progress: { bytesDownloaded: number; bytesTotal: number; percent: number }): void => callback(progress);
      ipcRenderer.on("update:progress", handler);
      return () => {
        ipcRenderer.removeListener("update:progress", handler);
      };
    },
    onStatusChanged: (callback: (status: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: unknown): void => callback(status);
      ipcRenderer.on("update:statusChanged", handler);
      return () => {
        ipcRenderer.removeListener("update:statusChanged", handler);
      };
    },
  },
};

// 通过 contextBridge 暴露白名单 API 到 renderer（window.recallAPI）
contextBridge.exposeInMainWorld("recallAPI", recallApi);

// 类型导出：renderer 通过 import type 引用
export type RecallApi = typeof recallApi;
