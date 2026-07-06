// src/main/services/ScreenshotCacheScheduler.ts
// 截图缓存定时清理调度器（来自 06 文档"性能原则"）
//
// 职责：
// - 每小时检查一次过期截图并删除
// - 使用 settings 中的全局 retention policy
// - 失败不阻断主流程（仅记录日志）
// - 在应用退出前停止定时器
//
// 性能原则（来自 06 文档）：
// - 图片缓存定时清理（每小时检查一次过期截图）
// - 删除过期截图不影响结构化记忆

import type { ScreenshotCache } from "./ScreenshotCache";
import type { SettingsService } from "./SettingsService";
import { logger } from "./Logger";

/**
 * 调度器配置
 */
export interface SchedulerConfig {
  /** ScreenshotCache 实例 */
  screenshotCache: ScreenshotCache;
  /** SettingsService 实例（用于读取 retention policy） */
  settingsService: SettingsService;
  /** 检查间隔（毫秒），默认 1 小时 */
  intervalMs?: number;
}

/**
 * 截图缓存定时清理调度器
 *
 * 使用方式：
 *   startScreenshotCacheScheduler({ screenshotCache, settingsService });
 *   // 应用退出前：
 *   stopScreenshotCacheScheduler();
 */
let timer: NodeJS.Timeout | null = null;

export function startScreenshotCacheScheduler(config: SchedulerConfig): void {
  if (timer) {
    // 已启动则跳过
    return;
  }
  const intervalMs = config.intervalMs ?? 60 * 60 * 1000; // 默认 1 小时

  // 立即执行一次（在下一个 tick，避免阻塞启动）
  setTimeout(() => {
    void cleanupOnce(config);
  }, 10_000); // 启动 10 秒后执行首次清理

  // 定时执行
  timer = setInterval(() => {
    void cleanupOnce(config);
  }, intervalMs);

  // 防止 timer 阻止进程退出
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

export function stopScreenshotCacheScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 执行一次清理
 */
async function cleanupOnce(config: SchedulerConfig): Promise<void> {
  try {
    const settings = config.settingsService.getAll();
    const policy = settings.screenshot.retentionPolicy;
    const result = await config.screenshotCache.cleanupExpired(policy);
    if (result.deletedScreenshots > 0) {
      logger.info({
        jobType: "screenshot_cache_cleanup",
        status: "succeeded",
        durationMs: 0,
        message: `cleaned ${result.deletedScreenshots} screenshots, freed ${result.freedBytes} bytes`,
      });
    }
  } catch (err) {
    logger.warn({
      jobType: "screenshot_cache_cleanup",
      status: "failed",
      errorCode: "cleanup_error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
