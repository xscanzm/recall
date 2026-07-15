// src/shared/updateTypes.ts
// 版本更新相关的共享类型（main / renderer / shared 共用）
//
// 重要约束：
// - 所有时间字段使用 UTC ISO 8601 with Z 后缀
// - UpdateInfo 由 CF Worker /api/check 返回，经 main 端 UpdateService 解析

/**
 * 更新检查结果
 * - hasUpdate=false 时 latestVersion 等于 currentVersion
 * - downloadUrl 为相对路径（如 "/download/Recall-0.1.2-setup.exe"），由 main 端拼接 Worker URL
 */
export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  sha256: string;
  releaseNotes: string;
  publishedAt: string; // ISO 8601 with Z
}

/**
 * 下载进度
 */
export interface DownloadProgress {
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number; // 0-100
}

/**
 * 更新状态机
 * - idle: 初始空闲
 * - checking: 正在检查
 * - hasUpdate: 检测到新版本
 * - noUpdate: 已是最新
 * - downloading: 下载中（含进度）
 * - downloaded: 下载完成（含安装包路径）
 * - installing: 正在启动安装程序
 * - error: 错误（含消息）
 */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "hasUpdate"; info: UpdateInfo }
  | { state: "noUpdate"; info: UpdateInfo }
  | { state: "downloading"; progress: DownloadProgress }
  | { state: "downloaded"; installerPath: string; info: UpdateInfo }
  | { state: "installing" }
  | { state: "error"; message: string; code?: string };

/**
 * 持久化到 settings.json 的 update 字段
 * - lastCheckedAt: 上次检查时间（ISO Z 或 null）
 * - latestVersion: 最近检查到的最新版本号
 * - dismissedVersion: 用户已忽略的版本（不再提醒，直到更新版本出现）
 * - downloadedInstallerPath: 已下载完成的安装包路径（重启后可复用）
 */
export interface UpdateSettings {
  lastCheckedAt: string | null;
  latestVersion: string | null;
  dismissedVersion: string | null;
  downloadedInstallerPath: string | null;
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  lastCheckedAt: null,
  latestVersion: null,
  dismissedVersion: null,
  downloadedInstallerPath: null,
};
