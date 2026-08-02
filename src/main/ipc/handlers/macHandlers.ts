import { ipcMain } from "electron";
import { macPermissionsService } from "../../services/MacPermissionsService";
import type { IpcDeps } from "../handlers";
import { handleValidated } from "../validated";

/** macOS 专属支持 handlers */
export function registerMacHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "mac:checkPermissions", () => {
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

  handleValidated(ipcMain, "mac:openSystemSettings", async (_event, input) => {
    const success = await macPermissionsService.openSystemSettings(input.privacyType);
    return { ok: true as const, data: { success } };
  });
}
