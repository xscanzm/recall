// src/main/utils/timezone.ts
// 系统时区工具：统一为 prompt 输入提供 systemTimezone 字段
//
// 用途：
// - SceneBuilder / TimelineBuilder / Extractor / Linker / Judge 等 LLM 输入 JSON 顶层
//   暴露 systemTimezone 字段（如 "Asia/Shanghai"），让 LLM 知道如何把 UTC ISO 字符串
//   转换成本地时间，避免把本地小时数字误当 UTC 写出
// - 修复：之前 prompt 输入 JSON 只有 UTC ISO 字段，模型不知道本地时区，导致
//   startAt/endAt 错位 +8h 写入

import { getLocalTodayStartIso } from "../db/repositories/_helpers";

/**
 * 返回当前系统时区字符串（IANA 名称）
 * - 通过 Intl.DateTimeFormat 解析
 * - 失败时 fallback 到 "UTC"
 * - 例：UTC+8 机器 → "Asia/Shanghai"
 */
export function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * 返回系统时区偏移字符串（+HH:MM 或 -HH:MM）
 * - 例：UTC+8 → "+08:00"
 * - 与 getLocalTodayStartIso 的偏移算法一致
 */
export function getSystemTimezoneOffset(): string {
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset(); // 东半球为正
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

export { getLocalTodayStartIso };
