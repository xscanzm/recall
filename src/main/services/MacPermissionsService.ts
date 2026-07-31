import { systemPreferences, shell } from "electron";
import { logger } from "./Logger";

export interface MacPermissionStatus {
  isMac: boolean;
  screenCaptureGranted: boolean;
  accessibilityGranted: boolean;
  screenCaptureStatus: string;
}

export class MacPermissionsService {
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform = process.platform) {
    this.platform = platform;
  }

  /**
   * 检查当前 macOS 系统的关键隐私权限状态（屏幕录制 + 辅助功能）
   */
  checkPermissions(): MacPermissionStatus {
    if (this.platform !== "darwin") {
      return {
        isMac: false,
        screenCaptureGranted: true,
        accessibilityGranted: true,
        screenCaptureStatus: "not_applicable",
      };
    }

    let screenStatus = "unknown";
    let screenGranted = false;
    let accessibilityGranted = false;

    try {
      if (typeof systemPreferences.getMediaAccessStatus === "function") {
        screenStatus = systemPreferences.getMediaAccessStatus("screen");
        screenGranted = screenStatus === "granted";
      }
    } catch (err) {
      logger.warn({
        jobType: "mac_permissions",
        status: "failed",
        errorCode: "check_screen_permission_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      if (typeof systemPreferences.isTrustedAccessibilityClient === "function") {
        accessibilityGranted = systemPreferences.isTrustedAccessibilityClient(false);
      }
    } catch (err) {
      logger.warn({
        jobType: "mac_permissions",
        status: "failed",
        errorCode: "check_accessibility_permission_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      isMac: true,
      screenCaptureGranted: screenGranted,
      accessibilityGranted,
      screenCaptureStatus: screenStatus,
    };
  }

  /**
   * 打开 macOS 系统偏好设置中的对应隐私面板
   */
  async openSystemSettings(privacyType: "screen" | "accessibility"): Promise<boolean> {
    if (this.platform !== "darwin") return false;

    const url =
      privacyType === "screen"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        : "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    try {
      await shell.openExternal(url);
      return true;
    } catch (err) {
      logger.error({
        jobType: "mac_permissions",
        status: "failed",
        errorCode: "open_settings_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

export const macPermissionsService = new MacPermissionsService();
