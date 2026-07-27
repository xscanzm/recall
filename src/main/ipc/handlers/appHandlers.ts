import { app as electronApp, ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated, ipcFail } from "../validated";
import { LoginItemService } from "../../services/LoginItemService";

export function registerAppHandlers(deps: IpcDeps): void {
  const loginItemService = new LoginItemService(electronApp);
  let dragState: {
    windowId: number;
    pointerX: number;
    pointerY: number;
    windowX: number;
    windowY: number;
  } | null = null;
  handleValidated(ipcMain, "app:getStatus", () => deps.getStatus());
  handleValidated(ipcMain, "app:startObserving", async () => {
    if (deps.startObserving) await deps.startObserving();
    else deps.setStatus({ observing: true, paused: false, pipelineState: "idle", lastError: undefined });
    return deps.getStatus();
  });
  handleValidated(ipcMain, "app:pauseObserving", async () => {
    if (deps.pauseObserving) await deps.pauseObserving();
    else deps.setStatus({ observing: false, paused: true, pipelineState: "idle" });
    return deps.getStatus();
  });
  handleValidated(ipcMain, "app:getLaunchAtLogin", () => ({ ok: true, enabled: loginItemService.getEnabled() }));
  handleValidated(ipcMain, "app:setLaunchAtLogin", (_event, input) => {
    const enabled = loginItemService.setEnabled(input.enabled);
    if (enabled !== input.enabled) ipcFail("launch_at_login_failed", "Windows 未能保存 Recall 登录自启动设置");
    return { ok: true, enabled };
  });
  handleValidated(ipcMain, "window:minimize", () => {
    deps.getMainWindow()?.minimize();
    return { ok: true };
  });
  handleValidated(ipcMain, "window:toggleMaximize", () => {
    const window = deps.getMainWindow();
    if (window?.isMaximized()) window.unmaximize();
    else window?.maximize();
    return { ok: true };
  });
  handleValidated(ipcMain, "window:drag", (_event, input) => {
    const window = deps.getMainWindow();
    if (!window || window.isDestroyed()) {
      dragState = null;
      return { ok: true };
    }
    if (input.phase === "start") {
      if (window.isMaximized()) return { ok: true };
      const [windowX, windowY] = window.getPosition();
      dragState = {
        windowId: window.id,
        pointerX: input.screenX,
        pointerY: input.screenY,
        windowX,
        windowY,
      };
      return { ok: true };
    }
    if (input.phase === "move" && dragState?.windowId === window.id) {
      window.setPosition(
        Math.round(dragState.windowX + input.screenX - dragState.pointerX),
        Math.round(dragState.windowY + input.screenY - dragState.pointerY)
      );
      return { ok: true };
    }
    dragState = null;
    return { ok: true };
  });
  handleValidated(ipcMain, "window:close", () => {
    deps.getMainWindow()?.close();
    return { ok: true };
  });
}
