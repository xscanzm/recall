import type { WorkReport } from "../../shared/types";

/** reports 表记录的最小形状，避免适配器依赖 store 的完整状态类型。 */
export interface DailyReportRecordLike {
  id: string;
  dateKey: string;
  title: string;
  contentJson: string;
  sourceFactIds?: string[];
  sourceSceneIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 将自动日报（type=daily）投影为报告页工作日报 Tab 使用的展示模型。
 * 自动日报和人工选片段工作日报仍保持不同的持久化类型。
 */
export function dailyReportRecordToWorkReport(
  record: DailyReportRecordLike | null | undefined
): WorkReport | null {
  if (!record) return null;

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(record.contentJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const headline = readString(parsed.headline);
  const overview = readString(parsed.overview);
  const completed = readTextItems(parsed.completed);
  const projectProgress = readObjectItems(parsed.projectUpdates)
    .map((item) => {
      const project = readString(item.projectName);
      const summary = readString(item.summary);
      return project && summary ? `${project}：${summary}` : project || summary;
    })
    .filter(Boolean);
  const risks = readTextItems(parsed.risks);
  const tomorrowPlan = readTextItems(parsed.tomorrowSuggestions);
  const openTasks = readObjectItems(parsed.openTasks)
    .map((item) => {
      const text = readString(item.text);
      const status = readString(item.status);
      return text && status ? `${text}（${status}）` : text;
    })
    .filter(Boolean);
  const decisions = readTextItems(parsed.decisions);
  const needsReview = readObjectItems(parsed.needsReview)
    .map((item) => {
      const text = readString(item.text);
      const reason = readString(item.reason);
      return text && reason ? `${text}（${reason}）` : text;
    })
    .filter(Boolean);

  const editedPlainText = readString(parsed.plainText);
  const plainText = parsed.edited === true && editedPlainText
    ? editedPlainText
    : composeDailyPlainText({
        headline: headline || record.title,
        overview,
        completed,
        projectProgress,
        openTasks,
        decisions,
        risks,
        tomorrowPlan,
        needsReview,
      }) || editedPlainText;

  return {
    id: record.id,
    dateKey: record.dateKey,
    title: record.title || headline || `日报 ${record.dateKey}`,
    plainText,
    sections: {
      completed,
      projectProgress,
      risks,
      tomorrowPlan,
    },
    sourceTimelineBlockIds: [],
    sourceFactIds: Array.isArray(record.sourceFactIds) ? record.sourceFactIds : [],
    sourceSceneIds: Array.isArray(record.sourceSceneIds) ? record.sourceSceneIds : [],
    omittedForPrivacy: 0,
    warnings: [],
    reportType: "daily",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function composeDailyPlainText(input: {
  headline: string;
  overview: string;
  completed: string[];
  projectProgress: string[];
  openTasks: string[];
  decisions: string[];
  risks: string[];
  tomorrowPlan: string[];
  needsReview: string[];
}): string {
  const output: string[] = [];
  if (input.headline) output.push(input.headline);
  if (input.overview) output.push(input.overview);
  appendSection(output, "项目进展", input.projectProgress);
  appendSection(output, "今日完成", input.completed);
  appendSection(output, "待处理事项", input.openTasks);
  appendSection(output, "重要决策", input.decisions);
  appendSection(output, "问题与风险", input.risks);
  appendSection(output, "明日建议", input.tomorrowPlan);
  appendSection(output, "需要确认", input.needsReview);
  return output.join("\n\n");
}

function appendSection(output: string[], title: string, items: string[]): void {
  if (items.length === 0) return;
  output.push(`${title}\n${items.map((item) => `- ${item}`).join("\n")}`);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readObjectItems(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
  );
}

function readTextItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return readString((item as Record<string, unknown>).text);
      }
      return "";
    })
    .filter(Boolean);
}
