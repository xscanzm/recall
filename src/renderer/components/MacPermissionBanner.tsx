// src/renderer/components/MacPermissionBanner.tsx
// macOS 权限引导横幅
//
// 当 AppStatus.macPermissions 显示屏幕录制或辅助功能权限未授予时，
// 在 TodayPage 顶部显示引导横幅，带"去系统设置授权"按钮。
// 用户从系统设置回来后点击"我已授权，重新检查"刷新状态。

import { useState } from "react";
import { getIpc } from "../state/ipc";
import type { AppStatus } from "../../shared/types";

interface MacPermissionBannerProps {
  macPermissions: NonNullable<AppStatus["macPermissions"]>;
}

export function MacPermissionBanner({ macPermissions }: MacPermissionBannerProps) {
  const [rechecking, setRechecking] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // 两个权限都授予了，不显示
  if (macPermissions.screenCaptureGranted && macPermissions.accessibilityGranted) {
    return null;
  }

  // 用户手动关闭横幅（仍可从设置页重新打开，此处仅本地态）
  if (dismissed) {
    return null;
  }

  const needScreen = !macPermissions.screenCaptureGranted;
  const needAccessibility = !macPermissions.accessibilityGranted;

  const handleOpenSettings = async (privacyType: "screen" | "accessibility") => {
    try {
      await getIpc().mac.openSystemSettings(privacyType);
    } catch {
      // 静默失败
    }
  };

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      // 调用 checkPermissions 后，main 进程会通过 onStatusChanged 推送新状态
      await getIpc().mac.checkPermissions();
    } catch {
      // 静默失败
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className="mac-perm-banner">
      <div className="mac-perm-banner__body">
        <div className="mac-perm-banner__title">
          macOS 权限未完全授权
        </div>
        <div className="mac-perm-banner__desc">
          Recall 需要以下权限才能正常工作：
          <ul>
            {needScreen && (
              <li>
                <strong>屏幕录制</strong>：用于捕获当前活动窗口构建记忆（未授予时截图采集不可用）
              </li>
            )}
            {needAccessibility && (
              <li>
                <strong>辅助功能</strong>：用于识别当前活动应用信息
              </li>
            )}
          </ul>
          <p className="mac-perm-banner__hint">
            点击下方按钮跳转到系统设置授权，授权后回到 Recall 点击"重新检查"。
          </p>
        </div>
      </div>
      <div className="mac-perm-banner__actions">
        {needScreen && (
          <button
            className="mac-perm-banner__btn mac-perm-banner__btn--primary"
            onClick={() => handleOpenSettings("screen")}
          >
            授权屏幕录制
          </button>
        )}
        {needAccessibility && (
          <button
            className="mac-perm-banner__btn"
            onClick={() => handleOpenSettings("accessibility")}
          >
            授权辅助功能
          </button>
        )}
        <button
          className="mac-perm-banner__btn"
          onClick={handleRecheck}
          disabled={rechecking}
        >
          {rechecking ? "检查中..." : "重新检查"}
        </button>
        <button
          className="mac-perm-banner__btn mac-perm-banner__btn--ghost"
          onClick={() => setDismissed(true)}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}
