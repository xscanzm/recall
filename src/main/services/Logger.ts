// src/main/services/Logger.ts
// 本地日志系统（来自 06 文档 "日志" 章节）
//
// 严格规则：
// - 本地日志只记录：job id / job type / 状态 / 错误码 / 耗时
// - 不记录截图内容
// - 不记录 API Key
// - 不记录完整模型输入输出，除非用户开启开发调试
//
// 实现要点：
// - 写入到 %APPDATA%/Recall/logs/app.log
// - 按日期轮转（每天一个文件：app-YYYY-MM-DD.log）
// - 保留最近 7 天日志，更早的自动删除
// - 提供 info/warn/error/debug 四个级别
// - debug 级别仅在开发调试模式（RECALL_DEV_DEBUG=1）下写入
//
// 安全约束（重要）：
// - 本日志禁止写入截图路径、窗口标题、URL、API Key、模型输入输出原文
// - 调用方传入的 message 字符串应仅是结构化标识（如 job id、错误码、状态）
// - 若需记录额外字段，使用 sanitized 辅助方法剔除敏感字段

import { app } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * 日志级别
 */
export type LogLevel = "info" | "warn" | "error" | "debug";

/**
 * 日志记录结构（来自 06 文档要求字段）
 */
export interface LogEntry {
  /** ISO 时间戳 */
  timestamp: string;
  /** 级别 */
  level: LogLevel;
  /** job id（可选） */
  jobId?: string;
  /** job type（可选）：observer/extractor/linker/scene_builder/judge/reporter/json_repair */
  jobType?: string;
  /** 状态：started/succeeded/failed */
  status?: "started" | "succeeded" | "failed";
  /** 错误码（仅 failed 状态） */
  errorCode?: string;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 简短描述（不含敏感数据） */
  message: string;
}

/**
 * 日志保留天数（超过则自动删除）
 */
const LOG_RETENTION_DAYS = 7;

/**
 * 单个日志文件最大大小（5MB，超过则强制轮转）
 */
const MAX_LOG_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * 敏感字段名（写入时自动脱敏）
 * 这些 key 的 value 会被替换为 [REDACTED]
 */
const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "password",
  "secret",
  "token",
  "key",
  "imagebase64",
  "image_base64",
  "image",
  "screenshot",
  "screenshotpath",
  "screenshot_path",
  "filepath",
  "windowtitle",
  "window_title",
  "url",
  "content",
  "input",
  "output",
  "prompt",
  "response",
]);

/**
 * Logger 单例
 *
 * 用法：
 *   import { logger } from "./Logger";
 *   logger.info({ jobId: "xxx", jobType: "observer", status: "started", message: "observer job started" });
 *   logger.error({ jobId: "xxx", jobType: "observer", status: "failed", errorCode: "auth_error", message: "model auth failed" });
 *
 * 调试模式（记录完整模型输入输出，仅在用户开启时使用）：
 *   RECALL_DEV_DEBUG=1 时，logger.debug 才会写入文件
 *   注意：debug 级别仍不应记录 API Key（在 sanitizedFields 中已剔除）
 */
class Logger {
  private logDir: string = "";
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private isDevDebug: boolean;

  constructor() {
    this.isDevDebug = process.env.RECALL_DEV_DEBUG === "1";
  }

  /**
   * 初始化日志目录
   * 必须在 app.whenReady() 之后调用（依赖 app.getPath）
   */
  init(): void {
    if (this.initialized) return;
    this.logDir = path.join(app.getPath("userData"), "logs");
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this.initialized = true;
    } catch {
      // 创建目录失败时不阻断应用，但日志将无法写入
      this.initialized = false;
    }
    // 启动时清理过期日志
    void this.cleanupOldLogs();
  }

  /**
   * 设置是否启用开发调试模式
   * 可由 SettingsService 在用户开启"开发调试"开关时调用
   */
  setDevDebug(enabled: boolean): void {
    this.isDevDebug = enabled;
  }

  /**
   * 是否已开启开发调试
   */
  isDevDebugEnabled(): boolean {
    return this.isDevDebug;
  }

  /**
   * INFO 级别日志
   */
  info(entry: Omit<LogEntry, "timestamp" | "level">): void {
    this.write({ ...entry, timestamp: new Date().toISOString(), level: "info" });
  }

  /**
   * WARN 级别日志
   */
  warn(entry: Omit<LogEntry, "timestamp" | "level">): void {
    this.write({ ...entry, timestamp: new Date().toISOString(), level: "warn" });
  }

  /**
   * ERROR 级别日志
   */
  error(entry: Omit<LogEntry, "timestamp" | "level">): void {
    this.write({ ...entry, timestamp: new Date().toISOString(), level: "error" });
  }

  /**
   * DEBUG 级别日志
   * 仅在 RECALL_DEV_DEBUG=1 时写入
   * 重要：debug 级别可能记录模型输入输出，但绝不记录 API Key
   * 调用方仍应通过 sanitizeFields 处理敏感字段
   */
  debug(entry: Omit<LogEntry, "timestamp" | "level">): void {
    if (!this.isDevDebug) return;
    this.write({ ...entry, timestamp: new Date().toISOString(), level: "debug" });
  }

  /**
   * 便捷方法：记录 job 开始
   */
  logJobStarted(jobId: string, jobType: string, message: string = "job started"): void {
    this.info({ jobId, jobType, status: "started", message });
  }

  /**
   * 便捷方法：记录 job 成功
   */
  logJobSucceeded(
    jobId: string,
    jobType: string,
    durationMs: number,
    message: string = "job succeeded"
  ): void {
    this.info({ jobId, jobType, status: "succeeded", durationMs, message });
  }

  /**
   * 便捷方法：记录 job 失败
   */
  logJobFailed(
    jobId: string,
    jobType: string,
    errorCode: string,
    durationMs: number,
    message: string = "job failed"
  ): void {
    this.error({ jobId, jobType, status: "failed", errorCode, durationMs, message });
  }

  /**
   * 脱敏对象中的敏感字段
   * - 递归处理对象和数组
   * - 敏感字段的 value 替换为 "[REDACTED]"
   * - 字符串值若过长（>200字符）截断为 "[TRUNCATED:NNN chars]"
   *   防止模型完整输入输出意外写入日志
   *
   * 用法：
   *   const safe = logger.sanitizeFields({ apiKey: "sk-xxx", input: "very long text..." });
   *   logger.debug({ message: "model call", ...safe });
   */
  sanitizeFields<T>(obj: T): T {
    return this.doSanitize(obj, 0) as T;
  }

  // ----------------------------------------------------------------
  // 内部实现
  // ----------------------------------------------------------------

  /**
   * 递归脱敏
   * depth 防止循环引用导致无限递归
   */
  private doSanitize(obj: unknown, depth: number): unknown {
    if (depth > 8) return "[MAX_DEPTH]";
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === "string") {
      // 字符串过长则截断（防止模型完整输入输出意外写入）
      if (obj.length > 200) {
        return `[TRUNCATED:${obj.length} chars]`;
      }
      return obj;
    }
    if (typeof obj !== "object") {
      // number/boolean/etc 直接返回
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.doSanitize(item, depth + 1));
    }
    const record = obj as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lowerKey)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = this.doSanitize(record[key], depth + 1);
      }
    }
    return result;
  }

  /**
   * 写入日志（串行化以避免并发写入冲突）
   */
  private write(entry: LogEntry): void {
    if (!this.initialized) return;
    const line = this.formatLine(entry);
    // 串行写入，避免并发文件操作冲突
    this.writeQueue = this.writeQueue
      .then(() => this.appendLine(line))
      .catch(() => {
        // 写入失败不阻断主流程
      });
  }

  /**
   * 格式化日志行（JSON Lines 格式，便于工具解析）
   */
  private formatLine(entry: LogEntry): string {
    try {
      return JSON.stringify(entry);
    } catch {
      // 序列化失败时返回最小化记录
      return JSON.stringify({
        timestamp: entry.timestamp,
        level: entry.level,
        message: "[unserializable entry]",
      });
    }
  }

  /**
   * 追加一行到当天日志文件
   */
  private async appendLine(line: string): Promise<void> {
    if (!this.logDir) return;
    const dateKey = this.formatDateKey(new Date());
    const filePath = path.join(this.logDir, `app-${dateKey}.log`);
    try {
      // 检查文件大小，超过阈值时触发轮转（重命名为 .1 后缀）
      await this.maybeRotateFile(filePath);
      await fsp.appendFile(filePath, line + "\n", "utf8");
    } catch {
      // 写入失败忽略（日志不能阻断应用）
    }
  }

  /**
   * 文件大小超过阈值时轮转
   * 简单策略：把当前文件重命名为 .1.log（覆盖现有 .1.log）
   */
  private async maybeRotateFile(filePath: string): Promise<void> {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size < MAX_LOG_FILE_SIZE_BYTES) return;
      const rotated = filePath.replace(/\.log$/, ".1.log");
      try {
        await fsp.unlink(rotated);
      } catch {
        // 旧 .1.log 不存在，忽略
      }
      await fsp.rename(filePath, rotated);
    } catch {
      // 文件不存在或 stat 失败，不轮转
    }
  }

  /**
   * 清理过期日志文件
   * - 删除 LOG_RETENTION_DAYS 天前的 app-YYYY-MM-DD.log 文件
   * - 保留 .1.log 轮转文件中的最新一份
   */
  private async cleanupOldLogs(): Promise<void> {
    if (!this.logDir) return;
    try {
      const entries = await fsp.readdir(this.logDir);
      const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (!/^app-\d{4}-\d{2}-\d{2}(\.1)?\.log$/.test(entry)) continue;
        const filePath = path.join(this.logDir, entry);
        try {
          const stat = await fsp.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fsp.unlink(filePath);
          }
        } catch {
          // 单个文件清理失败忽略
        }
      }
    } catch {
      // 清理失败忽略
    }
  }

  /**
   * 格式化日期为 YYYY-MM-DD（本地时区）
   */
  private formatDateKey(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}

/**
 * Logger 单例
 *
 * 必须在 app.whenReady() 之后调用 init() 才会真正写入文件
 * 在 init 之前的调用会被静默丢弃（避免在 Electron 未就绪时报错）
 */
export const logger = new Logger();
