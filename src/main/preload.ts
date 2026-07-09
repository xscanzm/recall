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
import type { AppStatus, IpcResult } from "../shared/types";

/**
 * Renderer 调用的 IPC API 表面
 *
 * 每个 invoke 方法对应一个 IpcChannel（23 个）
 * 每个 on 方法对应一个 push channel（如 app:statusChanged）
 */
const recallApi = {
  // -------------------- app --------------------
  app: {
    getStatus: (): Promise<AppStatus> => ipcRenderer.invoke("app:getStatus"),
    startObserving: (): Promise<AppStatus> => ipcRenderer.invoke("app:startObserving"),
    pauseObserving: (): Promise<AppStatus> => ipcRenderer.invoke("app:pauseObserving"),
    onStatusChanged: (callback: (status: AppStatus) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: AppStatus): void => callback(status);
      ipcRenderer.on("app:statusChanged", handler);
      return () => {
        ipcRenderer.removeListener("app:statusChanged", handler);
      };
    },
  },

  // -------------------- settings --------------------
  settings: {
    get: <T>(): Promise<T> => ipcRenderer.invoke("settings:get"),
    update: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("settings:update", input),
  },

  // -------------------- model --------------------
  model: {
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
    search: <T>(input: { query: string; limit?: number; offset?: number }): Promise<{ results: T[]; total: number }> =>
      ipcRenderer.invoke("memory:search", input),
    updateFact: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:updateFact", input),
    updateTask: (input: unknown): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:updateTask", input),
    deleteObject: (input: { id: string; type: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("memory:deleteObject", input),
    // M7 新增：轻量问答
    ask: (input: {
      question: string;
      limit?: number;
    }): Promise<{
      ok: boolean;
      answer?: string;
      sources?: Array<{
        id: string;
        type: "fact" | "scene" | "task" | "project" | "decision" | "report" | "person";
        title: string;
        summary?: string;
      }>;
      searchCount?: number;
      code?: string;
      message?: string;
    }> => ipcRenderer.invoke("memory:ask", input),
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
    listPeople: <T>(): Promise<{ ok: true; people: T[] }> => ipcRenderer.invoke("memory:listPeople"),
    listProjects: <T>(): Promise<{ ok: true; projects: T[] }> => ipcRenderer.invoke("memory:listProjects"),
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
    generate: (input: {
      type: "daily" | "weekly" | "monthly" | "retrospective";
      dateKey: string;
      projectId?: string;
    }): Promise<{ ok: boolean; reportId?: string; code?: string; message?: string }> =>
      ipcRenderer.invoke("reports:generate", input),
    update: (input: { id: string; contentJson: string }): Promise<{ ok: true; report?: unknown }> =>
      ipcRenderer.invoke("reports:update", input),
    delete: (input: { id: string }): Promise<boolean> =>
      ipcRenderer.invoke("reports:delete", input),
  },

  // -------------------- capture --------------------
  capture: {
    forgetRecent: (input: { duration: "15m" | "30m" | "1h" | "today" }): Promise<{
      ok: true;
      deletedObservations: number;
      deletedScreenshots: number;
    }> => ipcRenderer.invoke("capture:forgetRecent", input),
  },

  // -------------------- screenshot --------------------
  screenshot: {
    clear: (): Promise<{ ok: true; deletedScreenshots: number }> =>
      ipcRenderer.invoke("screenshot:clear"),
  },

  // -------------------- data（M8 新增） --------------------
  data: {
    // JSON 导出全部结构化记忆（默认不含截图）
    export: (input?: { includeScreenshots?: boolean }): Promise<{
      ok: boolean;
      export?: {
        meta: {
          version: string;
          exportedAt: string;
          includeScreenshots: boolean;
        };
        observations: unknown[];
        facts: unknown[];
        scenes: unknown[];
        tasks: unknown[];
        decisions: unknown[];
        people: unknown[];
        projects: unknown[];
        reports: unknown[];
      };
      code?: string;
      message?: string;
    }> => ipcRenderer.invoke("data:export", input),
    // 清空所有结构化记忆数据 + 截图缓存（保留 settings/model_configs/privacy_rules/user_feedback）
    clearAll: (): Promise<{ ok: boolean; deletedScreenshots: number; code?: string; message?: string }> =>
      ipcRenderer.invoke("data:clearAll"),
    // 查询截图缓存当前大小
    getCacheSize: (): Promise<{ ok: true; bytes: number; fileCount: number }> =>
      ipcRenderer.invoke("data:getCacheSize"),
  },

  // -------------------- Phase 2 新增：timeline / personalReview / workReport / unfinishedThreads --------------------
  /**
   * timeline：今日时间轴
   * - build：触发 TimelineBuilder 生成当天时间轴（调用 LLM）
   * - get：获取当天已持久化的 timeline blocks（不调用 LLM）
   */
  timeline: {
    build: (dateKey: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("timeline:build", dateKey),
    get: (dateKey: string): Promise<IpcResult<unknown[]>> =>
      ipcRenderer.invoke("timeline:get", dateKey),
  },

  /**
   * personalReview：个人复盘
   * - generate：生成给用户自己看的今日复盘（type=personal_daily_review）
   * - get：获取已生成的个人复盘（按 dateKey 查询）
   */
  personalReview: {
    generate: (dateKey: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("personalReview:generate", dateKey),
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
    generate: (input: {
      dateKey: string;
      selectedBlockIds: string[];
      style: "brief" | "standard" | "formal";
      recipientHint?: "manager" | "team" | "client" | "self";
    }): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("workReport:generate", input),
    get: (dateKey: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke("workReport:get", dateKey),
    saveSelection: (input: {
      dateKey: string;
      selectedBlockIds: string[];
      excludedBlockIds: string[];
    }): Promise<IpcResult<null>> =>
      ipcRenderer.invoke("workReport:saveSelection", input),
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
};

// 通过 contextBridge 暴露白名单 API 到 renderer（window.recallAPI）
contextBridge.exposeInMainWorld("recallAPI", recallApi);

// 类型导出：renderer 通过 import type 引用
export type RecallApi = typeof recallApi;
