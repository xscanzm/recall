// src/main/services/ScreenshotCache.ts
// 截图本地缓存与保留策略（来自 01、07 文档）
//
// 职责（来自 06 文档）：
// - 保存截图到本地 cache 目录：%APPDATA%/Recall/cache/screenshots/YYYY-MM-DD/
// - 按 retention policy 删除
// - 应用启动时清理过期截图
// - 支持用户手动"忘掉最近"
//
// 文件名规范（重要）：
// - capture_<timestamp>_<random>.png
// - stitched_<timestamp>_<random>.png
// - 文件名不包含窗口标题、URL、用户文本
//
// 默认保留当天，可选：立即删除 / 1 小时 / 6 小时 / 当天 / 3 天 / 7 天
//
// 实现要求：
// - 截图仅本地保存
// - 存 app data cache 目录
// - 文件名不包含窗口标题、URL、用户文本
// - 删除过期截图后，Observation 的 screenshot_retention 更新为 expired
// - 用户可一键清空所有截图缓存
// - 启动时清理过期截图
// - 每条 observation 记录截图 retention 状态和本地路径是否存在
// - 删除过期截图不影响结构化记忆
// - UI 不展示截图墙

import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { SCREENSHOT_CACHE_DIR } from "../../shared/constants";
import type { ScreenshotRetentionPolicy } from "../models/types";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";

/**
 * 保存输入参数
 */
export interface SaveScreenshotInput {
  /** PNG buffer */
  buffer: Buffer;
  /** 文件名前缀（capture / stitched） */
  prefix: "capture" | "stitched";
  /** 捕获时间（用于决定 YYYY-MM-DD 子目录），默认当前时间 */
  capturedAt?: Date;
}

/**
 * 保存结果
 */
export interface SaveScreenshotResult {
  /** 完整文件路径 */
  filePath: string;
  /** 文件名（不含路径） */
  fileName: string;
  /** 相对 cacheRoot 的路径（如 2026-07-05/capture_xxx.png），用于日志 */
  relativePath: string;
}

/**
 * 清理结果
 */
export interface CleanupResult {
  deletedScreenshots: number;
  /** 已删除文件大小（字节） */
  freedBytes: number;
}

/**
 * 截图本地缓存与保留策略管理
 */
export class ScreenshotCache {
  private cacheRoot: string;
  private observationRepo: ObservationRepository | null = null;

  constructor() {
    this.cacheRoot = path.join(app.getPath("userData"), SCREENSHOT_CACHE_DIR);
  }

  /**
   * 注入 ObservationRepository
   * 用于在删除过期截图后更新 observation.screenshot_retention = expired
   */
  setObservationRepository(repo: ObservationRepository): void {
    this.observationRepo = repo;
  }

  /**
   * 生成不含窗口标题/URL/用户文本的安全文件名
   * 格式：capture_<timestamp>_<random>.png 或 stitched_<timestamp>_<random>.png
   */
  generateFilename(prefix: "capture" | "stitched", capturedAt: Date = new Date()): string {
    const timestamp = capturedAt.getTime();
    const random = Math.random().toString(36).slice(2, 10);
    return `${prefix}_${timestamp}_${random}.png`;
  }

  /**
   * 获取 cache 根目录
   */
  getCacheRoot(): string {
    return this.cacheRoot;
  }

  /**
   * 获取某天对应的子目录路径
   * 格式：cacheRoot/YYYY-MM-DD/
   */
  getDayDir(date: Date = new Date()): string {
    const dayKey = formatDateKey(date);
    return path.join(this.cacheRoot, dayKey);
  }

  /**
   * 保存截图到 cache 目录
   * - 自动按 YYYY-MM-DD 子目录归档
   * - 文件名不含窗口标题/URL/用户文本
   * - 返回完整路径（仅 main 进程持有，不通过 IPC 暴露给 renderer）
   */
  async save(input: SaveScreenshotInput): Promise<SaveScreenshotResult> {
    const capturedAt = input.capturedAt ?? new Date();
    const dayDir = this.getDayDir(capturedAt);
    await fsp.mkdir(dayDir, { recursive: true });

    const fileName = this.generateFilename(input.prefix, capturedAt);
    const filePath = path.join(dayDir, fileName);
    const relativePath = path.join(formatDateKey(capturedAt), fileName);

    await fsp.writeFile(filePath, input.buffer);

    return { filePath, fileName, relativePath };
  }

  /**
   * 启动时清理过期截图
   * - 遍历所有 YYYY-MM-DD 子目录
   * - 按文件 mtime（修改时间）判定是否过期
   * - 默认策略来自 settings.screenshot.retentionPolicy
   * - 删除文件后更新对应 observation 的 screenshot_retention = expired
   *
   * 注意：单个 observation 可能有自己的 retentionPolicy（更激进/保守）
   * 这里按全局策略清理；observation 级别的精确清理由 forgetRecent/clearAll 处理
   */
  async cleanupExpired(
    globalPolicy: ScreenshotRetentionPolicy,
    protectedImagePaths: Iterable<string> = []
  ): Promise<CleanupResult> {
    let deletedScreenshots = 0;
    let freedBytes = 0;
    const protectedPaths = new Set(
      Array.from(protectedImagePaths, normalizeCachePath)
    );

    if (!fs.existsSync(this.cacheRoot)) {
      return { deletedScreenshots, freedBytes };
    }

    const now = Date.now();
    const dayDirs = await this.listDayDirs();

    for (const dayDir of dayDirs) {
      const files = await this.listFiles(dayDir);
      for (const file of files) {
        const fullPath = path.join(dayDir, file);
        if (protectedPaths.has(normalizeCachePath(fullPath))) continue;
        try {
          const stat = await fsp.stat(fullPath);
          const fileTime = stat.mtimeMs;
          const expiredMs = this.computeExpirationMs(globalPolicy, new Date(fileTime));
          // 若策略为 delete_immediately，立即清理（一般不在启动时执行，但安全起见也清理）
          if (globalPolicy === "delete_immediately" || now >= fileTime + expiredMs) {
            await fsp.unlink(fullPath);
            deletedScreenshots++;
            freedBytes += stat.size;
          }
        } catch {
          // 文件可能在遍历过程中被删除，忽略
        }
      }

      // 若子目录已空，移除目录
      try {
        const remaining = await this.listFiles(dayDir);
        if (remaining.length === 0) {
          await fsp.rmdir(dayDir);
        }
      } catch {
        // 忽略
      }
    }

    // 标记对应 observation 的 screenshot_retention = expired
    // 注意：仅标记被清理的截图对应的 observation，需要 observation_repo 提供按路径更新接口
    // 这里通过 setObservationRepository 注入的 repo 来批量更新
    if (this.observationRepo) {
      try {
        await this.observationRepo.markExpiredScreenshots();
      } catch {
        // 不阻断清理流程
      }
    }

    return { deletedScreenshots, freedBytes };
  }

  /**
   * 用户"忘掉最近"时间范围删除
   * - durationMinutes 分钟内的截图全部硬删除
   * - 不修改 observation（由上层 CaptureService/IPC 调用 ObservationRepository.deleteByCapturedAt）
   * - 返回删除文件数
   */
  async forgetRecent(durationMinutes: number): Promise<{ deletedScreenshots: number }> {
    let deletedScreenshots = 0;
    const threshold = Date.now() - durationMinutes * 60 * 1000;

    if (!fs.existsSync(this.cacheRoot)) {
      return { deletedScreenshots };
    }

    const dayDirs = await this.listDayDirs();
    for (const dayDir of dayDirs) {
      const files = await this.listFiles(dayDir);
      for (const file of files) {
        const fullPath = path.join(dayDir, file);
        try {
          const stat = await fsp.stat(fullPath);
          if (stat.mtimeMs >= threshold) {
            await fsp.unlink(fullPath);
            deletedScreenshots++;
          }
        } catch {
          // 忽略
        }
      }

      // 若子目录已空，移除目录
      try {
        const remaining = await this.listFiles(dayDir);
        if (remaining.length === 0) {
          await fsp.rmdir(dayDir);
        }
      } catch {
        // 忽略
      }
    }

    return { deletedScreenshots };
  }

  /**
   * 一键清空所有截图缓存
   * - 删除 cacheRoot 下所有文件和子目录
   * - 不删除 cacheRoot 本身（保留以便后续写入）
   * - 返回删除文件数
   */
  async clearAll(): Promise<{ deletedScreenshots: number; attempted: number; failed: number }> {
    let deletedScreenshots = 0;
    let attempted = 0;
    let failed = 0;

    if (!fs.existsSync(this.cacheRoot)) {
      return { deletedScreenshots, attempted, failed };
    }

    const entries = await fsp.readdir(this.cacheRoot, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(this.cacheRoot, entry.name);
      try {
        if (entry.isDirectory()) {
          const files = await this.listFiles(fullPath);
          for (const file of files) {
            attempted++;
            try { await fsp.unlink(path.join(fullPath, file)); deletedScreenshots++; } catch { failed++; }
          }
          try { await fsp.rmdir(fullPath); } catch { /* failed files keep the directory retryable */ }
        } else if (entry.isFile()) {
          attempted++;
          await fsp.unlink(fullPath);
          deletedScreenshots++;
        }
      } catch {
        failed++;
      }
    }

    return { deletedScreenshots, attempted, failed };
  }

  /**
   * 删除指定路径列表中的截图文件
   * - 用于删除单次 capture 的截图（如 high_sensitive 触发删除）
   * - 文件不存在时忽略
   */
  async deleteFiles(filePaths: string[]): Promise<{ deletedScreenshots: number; attempted: number; failed: number }> {
    let deletedScreenshots = 0;
    let attempted = 0;
    let failed = 0;
    for (const filePath of filePaths) {
      // 安全检查：只允许在 cacheRoot 内删除
      if (!this.isPathInsideCache(filePath)) {
        attempted++;
        failed++;
        continue;
      }
      attempted++;
      try {
        await fsp.unlink(filePath);
        deletedScreenshots++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed++;
      }
    }
    return { deletedScreenshots, attempted, failed };
  }

  /**
   * 删除单个文件（同步，用于 immediate 删除）
   */
  deleteFileSync(filePath: string): boolean {
    if (!this.isPathInsideCache(filePath)) {
      return false;
    }
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 计算 retention policy 对应的过期时间（毫秒）
   * - delete_immediately: 0（立即过期）
   * - 1h: 1 小时
   * - 6h: 6 小时
   * - today: 当天 23:59:59
   * - 3d: 3 天
   * - 7d: 7 天
   *
   * 对于 today，需要根据捕获时间计算当天 23:59:59
   */
  private computeExpirationMs(policy: ScreenshotRetentionPolicy, capturedAt: Date): number {
    switch (policy) {
      case "delete_immediately":
        return 0;
      case "1h":
        return 1 * 60 * 60 * 1000;
      case "6h":
        return 6 * 60 * 60 * 1000;
      case "3d":
        return 3 * 24 * 60 * 60 * 1000;
      case "7d":
        return 7 * 24 * 60 * 60 * 1000;
      case "today": {
        // 当天 23:59:59.999 减去捕获时间
        const endOfDay = new Date(capturedAt);
        endOfDay.setHours(23, 59, 59, 999);
        return endOfDay.getTime() - capturedAt.getTime();
      }
      default:
        return 24 * 60 * 60 * 1000; // 默认 1 天
    }
  }

  /**
   * 检查路径是否在 cacheRoot 内
   * - 防止路径穿越攻击
   */
  private isPathInsideCache(filePath: string): boolean {
    const resolved = path.resolve(filePath);
    const normalizedRoot = path.resolve(this.cacheRoot);
    return resolved.startsWith(normalizedRoot + path.sep) || resolved === normalizedRoot;
  }

  /**
   * 列出 cacheRoot 下所有 YYYY-MM-DD 子目录
   */
  private async listDayDirs(): Promise<string[]> {
    if (!fs.existsSync(this.cacheRoot)) {
      return [];
    }
    const entries = await fsp.readdir(this.cacheRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      // YYYY-MM-DD 格式
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        dirs.push(path.join(this.cacheRoot, entry.name));
      }
    }
    return dirs;
  }

  /**
   * 列出某目录下所有 PNG 文件
   */
  private async listFiles(dirPath: string): Promise<string[]> {
    try {
      const entries = await fsp.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".png"))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * 计算 cache 目录总大小（字节）
   */
  async getCacheSize(): Promise<{ bytes: number; fileCount: number }> {
    let bytes = 0;
    let fileCount = 0;
    if (!fs.existsSync(this.cacheRoot)) {
      return { bytes, fileCount };
    }
    const dayDirs = await this.listDayDirs();
    for (const dayDir of dayDirs) {
      const files = await this.listFiles(dayDir);
      for (const file of files) {
        try {
          const stat = await fsp.stat(path.join(dayDir, file));
          bytes += stat.size;
          fileCount++;
        } catch {
          // 忽略
        }
      }
    }
    return { bytes, fileCount };
  }
}

function normalizeCachePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * 格式化日期为 YYYY-MM-DD（本地时区）
 */
function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 单例（延迟初始化，在 app.whenReady 之后才能调用 app.getPath）
 *
 * 注意：因为 ScreenshotCache 构造函数依赖 app.getPath，
 * 必须在 app.whenReady() 之后创建实例，不能在模块加载时直接 new
 */
let _instance: ScreenshotCache | null = null;

export function getScreenshotCache(): ScreenshotCache {
  if (!_instance) {
    _instance = new ScreenshotCache();
  }
  return _instance;
}
