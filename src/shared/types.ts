// src/shared/types.ts
// 跨进程共享的类型定义（main 与 renderer 都可引用）
// 重要：本文件不得引入 Node-only 或 DOM-only API，保持纯类型导出

/**
 * 全局 App Status（来自 06_TECHNICAL_ARCHITECTURE.md）
 *
 * 用户必须始终能看到当前状态：
 * 观察中 / 已暂停 / 黑名单跳过 / 敏感内容跳过 / 模型错误 / 正在整理。
 */
export interface AppStatus {
  observing: boolean;
  paused: boolean;
  currentWindow?: {
    appName: string;
    windowTitle: string;
    privacyState: "allowed" | "blocked" | "sensitive" | "unknown";
  };
  pipelineState:
    | "idle"
    | "capturing"
    | "observing"
    | "extracting"
    | "linking"
    | "judging"
    | "reporting"
    | "error";
  lastError?: string;
}

/**
 * 隐私规则（M0 仅占位，M3 PrivacyGuard 实现完整逻辑）
 */
export interface PrivacyRule {
  id: string;
  type: "app_name" | "window_title_keyword" | "domain_keyword";
  pattern: string;
  action: "exclude" | "ask_before_capture" | "blur_sensitive";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 模型配置（API Key 不在本结构中，存于 SecretService）
 */
export interface ModelConfig {
  id: string;
  kind: "vision" | "language";
  providerName: string;
  endpoint: string;
  model: string;
  optionsJson: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * 渲染进程通过 IPC 调用的状态变化回调
 */
export type StatusListener = (status: AppStatus) => void;

/**
 * 通用 IPC 调用结果封装（可选）
 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };
