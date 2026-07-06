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
import type { AppStatus } from "../shared/types";

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
      kind: "vision" | "language";
      endpoint: string;
      model: string;
      apiKey: string;
    }): Promise<{ ok: boolean; code?: string; message?: string }> =>
      ipcRenderer.invoke("model:testConnection", input),
    // M8 新增：列出模型配置（不返回 API Key）
    listConfigs: <T>(input?: {
      kind?: "vision" | "language";
      enabled?: boolean;
    }): Promise<T[]> => ipcRenderer.invoke("model:listConfigs", input),
    // M8 新增：保存模型配置（创建或更新），apiKey 可选（不传则保留原 key）
    saveConfig: (input: {
      id?: string;
      kind: "vision" | "language";
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
    }): Promise<{ ok: true; merged: { ok: true; fromId: string; toId: string; objectType: string } }> =>
      ipcRenderer.invoke("memory:mergeObjects", input),
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
      type: "daily" | "weekly" | "retrospective";
      dateKey: string;
    }): Promise<{ ok: boolean; reportId?: string; code?: string; message?: string }> =>
      ipcRenderer.invoke("reports:generate", input),
    update: (input: { id: string; contentJson: string }): Promise<{ ok: true; report?: unknown }> =>
      ipcRenderer.invoke("reports:update", input),
  },

  // -------------------- capture --------------------
  capture: {
    forgetRecent: (input: { duration: "15m" | "30m" | "1h" | "today" }): Promise<{
      ok: true;
      deletedObservations: number;
      deletedScreenshots: number;
    }> => ipcRenderer.invoke("capture:forgetRecent", input),
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
};

// 通过 contextBridge 暴露白名单 API 到 renderer（window.recallAPI）
contextBridge.exposeInMainWorld("recallAPI", recallApi);

// 类型导出：renderer 通过 import type 引用
export type RecallApi = typeof recallApi;
