// src/renderer/state/ipc.ts
// Renderer 端 IPC 客户端封装
//
// 通过 preload 暴露的 window.recallAPI 调用 main 进程能力
// 这是 renderer 唯一允许的 main 进程调用入口

import type { RecallApi } from "../../main/preload";
import type {
  AppStatus,
  IpcResult,
  TodayTimelineProjection,
  UnfinishedThread,
  PersonalReview,
  WorkReport,
  TodayPageData,
  TodayActivityOverview,
} from "../../shared/types";

/**
 * 全局 window 类型扩展
 */
declare global {
  interface Window {
    recallAPI: RecallApi;
  }
}

/**
 * IPC 客户端单例
 */
export const ipc = typeof window === "undefined"
  ? undefined
  : (window as unknown as { recallAPI: RecallApi }).recallAPI;

/**
 * 安全获取 IPC 客户端，preload 未注入时给出明确错误
 */
export function getIpc(): RecallApi {
  if (!ipc) {
    throw new Error(
      "window.recallAPI 未注入。preload 脚本可能未加载，或 contextBridge 配置错误。"
    );
  }
  return ipc;
}

// ============================================================================
// Phase 2 IPC 类型安全封装（timeline / personalReview / workReport / unfinishedThreads）
// preload 暴露的 API 返回 IpcResult<unknown>，这里负责解包并转换为具体类型。
// ============================================================================

/** 解包列表查询；失败时保留 IPC 错误语义。 */
export function unwrapList<T>(result: IpcResult<unknown>): T[] {
  if (!result.ok) throw new Error(result.error || "IPC 查询失败");
  const data = result.data;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** 解包可选对象；成功的 null 表示对象尚不存在。 */
export function unwrapOptional<T>(result: IpcResult<unknown>): T | undefined {
  if (!result.ok) throw new Error(result.error || "IPC 查询失败");
  const data = result.data;
  return data ? (data as T) : undefined;
}

/** 获取由已存 Episode / Atom / Moment 派生的当日展示投影（不调用 LLM） */
export async function fetchTimeline(dateKey: string): Promise<TodayTimelineProjection[]> {
  const res = await getIpc().timeline.get(dateKey);
  return unwrapList<TodayTimelineProjection>(res);
}

export async function fetchActivityOverview(dateKey: string): Promise<TodayActivityOverview> {
  const res = await getIpc().activity.getDayOverview(dateKey);
  if (!res.ok) throw new Error(res.error || "每日活动概览加载失败");
  return res.data as TodayActivityOverview;
}

/** 获取待收尾列表 */
export async function fetchUnfinishedThreads(
  dateKey: string
): Promise<UnfinishedThread[]> {
  const res = await getIpc().unfinishedThreads.list({ dateKey, status: "open" });
  return unwrapList<UnfinishedThread>(res);
}

/** 获取个人复盘（已落库） */
export async function fetchPersonalReview(
  dateKey: string
): Promise<PersonalReview | undefined> {
  const res = await getIpc().personalReview.get(dateKey);
  return unwrapOptional<PersonalReview>(res);
}

/** 获取工作日报（已落库） */
export async function fetchWorkReport(
  dateKey: string
): Promise<WorkReport | undefined> {
  const res = await getIpc().workReport.get(dateKey);
  return unwrapOptional<WorkReport>(res);
}

/**
 * 组装 TodayPageData：并行拉取时间轴、活动统计、待收尾和报告数据，
 * 并派生 dayMainThread/highlights/decisions/tomorrowStartHere。
 *
 * 派生规则：
 * - dayMainThread: 优先 personalReview.overview；否则从 timeline blocks 的 projectNames 派生；
 *   再否则用首个 block 标题；都没有则 "今天还没有整理出主线。"
 * - highlights: 从全部 timeline projections 的 highlights 字段聚合，最多 8 条；
 *   reportable 只约束对外日报，不约束给用户自己的 Today 页面
 * - decisions: 从 timeline blocks 的 generatedDecisions 聚合，最多 8 条
 * - tomorrowStartHere: 优先 personalReview.tomorrowStartHere；
 *   否则从 open 状态的 unfinishedThreads 的 suggestedNextAction 取前 3 条
 */
export async function fetchTodayPageData(
  dateKey: string,
  appStatus: AppStatus
): Promise<TodayPageData> {
  const [timelineBlocks, activityOverview, unfinishedThreads, personalReview, workReport] =
    await Promise.all([
      fetchTimeline(dateKey),
      fetchActivityOverview(dateKey),
      fetchUnfinishedThreads(dateKey),
      fetchPersonalReview(dateKey),
      fetchWorkReport(dateKey),
    ]);
  // Today 是自用视图；reportable 只用于对外日报选择。
  const highlights: Array<{ id: string; content: string }> = [];
  for (const block of timelineBlocks) {
    for (const h of block.highlights) {
      if (!h) continue;
      highlights.push({ id: `${block.id}__h${highlights.length}`, content: h });
      if (highlights.length >= 8) break;
    }
    if (highlights.length >= 8) break;
  }

  // 派生 decisions
  const decisions: Array<{ id: string; content: string }> = [];
  for (const block of timelineBlocks) {
    for (const d of block.generatedDecisions) {
      if (!d) continue;
      decisions.push({ id: `${block.id}__d${decisions.length}`, content: d });
      if (decisions.length >= 8) break;
    }
    if (decisions.length >= 8) break;
  }

  // 派生 dayMainThread
  let dayMainThread: string;
  if (personalReview?.overview) {
    dayMainThread = personalReview.overview;
  } else {
    const projectSet = new Set<string>();
    timelineBlocks.forEach((b) =>
      b.projectNames.forEach((p) => p && projectSet.add(p))
    );
    const projectList = Array.from(projectSet).slice(0, 3);
    if (projectList.length > 0) {
      dayMainThread = `今天主要围绕 ${projectList.join("、")} 展开。`;
    } else if (timelineBlocks.length > 0) {
      dayMainThread = timelineBlocks[0].title;
    } else {
      dayMainThread = "今天还没有整理出主线。";
    }
  }

  // 派生 tomorrowStartHere
  const tomorrowStartHere =
    personalReview?.tomorrowStartHere && personalReview.tomorrowStartHere.length > 0
      ? personalReview.tomorrowStartHere
      : unfinishedThreads
          .filter((t) => t.status === "open")
          .slice(0, 3)
          .map((t) => t.suggestedNextAction)
          .filter(Boolean);

  return {
    dateKey,
    appStatus,
    dayMainThread,
    timelineBlocks,
    activityOverview,
    unfinishedThreads,
    highlights,
    decisions,
    personalReview,
    workReport,
    tomorrowStartHere,
  };
}
