// src/main/services/linkerSceneJudge/JudgeWorker.ts
// Judge 职责模块（从 LinkerSceneJudgeWorker.ts 拆分，代码原样迁移）：
// - 数据查询：fetchOpenTasks / fetchReminderPolicy / fetchTodayTimelineBlocks / getLocalDateKey
// - 输出处理：writeProactiveItems（priorityThreshold 过滤 + surface 降级）/
//   writeUnfinishedThreads（repo 可用时 upsertMany）
//
// 行为与原 LinkerSceneJudgeWorker 中对应方法完全一致。
// 注：getLocalDateKey 仍保留本模块（utils/dateKey.ts 的迁移由计划 todo 23 负责）。

import type { Task, ProactiveItem, DebugEvent } from "../../models/types";
import type { LinkerSceneJudgeOutput } from "../../models/schemas";
import type { UnfinishedThread } from "../../../shared/types";
import type { MemoryObjectRepository } from "../../db/repositories/MemoryObjectRepository";
import type { ProactiveItemRepository } from "../../db/repositories/ProactiveItemRepository";
import type { TimelineBlockRepository } from "../../db/repositories/TimelineBlockRepository";
import type { UnfinishedThreadRepository } from "../../db/repositories/UnfinishedThreadRepository";
import type { SettingsService } from "../SettingsService";
import type { ReminderPolicy, JudgeWorkerDeps } from "./types";

/**
 * JudgeWorker：待收尾判断员（LinkerSceneJudgeWorker 的 Judge 部分）
 *
 * 由公共入口 LinkerSceneJudgeWorker 组合使用。
 */
export class JudgeWorker {
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly timelineBlockRepo: TimelineBlockRepository | null;
  private readonly unfinishedThreadRepo: UnfinishedThreadRepository | null;
  private readonly settingsService: SettingsService | null;

  constructor(deps: JudgeWorkerDeps) {
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.timelineBlockRepo = deps.timelineBlockRepo;
    this.unfinishedThreadRepo = deps.unfinishedThreadRepo;
    this.settingsService = deps.settingsService;
  }

  /**
   * 查询 openTasks（status=open/in_progress/likely_done/needs_confirmation）
   */
  fetchOpenTasks(): Task[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({
        status: "open",
        limit: 20,
      });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 20,
      });
      const likelyDoneTasks = this.memoryObjectRepo.listTasks({
        status: "likely_done",
        limit: 20,
      });
      const needsConfirmationTasks = this.memoryObjectRepo.listTasks({
        status: "needs_confirmation",
        limit: 20,
      });
      return [
        ...openTasks,
        ...inProgressTasks,
        ...likelyDoneTasks,
        ...needsConfirmationTasks,
      ];
    } catch {
      return [];
    }
  }

  /**
   * 查询 reminderPolicy（从 SettingsService 读取）
   */
  fetchReminderPolicy(): ReminderPolicy {
    const defaultPolicy: ReminderPolicy = {
      inAppReminders: true,
      desktopNotifications: false,
      dailyReportCandidate: true,
      priorityThreshold: 0.5,
    };
    if (!this.settingsService) return defaultPolicy;
    try {
      const settings = this.settingsService.getAll();
      return {
        inAppReminders: settings.notification.inAppReminders,
        desktopNotifications: settings.notification.desktopNotifications,
        dailyReportCandidate: settings.dailyReport.autoGenerate,
        priorityThreshold: 0.5,
      };
    } catch {
      return defaultPolicy;
    }
  }

  /**
   * 查询 todayTimelineBlocks（若 timelineBlockRepo 可用）
   *
   * 若 repo 未注入，返回空数组。
   */
  fetchTodayTimelineBlocks(dateKey: string): unknown[] {
    if (!this.timelineBlockRepo) return [];
    try {
      const blocks = this.timelineBlockRepo.findByDateKey(dateKey);
      return blocks.map((b) => ({
        id: b.id,
        title: b.title,
        summary: b.summary,
        startAt: b.startAt,
        endAt: b.endAt,
        category: b.category,
        projectNames: b.projectNames,
        generatedTasks: b.generatedTasks,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 从 ISO 时间字符串提取本地日期 key（YYYY-MM-DD）
   *
   * 用于 unfinished_threads.date_key 字段。
   * 不能直接取 ISO 字符串前 10 位（UTC 日期），否则在 UTC+8 凌晨 0-8 点会得到"昨天"。
   *
   * 注：utils/dateKey.ts 已有等价实现；迁移到共享工具由计划 todo 23 负责，本拆分不改动。
   */
  getLocalDateKey(isoTime: string): string {
    const date = new Date(isoTime);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * 写入 proactive_items 表
   *
   * 重要约束：
   * - 默认 surface 为 in_app 或 daily_report
   * - desktop_notification_candidate 需检查用户是否开启桌面通知
   *   - 若未开启：降级为 in_app
   * - in_app 但用户关闭应用内提醒：降级为 daily_report
   * - 优先级低于 priorityThreshold 的项不写入
   * - proactiveItems.priority 是数值 [0,1]（与 unfinishedThreads 的枚举 priority 不同）
   */
  writeProactiveItems(
    items: LinkerSceneJudgeOutput["proactiveItems"],
    policy: ReminderPolicy,
    debugEvents?: DebugEvent[]
  ): ProactiveItem[] {
    const written: ProactiveItem[] = [];
    for (const item of items) {
      try {
        // 优先级过滤（数值 [0,1]）
        if (item.priority < policy.priorityThreshold) {
          if (debugEvents) {
            debugEvents.push({ layer: "proactive", action: "skip", reason: "priority_below_threshold" });
          }
          continue;
        }

        // surface 处理（降级链：desktop_notification_candidate → in_app → daily_report）
        let surface = item.surface;
        if (
          surface === "desktop_notification_candidate" &&
          !policy.desktopNotifications
        ) {
          if (debugEvents) {
            debugEvents.push({ layer: "proactive", action: "downgrade", reason: "surface_downgrade: desktop_to_in_app" });
          }
          surface = "in_app";
        }
        if (surface === "in_app" && !policy.inAppReminders) {
          if (debugEvents) {
            debugEvents.push({ layer: "proactive", action: "downgrade", reason: "surface_downgrade: in_app_to_daily_report" });
          }
          surface = "daily_report";
        }
        if (surface === "daily_report" && !policy.dailyReportCandidate) {
          // 日报候选关闭，仍写入但保留 surface=daily_report（用户可手动触发日报）
        }

        const created = this.proactiveItemRepo.create({
          type: item.type,
          title: item.title,
          body: item.body,
          reason: item.reason,
          priority: item.priority,
          surface,
          requiresUserConfirmation: item.requiresUserConfirmation,
          status: "new",
          sourceFactIds: item.sourceFactIds,
          sourceSceneIds: item.sourceSceneIds,
        });
        written.push(created);
      } catch {
        // 单条写入失败不阻断其他
      }
    }
    return written;
  }

  /**
   * 写入 unfinished_threads 表（若 repo 可用）
   *
   * - 若 unfinishedThreadRepo 未注入，返回空数组，不持久化
   * - 若已注入，调用 upsertMany(dateKey, threads) 按 date_key 替换
   * - LLM 输出无 id/status/createdAt，由 Repository 填充默认值
   * - unfinishedThreads.priority 是枚举 "low"|"medium"|"high"（与 proactiveItems 的数值 priority 不同）
   *
   * @param threads LLM 输出的 unfinishedThreads
   * @param dateKey 本地日期 key（YYYY-MM-DD）
   * @param currentTime 当前时间（ISO），用作 lastSeenAt
   * @returns 已写入的 UnfinishedThread 数组（repo 未注入时为空）
   */
  writeUnfinishedThreads(
    threads: LinkerSceneJudgeOutput["unfinishedThreads"],
    dateKey: string,
    currentTime: string
  ): UnfinishedThread[] {
    if (!this.unfinishedThreadRepo) {
      // repo 未注入：不持久化，返回空数组
      return [];
    }

    if (threads.length === 0) {
      // LLM 输出空时不清空当天待收尾，避免反复删除
      // 待收尾事项只在跨日滚动或用户手动处理时清理
      return [];
    }

    try {
      const inputs = threads.map((t) => ({
        title: t.title,
        reason: t.reason,
        suggestedNextAction: t.suggestedNextAction,
        priority: t.priority,
        lastSeenAt: currentTime,
        sourceFactIds: t.sourceFactIds,
        sourceTimelineBlockIds: t.sourceTimelineBlockIds,
        confidence: t.confidence,
        status: "open" as const,
      }));
      return this.unfinishedThreadRepo.upsertMany(dateKey, inputs);
    } catch {
      // 持久化失败不阻断已写入的结果
      return [];
    }
  }
}
