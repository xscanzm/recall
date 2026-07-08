// src/main/services/ReportScheduler.ts
// 报告调度（来自 06 文档 / 02 文档 Flow 7、8）
//
// 职责：
// - 每日固定时间生成工作日报（默认 19:00，可配置）
// - 每日固定时间生成个人复盘（默认 23:00，可配置）
// - 每周固定时间生成周报（可配置，默认周五 20:00）
// - 支持手动生成（用户点击）
// - 报告生成失败时显示可重试状态（通过 errorMessage 返回）
//
// 补跑机制：
// - lastXxxDate 持久化到 settings.schedule.*，应用启动 + 每 30 分钟跑一次 checkMissedSchedules()
// - 单次任务失败 → 不更新 lastRunDate，下次启动会重试
// - 补跑上限 7 天（防止 API 额度耗尽）
// - 成功判定 = 报告表里 type+dateKey 已有记录（已存在视为成功，避免误重跑）
// - 补 today 时必须已过当天触发时刻，避免早晨启动就生成不完整的当天报告
//
// 失败重试机制（指数退避）：
// - 当天任务失败后，按 5min → 15min → 30min → 60min 退避重试，最多 4 次
// - 重试状态内存维护，跨日自动重置，重启由 checkMissedSchedules 兜底
// - 超过最大次数放弃重试，等明天，或下次 checkMissedSchedules 兜底
// - 应用启动时如果当前时间已过触发时刻且今天未完成 → 立即触发（启动后补跑）
//
// 实现说明：
// - 使用 setInterval 每分钟检查当前时间，到达设定时间时触发
// - 不使用 node-cron 避免引入额外依赖
// - 使用本地时区（通过 dateKey 工具）计算"今天"

import type { ReporterWorker } from "./ReporterWorker";
import type { PersonalReviewWriterWorker } from "./PersonalReviewWriterWorker";
import type { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import type { SettingsService } from "./SettingsService";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import { logger } from "./Logger";
import {
  formatLocalDateKey,
  localTodayKey,
  addDaysToDateKey,
} from "../utils/dateKey";

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
 * 每分钟检查一次是否到达报告生成时间 / 是否到重试时间
 */
const CHECK_INTERVAL_MS = 60_000;

/**
 * 补跑检查间隔：30 分钟（毫秒）
 * - 启动时跑一次
 * - 之后每 30 分钟跑一次（兜底长时运行跨日）
 */
const MISSED_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/**
 * 周报默认触发星期（周五 = 5）
 */
const DEFAULT_WEEKLY_REPORT_DAY = 5;

/**
 * 补跑最大回溯天数
 * - 防止长时间没开机后一次补 30 天的报告耗光 API 额度
 */
const MAX_BACKFILL_DAYS = 7;

/**
 * 失败重试退避间隔（毫秒）
 * - 第 1 次失败后 5 分钟重试
 * - 第 2 次失败后 15 分钟重试
 * - 第 3 次失败后 30 分钟重试
 * - 第 4 次失败后 60 分钟重试
 * - 超过 4 次放弃（等明天，或下次 checkMissedSchedules 兜底）
 */
const RETRY_BACKOFF_MS: number[] = [
  5 * 60 * 1000,    // 5 分钟
  15 * 60 * 1000,   // 15 分钟
  30 * 60 * 1000,   // 30 分钟
  60 * 60 * 1000,   // 60 分钟
];
const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_MS.length;

/**
 * 失败重试状态（内存维护，重启由 checkMissedSchedules 兜底）
 *
 * 字段说明：
 * - dateKey: 这一次重试对应的日期（跨日时自动重置）
 * - attempts: 已失败次数（成功后清零）
 * - lastFailedAt: 上次失败的时间戳
 * - nextRetryAt: 下次允许重试的时间戳（按退避策略计算）
 */
interface RetryState {
  dateKey: string;
  attempts: number;
  lastFailedAt: number;
  nextRetryAt: number;
}

/**
 * ReportScheduler：报告调度器
 *
 * 调度 3 类任务：
 * 1. work_daily_report（每天 dailyReport.time）
 * 2. personal_daily_review（每天 personalReview.time）
 * 3. weekly（每周 DEFAULT_WEEKLY_REPORT_DAY 的 weeklyReportTime）
 *
 * 补跑机制：
 * - 启动时 checkMissedSchedules()：检查每个任务类型，从 lastRunDate + 1 开始
 *   顺序补到今天，最多回溯 MAX_BACKFILL_DAYS 天
 * - 之后每 MISSED_CHECK_INTERVAL_MS 跑一次（兜底长时运行跨日）
 *
 * 用户可通过 generateDailyReportNow / generateWeeklyReportNow /
 * generatePersonalReviewNow 手动触发。
 */
export class ReportScheduler {
  private readonly reporterWorker: ReporterWorker;
  private readonly personalReviewWriterWorker: PersonalReviewWriterWorker | null;
  private readonly timelineBuilderWorker: TimelineBuilderWorker | null;
  private readonly settingsService: SettingsService | null;
  private readonly reportRepo: ReportRepository | null;
  private checkTimer: NodeJS.Timeout | null = null;
  private missedCheckTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  /** 补跑锁：避免 checkMissedSchedules 与 checkSchedule 并发跑同一任务 */
  private isBackfilling = false;
  /** 调度触发锁：避免同分钟内重复触发 */
  private isChecking = false;
  /** 工作日报当日失败重试状态（跨日自动重置） */
  private dailyReportRetry: RetryState | null = null;
  /** 个人复盘当日失败重试状态（跨日自动重置） */
  private personalReviewRetry: RetryState | null = null;
  /** 周报本周失败重试状态（跨周自动重置，dateKey 存 weekStart） */
  private weeklyReportRetry: RetryState | null = null;

  constructor(deps: {
    reporterWorker: ReporterWorker;
    personalReviewWriterWorker?: PersonalReviewWriterWorker;
    timelineBuilderWorker?: TimelineBuilderWorker;
    reportRepo?: ReportRepository;
    settingsService?: SettingsService;
  }) {
    this.reporterWorker = deps.reporterWorker;
    this.personalReviewWriterWorker = deps.personalReviewWriterWorker ?? null;
    this.timelineBuilderWorker = deps.timelineBuilderWorker ?? null;
    this.reportRepo = deps.reportRepo ?? null;
    this.settingsService = deps.settingsService ?? null;
  }

  /**
   * 启动定时任务
   * - 立即跑一次 checkMissedSchedules()（补跑）
   * - 每分钟 checkSchedule()
   * - 每 30 分钟 checkMissedSchedules()（兜底跨日）
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // 启动补跑（不阻塞 start）
    void this.checkMissedSchedules().catch((err) => {
      logger.error({
        message: `启动补跑失败: ${err instanceof Error ? err.message : String(err)}`,
      });
    });

    this.checkTimer = setInterval(() => {
      void this.checkSchedule();
    }, CHECK_INTERVAL_MS);
    if (this.checkTimer.unref) this.checkTimer.unref();

    this.missedCheckTimer = setInterval(() => {
      void this.checkMissedSchedules().catch((err) => {
        logger.error({
          message: `周期补跑失败: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    }, MISSED_CHECK_INTERVAL_MS);
    if (this.missedCheckTimer.unref) this.missedCheckTimer.unref();
  }

  /**
   * 停止定时任务
   */
  stop(): void {
    this.isRunning = false;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.missedCheckTimer) {
      clearInterval(this.missedCheckTimer);
      this.missedCheckTimer = null;
    }
  }

  // ============================================================================
  // 手动触发
  // ============================================================================

  /**
   * 手动触发工作日报生成
   * - 不受"今日已生成"限制
   * - 成功后更新 schedule.lastDailyReportDate 并清空当日重试状态
   */
  async generateDailyReportNow(date?: string): Promise<ScheduleResult> {
    const targetDate = date ?? localTodayKey();
    try {
      const result = await this.reporterWorker.generateDailyReport(targetDate);
      if (result.ok && result.reportRecord) {
        this.markDailyReportDone(targetDate);
        // 手动成功 → 清空当日重试状态
        if (this.dailyReportRetry?.dateKey === targetDate) {
          this.dailyReportRetry = null;
        }
        return { ok: true, reportId: result.reportRecord.id };
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
   * - 成功后清空本周重试状态
   */
  async generateWeeklyReportNow(weekStart?: string): Promise<ScheduleResult> {
    const targetWeekStart = weekStart ?? getCurrentWeekStart();
    try {
      const result = await this.reporterWorker.generateWeeklyReport(targetWeekStart);
      if (result.ok && result.reportRecord) {
        this.markWeeklyReportDone(targetWeekStart);
        if (this.weeklyReportRetry?.dateKey === targetWeekStart) {
          this.weeklyReportRetry = null;
        }
        return { ok: true, reportId: result.reportRecord.id };
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
   * 手动触发个人复盘生成
   * - 不受"今日已生成"限制
   * - 成功后更新 schedule.lastPersonalReviewDate 并清空当日重试状态
   */
  async generatePersonalReviewNow(date?: string): Promise<ScheduleResult> {
    if (!this.personalReviewWriterWorker) {
      return {
        ok: false,
        errorCode: "no_personal_review_worker",
        errorMessage: "PersonalReviewWriterWorker 未注入",
      };
    }
    const targetDate = date ?? localTodayKey();
    try {
      const result = await this.personalReviewWriterWorker.writePersonalReview(targetDate);
      if (result.ok && result.reportRecord) {
        this.markPersonalReviewDone(targetDate);
        if (this.personalReviewRetry?.dateKey === targetDate) {
          this.personalReviewRetry = null;
        }
        return { ok: true, reportId: result.reportRecord.id };
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

  // ============================================================================
  // 调度主循环
  // ============================================================================

  /**
   * 检查当前时间，决定是否触发报告生成 / 重试
   * 每分钟调用一次
   *
   * 触发条件（满足任一即触发，但前提是"今天未完成"且"已过当天触发时刻"）：
   * 1. 正好处于触发那一分钟（到点）
   * 2. retryState == null 但当前时间已过触发时刻（启动后补跑/到点错过）
   * 3. retryState != null 且 now >= nextRetryAt（按退避策略到点重试）
   *
   * 已放弃重试（attempts > MAX）的不再触发，等明天，或下次 checkMissedSchedules 兜底。
   */
  private async checkSchedule(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      if (!this.settingsService) return;
      const settings = this.settingsService.getAll();
      const now = new Date();
      const nowMs = now.getTime();
      const today = localTodayKey();

      // ---- 工作日报 ----
      const dailyTime = settings.dailyReport.time;
      if (settings.dailyReport.autoGenerate && dailyTime) {
        if (!this.isDailyReportDone(today) && isPastTriggerTime(dailyTime, now)) {
          // 已放弃重试 → 跳过（等明天或下次 checkMissedSchedules）
          if (!this.isRetryGivenUp(this.dailyReportRetry)) {
            const shouldTrigger =
              isAtTriggerMinute(dailyTime, now) ||            // 到点
              this.dailyReportRetry === null ||                // 启动后补跑/到点错过
              this.isRetryDue(this.dailyReportRetry, nowMs);   // 退避重试
            if (shouldTrigger) {
              const ok = await this.tryRunDailyReport(today, "scheduled");
              if (!ok) {
                this.dailyReportRetry = this.getOrResetRetryState(this.dailyReportRetry, today);
                const willRetry = this.recordFailure(this.dailyReportRetry, nowMs);
                logger.warn({
                  message: `日报失败，${willRetry ? `将在 ${new Date(this.dailyReportRetry.nextRetryAt).toLocaleString()} 重试（第 ${this.dailyReportRetry.attempts}/${MAX_RETRY_ATTEMPTS} 次）` : `已达最大重试次数 ${MAX_RETRY_ATTEMPTS}，放弃当日重试`}`,
                });
              }
            }
          }
        }
      }

      // ---- 个人复盘 ----
      const personalTime = settings.personalReview.time;
      if (settings.personalReview.autoGenerate && personalTime) {
        if (!this.isPersonalReviewDone(today) && isPastTriggerTime(personalTime, now)) {
          if (!this.isRetryGivenUp(this.personalReviewRetry)) {
            const shouldTrigger =
              isAtTriggerMinute(personalTime, now) ||
              this.personalReviewRetry === null ||
              this.isRetryDue(this.personalReviewRetry, nowMs);
            if (shouldTrigger) {
              const ok = await this.tryRunPersonalReview(today, "scheduled");
              if (!ok) {
                this.personalReviewRetry = this.getOrResetRetryState(this.personalReviewRetry, today);
                const willRetry = this.recordFailure(this.personalReviewRetry, nowMs);
                logger.warn({
                  message: `个人复盘失败，${willRetry ? `将在 ${new Date(this.personalReviewRetry.nextRetryAt).toLocaleString()} 重试（第 ${this.personalReviewRetry.attempts}/${MAX_RETRY_ATTEMPTS} 次）` : `已达最大重试次数 ${MAX_RETRY_ATTEMPTS}，放弃当日重试`}`,
                });
              }
            }
          }
        }
      }

      // ---- 周报 ----
      const weeklyTime = settings.notification.weeklyReportTime;
      if (weeklyTime) {
        const isWeeklyDay = now.getDay() === DEFAULT_WEEKLY_REPORT_DAY;
        // 周报触发条件：当前是周五 且 当前时间 >= 触发时刻
        const weekStart = getCurrentWeekStart();
        const weeklyTriggerToday = isWeeklyDay && isPastTriggerTime(weeklyTime, now);
        if (!this.isWeeklyReportDone(weekStart) && weeklyTriggerToday) {
          if (!this.isRetryGivenUp(this.weeklyReportRetry)) {
            const shouldTrigger =
              (isWeeklyDay && isAtTriggerMinute(weeklyTime, now)) ||
              this.weeklyReportRetry === null ||
              this.isRetryDue(this.weeklyReportRetry, nowMs);
            if (shouldTrigger) {
              const ok = await this.tryRunWeeklyReport(weekStart, "scheduled");
              if (!ok) {
                this.weeklyReportRetry = this.getOrResetRetryState(this.weeklyReportRetry, weekStart);
                const willRetry = this.recordFailure(this.weeklyReportRetry, nowMs);
                logger.warn({
                  message: `周报失败，${willRetry ? `将在 ${new Date(this.weeklyReportRetry.nextRetryAt).toLocaleString()} 重试（第 ${this.weeklyReportRetry.attempts}/${MAX_RETRY_ATTEMPTS} 次）` : `已达最大重试次数 ${MAX_RETRY_ATTEMPTS}，放弃本周重试`}`,
                });
              }
            }
          }
        }
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 补跑检查：启动时 + 每 30 分钟跑一次
   *
   * 遍历三类任务：
   * - 如果 schedule.lastXxxDate < today，按日期顺序补跑 lastXxxDate+1 ~ today
   * - 上限 MAX_BACKFILL_DAYS 天（防止 API 额度耗尽）
   * - 跳过那些 DB 里已有 type+dateKey 记录的日期（视为已成功，避免 LLM 重复跑）
   * - 单次失败不阻断后续补跑
   *
   * 重要修正：
   * - 补 today 时，必须先检查"当前时间 >= 当天触发时刻"，
   *   否则早晨启动时（19:00 还没到）会过早生成"今天的报告"，数据范围才到早晨。
   * - today 的失败重试交给 checkSchedule 处理（按指数退避），backfill 只负责历史日期。
   */
  private async checkMissedSchedules(): Promise<void> {
    if (this.isBackfilling) return;
    if (!this.settingsService) return;
    this.isBackfilling = true;
    try {
      const settings = this.settingsService.getAll();
      const today = localTodayKey();
      const schedule = settings.schedule;
      const now = new Date();

      // ---- 工作日报补跑 ----
      if (settings.dailyReport.autoGenerate) {
        const last = schedule.lastDailyReportDate;
        const datesToBackfill = this.getBackfillDates(last, today, MAX_BACKFILL_DAYS);
        const dailyTime = settings.dailyReport.time;
        for (const dateKey of datesToBackfill) {
          if (this.isDailyReportDone(dateKey)) {
            // DB 已有，更新 lastDailyReportDate（追上）
            this.markDailyReportDone(dateKey);
            continue;
          }
          // 补 today 时必须已过当天触发时刻，否则交给 checkSchedule 按时触发
          if (dateKey === today && dailyTime && !isPastTriggerTime(dailyTime, now)) {
            continue;
          }
          await this.tryRunDailyReport(dateKey, "backfill");
        }
      }

      // ---- 个人复盘补跑 ----
      if (settings.personalReview.autoGenerate && this.personalReviewWriterWorker) {
        const last = schedule.lastPersonalReviewDate;
        const datesToBackfill = this.getBackfillDates(last, today, MAX_BACKFILL_DAYS);
        const personalTime = settings.personalReview.time;
        for (const dateKey of datesToBackfill) {
          if (this.isPersonalReviewDone(dateKey)) {
            this.markPersonalReviewDone(dateKey);
            continue;
          }
          if (dateKey === today && personalTime && !isPastTriggerTime(personalTime, now)) {
            continue;
          }
          await this.tryRunPersonalReview(dateKey, "backfill");
        }
      }

      // ---- 周报补跑 ----
      // 简化：只补当前未完成的那一周（不无限回溯）
      // today 的判断已隐含在 weeklyTriggerToday 里：必须周五且已过触发时刻
      const weeklyTime = settings.notification.weeklyReportTime;
      if (weeklyTime) {
        const currentWeekStart = getCurrentWeekStart();
        if (!this.isWeeklyReportDone(currentWeekStart)) {
          const isWeeklyDay = now.getDay() === DEFAULT_WEEKLY_REPORT_DAY;
          const weeklyTriggerReady = isWeeklyDay && isPastTriggerTime(weeklyTime, now);
          // 不是周五 / 周五但未到触发时刻 → 跳过（避免提前生成不完整的周报）
          if (weeklyTriggerReady) {
            await this.tryRunWeeklyReport(currentWeekStart, "backfill");
          }
        }
      }
    } finally {
      this.isBackfilling = false;
    }
  }

  /**
   * 计算需要补跑的日期列表
   * - last = null → 从今天往前 MAX_BACKFILL_DAYS 天开始补
   * - 否则从 last + 1 到 today
   * - 上限 MAX_BACKFILL_DAYS
   */
  private getBackfillDates(
    last: string | null,
    today: string,
    maxDays: number
  ): string[] {
    const result: string[] = [];
    let startDate: string;
    if (!last) {
      // 首次启动：补最近 maxDays 天（含今天）
      startDate = addDaysToDateKey(today, -(maxDays - 1));
    } else if (last >= today) {
      // 已经跑到今天，不需要补
      return result;
    } else {
      startDate = addDaysToDateKey(last, 1);
    }
    let cur = startDate;
    let count = 0;
    while (cur <= today && count < maxDays) {
      result.push(cur);
      cur = addDaysToDateKey(cur, 1);
      count++;
    }
    return result;
  }

  // ============================================================================
  // 实际运行 + 状态判定
  // ============================================================================

  /**
   * 实际执行工作日报生成
   * - 返回 true 表示成功（已落库或已完成），false 表示失败
   * - 失败时由调用方更新 retryState
   */
  private async tryRunDailyReport(
    dateKey: string,
    origin: "scheduled" | "backfill" | "retry"
  ): Promise<boolean> {
    try {
      // 报告生成前先触发 buildTimeline 收尾，确保最后一段未落盘的数据已持久化
      if (this.timelineBuilderWorker) {
        try {
          await this.timelineBuilderWorker.buildTimeline(dateKey);
        } catch {
          // buildTimeline 失败不阻断报告生成，继续使用已有 timeline_blocks
        }
      }
      const result = await this.reporterWorker.generateDailyReport(dateKey);
      if (result.ok && result.reportRecord) {
        this.markDailyReportDone(dateKey);
        this.dailyReportRetry = null; // 成功 → 清空重试状态
        logger.info({
          message: `日报已生成 (${origin}) dateKey=${dateKey} reportId=${result.reportRecord.id}`,
        });
        return true;
      }
      logger.warn({
        message: `日报生成失败 (${origin}) dateKey=${dateKey} errorCode=${result.errorCode ?? "unknown"} errorMessage=${result.errorMessage ?? ""}`,
      });
      return false;
    } catch (err) {
      logger.error({
        message: `日报生成异常 (${origin}) dateKey=${dateKey} error=${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  /**
   * 实际执行个人复盘生成
   * - 返回 true 表示成功，false 表示失败
   */
  private async tryRunPersonalReview(
    dateKey: string,
    origin: "scheduled" | "backfill" | "retry"
  ): Promise<boolean> {
    if (!this.personalReviewWriterWorker) return false;
    try {
      const result = await this.personalReviewWriterWorker.writePersonalReview(dateKey);
      if (result.ok && result.reportRecord) {
        this.markPersonalReviewDone(dateKey);
        this.personalReviewRetry = null; // 成功 → 清空重试状态
        logger.info({
          message: `个人复盘已生成 (${origin}) dateKey=${dateKey} reportId=${result.reportRecord.id}`,
        });
        return true;
      }
      logger.warn({
        message: `个人复盘生成失败 (${origin}) dateKey=${dateKey} errorCode=${result.errorCode ?? "unknown"} errorMessage=${result.errorMessage ?? ""}`,
      });
      return false;
    } catch (err) {
      logger.error({
        message: `个人复盘生成异常 (${origin}) dateKey=${dateKey} error=${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  /**
   * 实际执行周报生成
   * - 返回 true 表示成功，false 表示失败
   */
  private async tryRunWeeklyReport(
    weekStart: string,
    origin: "scheduled" | "backfill" | "retry"
  ): Promise<boolean> {
    try {
      const result = await this.reporterWorker.generateWeeklyReport(weekStart);
      if (result.ok && result.reportRecord) {
        this.markWeeklyReportDone(weekStart);
        this.weeklyReportRetry = null; // 成功 → 清空重试状态
        logger.info({
          message: `周报已生成 (${origin}) weekStart=${weekStart} reportId=${result.reportRecord.id}`,
        });
        return true;
      }
      logger.warn({
        message: `周报生成失败 (${origin}) weekStart=${weekStart} errorCode=${result.errorCode ?? "unknown"} errorMessage=${result.errorMessage ?? ""}`,
      });
      return false;
    } catch (err) {
      logger.error({
        message: `周报生成异常 (${origin}) weekStart=${weekStart} error=${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // 重试状态管理
  // ------------------------------------------------------------------------

  /**
   * 获取或重置当日的重试状态（跨日时自动重置为新的初始态）
   * - 若 state 为 null 或 state.dateKey !== today → 返回新的初始态（attempts=0）
   * - 否则返回原 state
   */
  private getOrResetRetryState(
    state: RetryState | null,
    today: string
  ): RetryState {
    if (state && state.dateKey === today) return state;
    return {
      dateKey: today,
      attempts: 0,
      lastFailedAt: 0,
      nextRetryAt: 0,
    };
  }

  /**
   * 失败时更新重试状态（指数退避）
   * - 返回 true 表示已记录失败，false 表示已达最大次数，放弃重试
   */
  private recordFailure(state: RetryState, now: number): boolean {
    state.attempts += 1;
    state.lastFailedAt = now;
    if (state.attempts > MAX_RETRY_ATTEMPTS) {
      // 超过最大次数：不再重试，nextRetryAt 设为 Infinity 防止误触发
      state.nextRetryAt = Number.POSITIVE_INFINITY;
      return false;
    }
    // 退避：用 attempts-1 作为索引
    const backoff = RETRY_BACKOFF_MS[Math.min(state.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    state.nextRetryAt = now + backoff;
    return true;
  }

  /**
   * 判断是否到了重试时间
   * - state == null → 视为"未失败过"，但调用方应先尝试初始触发
   * - nextRetryAt = Infinity → 已放弃，不再重试
   */
  private isRetryDue(state: RetryState | null, now: number): boolean {
    if (!state) return false;
    if (state.attempts >= MAX_RETRY_ATTEMPTS) return false;
    return now >= state.nextRetryAt;
  }

  /**
   * 是否已放弃重试
   */
  private isRetryGivenUp(state: RetryState | null): boolean {
    return state !== null && state.attempts >= MAX_RETRY_ATTEMPTS;
  }

  /**
   * 是否"已完成"：DB 已有 type+dateKey 记录（视为成功，避免误重跑）
   * - 优先查 DB（最权威）
   * - DB 不可用时回退到 settings.schedule 内存态
   */
  private isDailyReportDone(dateKey: string): boolean {
    if (this.reportRepo) {
      const report = this.reportRepo.getByTypeAndDate("work_daily_report", dateKey);
      if (report) return true;
    }
    const last = this.settingsService?.getAll().schedule.lastDailyReportDate ?? null;
    return last !== null && last >= dateKey;
  }

  private isPersonalReviewDone(dateKey: string): boolean {
    if (this.reportRepo) {
      const report = this.reportRepo.getByTypeAndDate("personal_daily_review", dateKey);
      if (report) return true;
    }
    const last = this.settingsService?.getAll().schedule.lastPersonalReviewDate ?? null;
    return last !== null && last >= dateKey;
  }

  private isWeeklyReportDone(weekStart: string): boolean {
    if (this.reportRepo) {
      // 周报不是按 dateKey 唯一，简单判断最近一周报是本周即可
      const recent = this.reportRepo.listByType("weekly", { limit: 1 });
      if (recent.length > 0 && recent[0]?.dateKey === weekStart) return true;
    }
    const last = this.settingsService?.getAll().schedule.lastWeeklyReportWeekStart ?? null;
    return last !== null && last >= weekStart;
  }

  // ------------------------------------------------------------------------
  // 标记完成（持久化到 settings.schedule）
  // - 只在 lastRunDate 为 null 或 小于 新dateKey 时才更新
  // ------------------------------------------------------------------------

  private markDailyReportDone(dateKey: string): void {
    if (!this.settingsService) return;
    const cur = this.settingsService.getAll().schedule.lastDailyReportDate;
    if (cur === null || cur < dateKey) {
      this.settingsService.setSchedule({ lastDailyReportDate: dateKey });
    }
  }

  private markPersonalReviewDone(dateKey: string): void {
    if (!this.settingsService) return;
    const cur = this.settingsService.getAll().schedule.lastPersonalReviewDate;
    if (cur === null || cur < dateKey) {
      this.settingsService.setSchedule({ lastPersonalReviewDate: dateKey });
    }
  }

  private markWeeklyReportDone(weekStart: string): void {
    if (!this.settingsService) return;
    const cur = this.settingsService.getAll().schedule.lastWeeklyReportWeekStart;
    if (cur === null || cur < weekStart) {
      this.settingsService.setSchedule({ lastWeeklyReportWeekStart: weekStart });
    }
  }
}

// ============================================================================
// 工具函数（与 store.ts / TimelineBuilderWorker 保持本地时区一致）
// ============================================================================

/**
 * 获取本周一日期 key（YYYY-MM-DD，本地时区）
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
  return formatLocalDateKey(monday);
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

/**
 * 计算给定时间字符串对应的"今天触发时刻"的 Date 对象
 * 例如 time="19:00" → 今天的 19:00:00
 */
function getTodayTriggerDate(time: string): Date {
  const { hour, minute } = parseTime(time);
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0
  );
}

/**
 * 判断当前时间是否已过今天的触发时刻（含 1 分钟容差）
 * - 用于"补跑判断"：避免在触发时刻之前提前生成报告
 */
function isPastTriggerTime(time: string, now: Date = new Date()): boolean {
  const trigger = getTodayTriggerDate(time);
  // now >= trigger 视为已过触发时刻
  return now.getTime() >= trigger.getTime();
}

/**
 * 判断当前时间是否正好处于触发那一分钟
 * - 例如 time="19:00"，now=19:00:30 → true
 * - 例如 time="19:00"，now=19:01:30 → false
 */
function isAtTriggerMinute(time: string, now: Date = new Date()): boolean {
  const { hour, minute } = parseTime(time);
  return now.getHours() === hour && now.getMinutes() === minute;
}
