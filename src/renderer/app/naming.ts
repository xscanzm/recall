// src/renderer/app/naming.ts
// 前台命名映射（来自 08 文档 "交互原则与前台命名" 章节）
//
// 重要约束：
// - 不在 UI 中暴露 L0/L1/L2/L3 术语
// - 前台使用"观察、线索、工作片段、长期记忆、提醒、日报"等更自然的词
//
// 映射（来自 08 文档）：
// - Observation -> 观察
// - Fact -> 线索
// - Scene -> 工作片段
// - Memory Object -> 长期记忆
// - Proactive Item -> 提醒
// - Daily Report -> 日报

/**
 * 核心前台命名映射
 */
export const NAMING = {
  observation: "观察",
  fact: "线索",
  scene: "工作片段",
  memoryObject: "长期记忆",
  proactiveItem: "提醒",
  dailyReport: "日报",
  weeklyReport: "周报",
  task: "任务",
  project: "项目",
  decision: "决策",
  person: "人物",
} as const;

/**
 * 提醒类型（Proactive Item type）前台名称
 * 来自 03 文档 JudgeOutput.proactiveItems.type
 */
export const REMINDER_TYPE_LABELS: Record<string, string> = {
  task_reminder: "任务提醒",
  unfinished_work: "未完成工作",
  decision_review: "决策复盘",
  project_update: "项目进展",
  daily_summary_candidate: "日报候选",
  tomorrow_suggestion: "明日建议",
  risk_warning: "风险预警",
  needs_confirmation: "待确认",
};

/**
 * 提醒类型颜色（来自 08 文档"提醒类型颜色"章节）
 * - 待确认：amber (#D9912B)
 * - 任务提醒：green (#2F8F83)
 * - 风险：danger (#C74D3C)
 * - 项目进展：neutral（border 灰色 #E2E0D8，文字 #66706D）
 */
export const REMINDER_TYPE_COLORS: Record<string, string> = {
  task_reminder: "#2F8F83", // green
  unfinished_work: "#2F8F83", // green（未完成工作归为任务提醒类）
  decision_review: "#66706D", // neutral
  project_update: "#66706D", // neutral
  daily_summary_candidate: "#66706D", // neutral
  tomorrow_suggestion: "#66706D", // neutral
  risk_warning: "#C74D3C", // danger
  needs_confirmation: "#D9912B", // amber
};

/**
 * 提醒类型图标符号（不使用 emoji，使用文字标签）
 * 08 文档要求"类型图标"，但约束 8 明确"不使用 emoji"
 * 因此使用简洁的中文字符标签作为类型标识
 */
export const REMINDER_TYPE_ICONS: Record<string, string> = {
  task_reminder: "任",
  unfinished_work: "未",
  decision_review: "决",
  project_update: "项",
  daily_summary_candidate: "报",
  tomorrow_suggestion: "明",
  risk_warning: "险",
  needs_confirmation: "疑",
};

/**
 * Fact type 前台名称
 * 来自 03 文档 ExtractorOutput.facts.type
 */
export const FACT_TYPE_LABELS: Record<string, string> = {
  task: "任务",
  decision: "决策",
  project_progress: "项目进展",
  person: "人物",
  preference: "偏好",
  knowledge: "知识",
  risk: "风险",
  question: "问题",
  note: "笔记",
};

/**
 * Task status 前台名称
 * 来自 04 文档 TaskMemory.status
 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  open: "未完成",
  in_progress: "进行中",
  likely_done: "可能已完成",
  done: "已完成",
  blocked: "阻塞",
  needs_confirmation: "待确认",
  unknown: "未知",
};

/**
 * Proactive Item status 前台名称
 * 用于提醒页过滤和分组
 */
export const REMINDER_STATUS_LABELS: Record<string, string> = {
  new: "待处理",
  confirmed: "已确认",
  ignored: "已忽略",
  snoozed: "稍后",
  done: "已完成",
  do_not_remind_again: "不再提醒",
};

/**
 * 置信度等级标签
 */
export function confidenceLabel(c: number): string {
  if (c >= 0.8) return "高";
  if (c >= 0.5) return "中";
  return "低";
}

/**
 * 根据提醒类型获取前台名称
 */
export function getReminderTypeLabel(type: string): string {
  return REMINDER_TYPE_LABELS[type] ?? "提醒";
}

/**
 * 根据提醒类型获取颜色
 */
export function getReminderTypeColor(type: string): string {
  return REMINDER_TYPE_COLORS[type] ?? "#66706D";
}

/**
 * 根据提醒类型获取图标字符
 */
export function getReminderTypeIcon(type: string): string {
  return REMINDER_TYPE_ICONS[type] ?? "提";
}
