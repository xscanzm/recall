// src/renderer/state/ipc.ts
// Renderer 端 IPC 客户端封装
//
// 通过 preload 暴露的 window.recallAPI 调用 main 进程能力
// 这是 renderer 唯一允许的 main 进程调用入口

import type { RecallApi } from "../../main/preload";

/**
 * 全局 window 类型扩展
 */
declare global {
  interface Window {
    recallAPI: RecallApi;
  }
}

/**
 * IPC 客户端单例
 */
export const ipc = (window as unknown as { recallAPI: RecallApi }).recallAPI;

/**
 * 安全获取 IPC 客户端，preload 未注入时给出明确错误
 */
export function getIpc(): RecallApi {
  if (!ipc) {
    throw new Error(
      "window.recallAPI 未注入。preload 脚本可能未加载，或 contextBridge 配置错误。"
    );
  }
  return ipc;
}
