// src/main/utils/isoTime.ts
// ISO 时间归一化工具
//
// 用途：
// - LLM 输出的 startAt/endAt 可能是带 Z / 带 +08:00 / 无时区 三种格式之一
// - 入库前统一过 new Date(iso).toISOString() 转成 Z 后缀格式
// - 修复：之前无时区字符串会被 new Date() 解析为本地时间，导致渲染端错位
// - 例：
//     "2026-07-07T08:30:00.000" → "2026-07-07T00:30:00.000Z"（本地 08:30 → UTC 00:30）
//     "2026-07-07T08:30:00.000+08:00" → "2026-07-07T00:30:00.000Z"
//     "2026-07-07T08:30:00.000Z" → "2026-07-07T08:30:00.000Z"（已正确，原样返回）

/**
 * 把任意 ISO 8601 字符串归一化为 UTC Z 后缀格式
 *
 * @param value 输入的 ISO 字符串（可能带 Z、带 offset、或无时区）
 * @returns UTC Z 字符串（带毫秒）；解析失败返回原值
 */
export function normalizeIsoToZ(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return value ?? "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  // 已是 Z 后缀：直接原样返回（避免重复 Date 解析导致时区跳变）
  if (/[Zz]$/.test(trimmed) || /[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    try {
      const d = new Date(trimmed);
      if (Number.isNaN(d.getTime())) return trimmed;
      return d.toISOString();
    } catch {
      return trimmed;
    }
  }
  // 无时区后缀：当作系统本地时间解析，然后转 UTC
  // 注意：Date 构造函数解析无时区 ISO 时按本地时区解释
  // 例：new Date("2026-07-07T08:30:00.000") 在 UTC+8 → UTC 00:30:00
  try {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) return trimmed;
    return d.toISOString();
  } catch {
    return trimmed;
  }
}
