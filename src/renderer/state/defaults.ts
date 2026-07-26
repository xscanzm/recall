// src/renderer/state/defaults.ts
// 跨 slice 共用的初始值与日期工具。
//
// 拆 store 之前这些是 store.ts 的模块私有函数，多个域都在用（today / reports /
// settings）。放这里而不是复制进每个 slice：EMPTY_TODAY 是「空数据」的唯一定义，
// 三个日期函数是同一套本地时区口径，复制出去早晚会各自漂移。
import type { TodayData } from "./types";

/** 今日数据的空态。清库、清缓存、加载失败都回落到这个值。 */
export const EMPTY_TODAY: TodayData = {
  observations: [],
  facts: [],
  scenes: [],
  tasks: [],
  decisions: [],
  people: [],
  projects: [],
};

/** 将 Date 格式化为 dateKey（YYYY-MM-DD，本地时区）。 */
export function formatDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今日 dateKey（YYYY-MM-DD，本地时区）。 */
export function todayDateKey(): string {
  return formatDateKey(new Date());
}

/** 本周一的 dateKey（YYYY-MM-DD，本地时区）。周日算上一周。 */
export function currentWeekStart(): string {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  return formatDateKey(monday);
}

/** 本月 monthKey（YYYY-MM，本地时区）。 */
export function currentMonthKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}
