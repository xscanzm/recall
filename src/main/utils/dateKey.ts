// src/main/utils/dateKey.ts
// 日期键工具（YYYY-MM-DD，本地时区）
//
// 修复根因：之前散落在各处的 `new Date().toISOString().slice(0, 10)` 是 UTC 切日，
// 在 UTC+8 时区下本地 0:00-8:00 会被误判为前一天。统一用本地日期工具。
//
// 重要：本模块的函数必须**只**用本地时区计算，禁止出现 `toISOString().slice(0, 10)`
// 或 `getUTC*` 系列。TimelineBuilderWorker.getLocalTodayStartIsoFromDateKey 与
// ReportScheduler.todayKey 都通过这里保持一致。

/**
 * 从 Date 生成本地日期键（YYYY-MM-DD）
 * - 用 getFullYear / getMonth / getDate（本地时区），不用 toISOString
 */
export function formatLocalDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 今日本地日期键（YYYY-MM-DD）
 */
export function localTodayKey(): string {
  return formatLocalDateKey(new Date());
}

/**
 * 日期键 + N 天（本地时区切日）
 * - 用于补跑机制："从 lastRunDate + 1 天" 顺序跑回今天
 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const date = new Date(y, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() + days);
  return formatLocalDateKey(date);
}

/**
 * 比较两个 dateKey 大小（YYYY-MM-DD 字符串可直接字典序比较）
 */
export function compareDateKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
