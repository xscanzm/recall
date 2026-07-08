// src/renderer/pages/today/helpers.ts
// 今日页公用工具：dateKey 计算、时间格式化、状态 pill 配置、category 标签

import type { AppStatus, TimelineBlock, TimelineBlockCategory } from "../../../shared/types";

/** 生成今日 dateKey（YYYY-MM-DD，本地时区） */
export function todayDateKey(): string {
  return dateKeyFromDate(new Date());
}

/** 从 Date 生成 dateKey */
export function dateKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** dateKey -> Date（本地时区 00:00） */
export function dateFromKey(dateKey: string): Date {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** dateKey 偏移：+1 / -1 天 */
export function shiftDateKey(dateKey: string, deltaDays: number): string {
  const d = dateFromKey(dateKey);
  d.setDate(d.getDate() + deltaDays);
  return dateKeyFromDate(d);
}

/** 判断 dateKey 是否今天 */
export function isToday(dateKey: string): boolean {
  return dateKey === todayDateKey();
}

/** 友好日期标签：今天 / 昨天 / 明天 / YYYY-MM-DD */
export function friendlyDateLabel(dateKey: string): string {
  const today = todayDateKey();
  if (dateKey === today) return "今天";
  if (dateKey === shiftDateKey(today, -1)) return "昨天";
  if (dateKey === shiftDateKey(today, 1)) return "明天";
  return dateKey;
}

/** ISO 时间 -> HH:MM
 *  - 期望带时区（Z 或 ±HH:MM）
 *  - 兜底：检测到无时区后缀时按系统本地时区解析并 console.warn
 *  - 修复：之前静默接受无时区字符串，渲染端 new Date() 解析为本地时间，导致错位
 */
export function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    // 兜底检查：必须有 Z 或 ±HH:MM 后缀
    // 注意：只警告不抛错（兼容历史脏数据）
    if (
      typeof iso === "string" &&
      !/(Z|[+-]\d{2}:?\d{2})$/i.test(iso) &&
      iso.length > 10
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Recall] formatTime 收到无时区 ISO 字符串 "${iso}"，按本地时区解析可能错位`
      );
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return `${d.getHours().toString().padStart(2, "0")}:${d
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
  } catch {
    return "";
  }
}

/** 时间范围：HH:MM - HH:MM
 *  - 当 startAt 和 endAt 表示同一时刻时（resolution ≤ 1 分钟），只显示单点
 *  - 修复：之前同点也显示 "15:30 - 15:30" 看着像时间段
 */
export function formatTimeRange(startAt: string, endAt: string): string {
  const s = formatTime(startAt);
  const e = formatTime(endAt);
  if (s && e) {
    // 同点：单帧 observation 只有一个 capturedAt，startAt/endAt 必然相等
    if (s === e) return s;
    return `${s} - ${e}`;
  }
  if (s) return s;
  return "";
}

/**
 * 状态 pill 配置（spec 行 1384-1388）
 * - 观察中：绿点
 * - 已暂停：灰点
 * - 已跳过敏感内容：琥珀点
 * - 模型连接异常：红点
 */
export interface StatusPillConfig {
  label: string;
  dotClass: string;
}

export function getStatusPillConfig(status: AppStatus): StatusPillConfig {
  // 模型异常优先
  if (status.lastError || status.pipelineState === "error") {
    return { label: "模型连接异常", dotClass: "status-dot--danger" };
  }
  // 当前窗口为敏感内容
  if (status.currentWindow?.privacyState === "sensitive") {
    return { label: "已跳过敏感内容", dotClass: "status-dot--amber" };
  }
  if (status.paused || !status.observing) {
    return { label: "已暂停", dotClass: "status-dot--muted" };
  }
  return { label: "观察中", dotClass: "status-dot--accent" };
}

/** TimelineBlock category 中文标签（spec 行 1490-1506 + 7.3） */
const CATEGORY_LABELS: Record<TimelineBlockCategory, string> = {
  focus_work: "专注工作",
  communication: "沟通",
  research: "调研",
  writing: "写作",
  coding: "编码",
  design: "设计",
  meeting: "会议",
  admin: "事务",
  break: "休息",
  mixed: "综合",
  unknown: "活动",
};

export function categoryLabel(category: TimelineBlockCategory): string {
  return CATEGORY_LABELS[category] ?? "活动";
}

/**
 * 务实标题规则（spec 7.1 / 7.3）
 * - break 类别：短暂休息 / 离开电脑 / 暂无明显活动
 * - 其他类别：直接使用 block.title（要求 LLM 已输出务实标题）
 */
export function resolveBlockTitle(block: TimelineBlock): string {
  if (block.category === "break") {
    const t = block.title?.trim();
    if (!t || /摸鱼|闲置|无效/.test(t)) {
      return "短暂休息";
    }
    if (/离开|离开电脑|away/.test(t)) {
      return "离开电脑";
    }
    return t || "暂无明显活动";
  }
  return block.title || "未命名活动";
}

/**
 * break 类别的摘要（spec 7.3）
 * 如果 LLM 输出为空或带诗意词，给一个中性摘要
 */
export function resolveBlockSummary(block: TimelineBlock): string {
  const s = block.summary?.trim();
  if (block.category === "break") {
    if (!s || /深海|颂歌|心流|灵感/.test(s)) {
      return "这段时间没有明显电脑操作，可能是离开电脑或暂时休息。";
    }
    return s;
  }
  return s || "";
}

/** 判断是否为"仅看工作"应保留的类别 */
export function isWorkCategory(category: TimelineBlockCategory): boolean {
  return (
    category === "focus_work" ||
    category === "coding" ||
    category === "writing" ||
    category === "design" ||
    category === "meeting" ||
    category === "research" ||
    category === "communication"
  );
}

/** 判断 block 是否可加入工作日报（默认） */
export function isDefaultReportable(block: TimelineBlock): boolean {
  return block.reportable && block.privateRisk !== "high";
}
