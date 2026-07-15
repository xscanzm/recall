// src/main/services/UpdateCheckerScheduler.ts
// 版本更新定时检查调度器
//
// 职责：
// - 应用启动 10 秒后首次检查
// - 之后每 4 小时检查一次
// - 检测到新版本时回调通知（由 app.ts 推送给 renderer）
// - 失败不阻断主流程（仅记录日志）
// - 在应用退出前停止定时器
//
// 参考 ScreenshotCacheScheduler.ts 模板

import type { UpdateService } from "./UpdateService";
import type { UpdateInfo } from "../../shared/updateTypes";
import { logger } from "./Logger";

export interface UpdateCheckerConfig {
  updateService: UpdateService;
  /** 检查间隔（毫秒），默认 4 小时 */
  intervalMs?: number;
  /** 检测到新版本时的回调 */
  onHasUpdate: (info: UpdateInfo) => void;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

/**
 * 启动定时检查
 *
 * 使用方式：
 *   startUpdateCheckerScheduler({ updateService, onHasUpdate: (info) => {...} });
 *   // 应用退出前：
 *   stopUpdateCheckerScheduler();
 */
export function startUpdateCheckerScheduler(config: UpdateCheckerConfig): void {
  if (timer || initialTimer) {
    // 已启动则跳过
    return;
  }

  const intervalMs = config.intervalMs ?? 4 * 60 * 60 * 1000; // 默认 4 小时

  const checkOnce = async (): Promise<void> => {
    try {
      // 下载/安装中跳过本次检查
      const status = config.updateService.getStatus();
      if (status.state === "downloading" || status.state === "installing") {
        return;
      }

      const info = await config.updateService.checkForUpdates();
      if (info.hasUpdate) {
        config.onHasUpdate(info);
      }
    } catch (err) {
      logger.warn({
        jobType: "update_check",
        status: "failed",
        errorCode: "scheduled_check_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 启动 10 秒后执行首次检查
  initialTimer = setTimeout(() => {
    void checkOnce();
    initialTimer = null;
  }, 10_000);

  // 定时执行
  timer = setInterval(() => {
    void checkOnce();
  }, intervalMs);

  // 防止 timer 阻止进程退出
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  if (initialTimer && typeof initialTimer.unref === "function") {
    initialTimer.unref();
  }
}

/**
 * 停止定时检查
 */
export function stopUpdateCheckerScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
}
