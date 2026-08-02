// src/main/ipc/handlers/updateHandlers.ts
// 版本更新相关 IPC handlers
//
// 注册的 channel：
// - app:getVersion            获取当前应用版本号（不依赖 updateService）
// - update:check              检查更新
// - update:download           下载更新（基于 lastCheckInfo）
// - update:installAndQuit     启动安装程序并退出应用
// - update:getStatus          获取当前 UpdateStatus 状态机
// - update:dismissVersion    忽略某版本
//
// Push channel（通过 webContents.send 主动推送到 renderer）：
// - update:progress           下载进度（bytesDownloaded / bytesTotal / percent）
// - update:statusChanged      UpdateStatus 状态变化

import { app, ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated, ipcFail } from "../validated";
import type { UpdateInfo, UpdateStatus, DownloadProgress } from "../../../shared/updateTypes";

export function registerUpdateHandlers(deps: IpcDeps): void {
  // app:getVersion - 获取当前应用版本号（不依赖 updateService，独立可用）
  handleValidated(ipcMain, "app:getVersion", () => {
    return { version: app.getVersion() };
  });

  // update:check - 检查更新
  // input.force 暂未实现绕过 dismissed 逻辑（UpdateService 内部已处理 dismissed 抑制）
  handleValidated(ipcMain, "update:check", async (_event, input) => {
    void input?.force;
    const svc = deps.updateService;
    if (!svc) ipcFail("update_service_unavailable", "UpdateService not initialized");

    // 先推送 checking 状态，让 UI 立即响应
    pushUpdateStatus(deps, { state: "checking" });

    try {
      const info: UpdateInfo = await svc.checkForUpdates();
      // checkForUpdates 内部已更新 status，推送最新状态
      pushUpdateStatus(deps, svc.getStatus());
      return info;
    } catch (err) {
      pushUpdateStatus(deps, svc.getStatus());
      throw err;
    }
  });

  // update:download - 下载更新（无 input，使用 lastCheckInfo）
  handleValidated(ipcMain, "update:download", async () => {
    const svc = deps.updateService;
    if (!svc) ipcFail("update_service_unavailable", "UpdateService not initialized");

    const info = svc.getLastCheckInfo();
    if (!info || !info.hasUpdate) {
      ipcFail("no_update_available", "无可下载的更新，请先检查更新");
    }

    try {
      const installerPath = await svc.downloadUpdate(info, (progress: DownloadProgress) => {
        pushUpdateProgress(deps, progress);
      });
      pushUpdateStatus(deps, svc.getStatus());
      return { installerPath };
    } catch (err) {
      pushUpdateStatus(deps, svc.getStatus());
      throw err;
    }
  });

  // update:installAndQuit - 启动安装程序并退出应用
  // P0：无输入。安装包路径由 UpdateService 内部保存（downloadUpdate 成功时写入），
  // 渲染层传入的 installerPath 会被契约 schema 拒绝（schema_invalid）。
  handleValidated(ipcMain, "update:installAndQuit", async () => {
    const svc = deps.updateService;
    if (!svc) ipcFail("update_service_unavailable", "UpdateService not initialized");

    // 推送 installing 状态
    pushUpdateStatus(deps, { state: "installing" });

    await svc.installAndQuit();
    // installAndQuit 成功后会 app.quit()，以下代码不会执行
    return { ok: true as const };
  });

  // update:getStatus - 获取当前状态机
  handleValidated(ipcMain, "update:getStatus", () => {
    const svc = deps.updateService;
    if (!svc) ipcFail("update_service_unavailable", "UpdateService not initialized");
    return svc.getStatus();
  });

  // update:dismissVersion - 忽略某版本
  handleValidated(ipcMain, "update:dismissVersion", (_event, input) => {
    const svc = deps.updateService;
    if (!svc) ipcFail("update_service_unavailable", "UpdateService not initialized");
    svc.dismissVersion(input.version);
    pushUpdateStatus(deps, svc.getStatus());
    return { ok: true as const };
  });
}

/**
 * 推送更新状态变化到 renderer
 * - 失败静默忽略（窗口可能已销毁）
 */
function pushUpdateStatus(deps: IpcDeps, status: UpdateStatus): void {
  try {
    deps.getMainWindow()?.webContents.send("update:statusChanged", status);
  } catch {
    // 推送失败忽略
  }
}

/**
 * 推送下载进度到 renderer
 * - 失败静默忽略
 */
function pushUpdateProgress(deps: IpcDeps, progress: DownloadProgress): void {
  try {
    deps.getMainWindow()?.webContents.send("update:progress", progress);
  } catch {
    // 推送失败忽略
  }
}
