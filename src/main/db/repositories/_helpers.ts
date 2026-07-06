// src/main/db/repositories/_helpers.ts
// Repository 层共享辅助函数
//
// 时区说明：
// 数据库中以 ISO 8601 字符串存储时间戳（通常为 UTC，后缀 Z）。
// 当按"今天"过滤时，若直接用 new Date().toISOString() 取日期部分，
// 在 UTC+8 凌晨 0:00-8:00 之间会得到"昨天"的 UTC 日期，导致今日页面为空。
//
// 解决方案：使用本地日期构造起始时间，并附带本地时区偏移（如 +08:00），
// SQLite 对带偏移的 ISO 8601 字符串的比较与对 UTC 字符串的比较结果一致。

/**
 * 返回本地时区"今天 00:00:00.000"对应的 ISO 8601 字符串（带时区偏移）。
 *
 * 示例：
 *   - UTC+8 时区 2024-06-15 凌晨 02:00（本地）→ "2024-06-15T00:00:00.000+08:00"
 *   - UTC-5 时区 2024-06-14 晚上 23:00（本地）→ "2024-06-14T00:00:00.000-05:00"
 *
 * 注意：返回值不带 "Z" 后缀，而是带本地时区偏移，SQLite 字符串比较
 * 可正确与 UTC ISO 字符串（带 "Z"）进行大小比较。
 */
export function getLocalTodayStartIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayKey = `${year}-${month}-${day}`;

  // getTimezoneOffset() 返回 UTC - 本地 的分钟数（西半球为正，东半球为负）
  // 例如 UTC+8 返回 -480；取负后为东半球正数
  const offsetMinutes = -now.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absMinutes / 60);
  const offsetMins = absMinutes % 60;
  const offsetStr = `${offsetSign}${String(offsetHours).padStart(2, "0")}:${String(offsetMins).padStart(2, "0")}`;

  return `${todayKey}T00:00:00.000${offsetStr}`;
}
