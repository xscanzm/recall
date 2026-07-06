// src/main/services/ReportScheduler.ts
// 报告调度（来自 06 文档 / 02 文档 Flow 7、8）
//
// 职责：
// - 每日固定时间生成日报（默认 18:30，可配置）
// - 每周固定时间生成周报（可配置，默认周五 18:00）
// - 支持手动生成（用户点击）
// - 报告生成失败时显示可重试状态（通过 errorMessage 返回）
//
// 日报触发（来自 02 文档 Flow 7）：
// - 每天固定时间，例如 18:30
// - 用户手动点击"生成今日报告"
//
// 周报触发（来自 02 文档 Flow 8）：
// - 用户手动点击
// - 设置中开启每周固定时间生成（默认每周五 18:00）
//
// 实现说明：
// - 使用 setInterval 每分钟检查一次当前时间，到达设定时间时触发
// - 不使用 node-cron 避免引入额外依赖
// - 同一天内不会重复触发日报；同一周内不会重复触发周报
// - 暂停状态下不触发自动生成（手动仍可触发）

import type { ReporterWorker } from "./ReporterWorker";
import type { SettingsService } from "./SettingsService";

/**
 * 调度结果
 */
export interface ScheduleResult {
  ok: boolean;
  reportId?: string;
  errorMessage?: string;
  errorCode?: string;
}

/**
 * 检查间隔：60 秒（毫秒）
 * 每分钟检查一次是否到达报告生成时间
 */
const CHECK_INTERVAL_MS = 60_000;

/**
 * 周报默认触发星期（周五 = 5）
 */
const DEFAULT_WEEKLY_REPORT_DAY = 5;

/**
 * ReportScheduler：报告调度器
 *
 * 使用 setInterval 每分钟检查当前时间，
 * - 若到达 dailyReport.time（默认 18:30），且今日尚未生成日报，触发日报生成
 * - 若到达 weeklyReport 触发时间（默认周五 18:00），且本周尚未生成周报，触发周报生成
 *
 * 用户可通过 generateDailyReportNow / generateWeeklyReportNow 手动触发。
 */
export class ReportScheduler {
  private readonly reporterWorker: ReporterWorker;
  private readonly settingsService: SettingsService | null;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  /** 已触发日报的日期（YYYY-MM-DD），避免同一天重复触发 */
  private lastDailyReportDate: string | null = null;
  /** 已触发周报的周起始日期（YYYY-MM-DD），避免同一周重复触发 */
  private lastWeeklyReportWeekStart: string | null = null;

  constructor(deps: {
    reporterWorker: ReporterWorker;
    settingsService?: SettingsService;
  }) {
    this.reporterWorker = deps.reporterWorker;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 启动定时任务
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      void this.checkSchedule();
    }, CHECK_INTERVAL_MS);
    // 不阻塞进程退出
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * 停止定时任务
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 手动触发日报生成
   * 不受"今日已生成"限制（用户主动操作）
   */
  async generateDailyReportNow(date?: string): Promise<ScheduleResult> {
    const targetDate = date ?? todayKey();
    try {
      const result = await this.reporterWorker.generateDailyReport(targetDate);
      if (result.ok && result.reportRecord) {
        this.lastDailyReportDate = targetDate;
        return {
          ok: true,
          reportId: result.reportRecord.id,
        };
      }
      return {
        ok: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 手动触发周报生成
   * 不受"本周已生成"限制（用户主动操作）
   */
  async generateWeeklyReportNow(weekStart?: string): Promise<ScheduleResult> {
    const targetWeekStart = weekStart ?? getCurrentWeekStart();
    try {
      const result = await this.reporterWorker.generateWeeklyReport(targetWeekStart);
      if (result.ok && result.reportRecord) {
        this.lastWeeklyReportWeekStart = targetWeekStart;
        return {
          ok: true,
          reportId: result.reportRecord.id,
        };
      }
      return {
        ok: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 检查当前时间，决定是否触发报告生成
   * 每分钟调用一次
   */
  private async checkSchedule(): Promise<void> {
    if (!this.settingsService) return;

    const settings = this.settingsService.getAll();
    const now = new Date();

    // 检查日报触发时间
    const dailyTime = settings.dailyReport.time; // HH:mm
    if (settings.dailyReport.autoGenerate && dailyTime) {
      const { hour, minute } = parseTime(dailyTime);
      if (
        now.getHours() === hour &&
        now.getMinutes() === minute
      ) {
        const today = todayKey();
        if (this.lastDailyReportDate !== today) {
          this.lastDailyReportDate = today;
          try {
            await this.reporterWorker.generateDailyReport(today);
          } catch {
            // 失败不阻断调度器，下次仍可手动重试
          }
        }
      }
    }

    // 检查周报触发时间（默认周五 18:00）
    const weeklyTime = settings.notification.weeklyReportTime; // HH:mm
    if (weeklyTime) {
      const { hour, minute } = parseTime(weeklyTime);
      if (
        now.getDay() === DEFAULT_WEEKLY_REPORT_DAY &&
        now.getHours() === hour &&
        now.getMinutes() === minute
      ) {
        const weekStart = getCurrentWeekStart();
        if (this.lastWeeklyReportWeekStart !== weekStart) {
          this.lastWeeklyReportWeekStart = weekStart;
          try {
            await this.reporterWorker.generateWeeklyReport(weekStart);
          } catch {
            // 失败不阻断调度器
          }
        }
      }
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 获取今日日期 key（YYYY-MM-DD，使用本地时区）
 */
function todayKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取本周一日期 key（YYYY-MM-DD）
 * JavaScript getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
 * 周一作为一周的开始
 */
function getCurrentWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  // 周一 = 1，周二 = 2，...，周日 = 0（视为 7）
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const year = monday.getFullYear();
  const month = (monday.getMonth() + 1).toString().padStart(2, "0");
  const day = monday.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 解析 HH:mm 时间字符串
 */
function parseTime(time: string): { hour: number; minute: number } {
  const parts = time.split(":");
  const hour = parseInt(parts[0] ?? "18", 10);
  const minute = parseInt(parts[1] ?? "30", 10);
  return {
    hour: Number.isNaN(hour) ? 18 : hour,
    minute: Number.isNaN(minute) ? 30 : minute,
  };
}
