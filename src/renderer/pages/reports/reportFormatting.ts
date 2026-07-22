import { formatReportAsText } from "../../components/ReportEditor";
import type { ReportItem } from "../../state/store";
import type { PersonalReview } from "../../../shared/types";

export const REPORT_TYPE_LABELS: Record<string, string> = {
  daily: "日报",
  weekly: "周报",
  monthly: "月报",
  retrospective: "复盘",
  personal_daily_review: "复盘",
  work_daily_report: "工作日报",
};

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return formatDateKey(date);
}

export function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1 + months, 1);
  const nextYear = date.getFullYear();
  const nextMonth = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${nextYear}-${nextMonth}`;
}

export function formatUpdatedAt(updatedAt: string): string {
  if (!updatedAt) return "-";
  try {
    const date = new Date(updatedAt);
    return `${date.getFullYear()}-${(date.getMonth() + 1)
      .toString()
      .padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ${date
      .getHours()
      .toString()
      .padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
  } catch {
    return updatedAt;
  }
}

export function compilePersonalReviewToText(review: PersonalReview): string {
  const lines: string[] = [];
  lines.push(`# ${review.title || "我的复盘"}`);
  lines.push(`日期：${review.dateKey}`);
  lines.push("");

  lines.push("## 今天主要在做什么");
  lines.push(review.overview || "（暂无总览）");
  if ((review.mainThreads ?? []).length > 0) {
    review.mainThreads.forEach((thread) => lines.push(`- ${thread}`));
  }
  lines.push("");

  lines.push("## 有价值的进展");
  if ((review.meaningfulProgress ?? []).length > 0) {
    review.meaningfulProgress.forEach((progress) => lines.push(`- ${progress}`));
  } else {
    lines.push("今天没有记录到明显的进展。");
  }
  lines.push("");

  lines.push("## 还没收尾的事");
  if ((review.unfinished ?? []).length > 0) {
    review.unfinished.forEach((unfinished) => {
      lines.push(`- ${unfinished.text}`);
      if (unfinished.suggestedNextAction) {
        lines.push(`  建议下一步：${unfinished.suggestedNextAction}`);
      }
    });
  } else {
    lines.push("今天没有未收尾的事。");
  }
  lines.push("");

  lines.push("## 值得以后记住");
  if ((review.worthRemembering ?? []).length > 0) {
    review.worthRemembering.forEach((memory) => {
      lines.push(`- ${memory.text}`);
      if (memory.reason) lines.push(`  理由：${memory.reason}`);
    });
  } else {
    lines.push("今天没有特别需要记住的事。");
  }
  lines.push("");

  lines.push("## 明天可以从这里继续");
  if ((review.tomorrowStartHere ?? []).length > 0) {
    review.tomorrowStartHere.forEach((item, index) =>
      lines.push(`${index + 1}. ${item}`)
    );
  } else {
    lines.push("暂无建议。");
  }

  return lines.join("\n");
}

export function compileReportItemToText(item: ReportItem): string {
  try {
    const parsed = JSON.parse(item.contentJson) as Record<string, unknown>;

    if (typeof parsed.plainText === "string") {
      return parsed.plainText;
    }

    if (
      typeof parsed.headline === "string" &&
      typeof parsed.overview === "string"
    ) {
      try {
        return formatReportAsText(
          parsed as unknown as Parameters<typeof formatReportAsText>[0],
          item.title,
          item.dateKey,
          item.type === "monthly"
            ? "monthly"
            : item.type === "weekly"
            ? "weekly"
            : undefined
        );
      } catch {
        // Fall through to the generic representation for older report shapes.
      }
    }

    const lines: string[] = [];
    lines.push(`# ${item.title}`);
    lines.push(`日期：${item.dateKey}`);
    lines.push("");
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        lines.push(`## ${key}`);
        value.forEach((entry) => {
          if (typeof entry === "string") {
            lines.push(`- ${entry}`);
          } else if (entry && typeof entry === "object") {
            const object = entry as Record<string, unknown>;
            const text =
              typeof object.text === "string"
                ? object.text
                : typeof object.summary === "string"
                ? object.summary
                : JSON.stringify(entry);
            lines.push(`- ${text}`);
          }
        });
        lines.push("");
      } else if (
        typeof value === "string" &&
        key !== "date" &&
        key !== "weekStart" &&
        key !== "weekEnd" &&
        key !== "monthStart" &&
        key !== "monthEnd"
      ) {
        lines.push(`## ${key}`);
        lines.push(value);
        lines.push("");
      }
    }
    return lines.join("\n");
  } catch {
    return item.contentJson || item.title;
  }
}

export interface ReportSection {
  title: string;
  items: string[];
}

export function parseReportSections(item: ReportItem): ReportSection[] {
  try {
    const parsed = JSON.parse(item.contentJson) as Record<string, unknown>;

    if (typeof parsed.plainText === "string") {
      return [];
    }

    const sections: ReportSection[] = [];
    const isMonthly = item.type === "monthly";

    if (typeof parsed.overview === "string") {
      sections.push({
        title: isMonthly ? "本月概览" : "本周概览",
        items: [parsed.overview],
      });
    }

    if (Array.isArray(parsed.projectUpdates)) {
      sections.push({
        title: isMonthly ? "主要项目" : "项目进展",
        items: (parsed.projectUpdates as Array<Record<string, unknown>>).map(
          (project) => {
            const name =
              typeof project.projectName === "string" ? project.projectName : "";
            const summary =
              typeof project.summary === "string" ? project.summary : "";
            return name ? `${name}：${summary}` : summary;
          }
        ),
      });
    }

    if (Array.isArray(parsed.completed)) {
      sections.push({
        title: isMonthly ? "关键成果" : "完成事项",
        items: (parsed.completed as Array<Record<string, unknown>>).map(
          (completed) =>
            typeof completed.text === "string" ? completed.text : String(completed)
        ),
      });
    }

    if (Array.isArray(parsed.decisions)) {
      sections.push({
        title: isMonthly ? "重要决策" : "关键决策",
        items: (parsed.decisions as Array<Record<string, unknown>>).map((decision) =>
          typeof decision.text === "string" ? decision.text : String(decision)
        ),
      });
    }

    if (Array.isArray(parsed.risks)) {
      sections.push({
        title: isMonthly ? "持续风险" : "风险与阻塞",
        items: (parsed.risks as Array<Record<string, unknown>>).map((risk) =>
          typeof risk.text === "string" ? risk.text : String(risk)
        ),
      });
    }

    const nextKey = isMonthly
      ? Array.isArray(parsed.nextMonthSuggestions)
        ? "nextMonthSuggestions"
        : Array.isArray(parsed.nextWeekSuggestions)
        ? "nextWeekSuggestions"
        : null
      : Array.isArray(parsed.nextWeekSuggestions)
      ? "nextWeekSuggestions"
      : null;
    if (nextKey && Array.isArray(parsed[nextKey])) {
      sections.push({
        title: isMonthly ? "下月重点" : "下周计划",
        items: (parsed[nextKey] as string[]).map(String),
      });
    }

    return sections;
  } catch {
    return [];
  }
}
