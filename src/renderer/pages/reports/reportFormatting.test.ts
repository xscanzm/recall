import { describe, expect, it } from "vitest";
import type { PersonalReview } from "../../../shared/types";
import type { ReportItem } from "../../state/store";
import {
  addDays,
  addMonths,
  compilePersonalReviewToText,
  compileReportItemToText,
  formatUpdatedAt,
  parseReportSections,
} from "./reportFormatting";

function reportItem(
  type: string,
  content: Record<string, unknown> | string
): ReportItem {
  return {
    id: "report-1",
    type,
    dateKey: "2026-07-20",
    title: "研发报告",
    contentJson: typeof content === "string" ? content : JSON.stringify(content),
    sourceFactIds: [],
    sourceSceneIds: [],
    createdAt: "2026-07-20T09:00:00",
    updatedAt: "2026-07-20T09:05:00",
  };
}

describe("reportFormatting", () => {
  it("keeps report date navigation correct across month and year boundaries", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });

  it("formats report update timestamps without changing the display contract", () => {
    expect(formatUpdatedAt("")).toBe("-");
    expect(formatUpdatedAt("2026-07-20T09:05:00")).toBe("2026-07-20 09:05");
  });

  it("compiles a personal review using the existing reader-facing language", () => {
    const review: PersonalReview = {
      id: "review-1",
      dateKey: "2026-07-20",
      title: "我的一天",
      overview: "推进了报告模块。",
      mainThreads: ["报告要求"],
      meaningfulProgress: ["完成月报适配"],
      unfinished: [
        {
          text: "补充回归测试",
          suggestedNextAction: "覆盖旧月报",
          sourceTimelineBlockIds: [],
          sourceFactIds: [],
        },
      ],
      worthRemembering: [
        { text: "保持类型语义", reason: "避免展示回归", sourceFactIds: [] },
      ],
      tomorrowStartHere: ["先跑类型检查"],
    };

    const text = compilePersonalReviewToText(review);
    expect(text).toContain("# 我的一天");
    expect(text).toContain("## 还没收尾的事");
    expect(text).toContain("建议下一步：覆盖旧月报");
    expect(text).toContain("理由：避免展示回归");
    expect(text).toContain("1. 先跑类型检查");
  });

  it("keeps edited plain text authoritative and preserves invalid legacy content", () => {
    expect(
      compileReportItemToText(reportItem("weekly", { plainText: "已编辑正文" }))
    ).toBe("已编辑正文");
    expect(compileReportItemToText(reportItem("weekly", "旧版非 JSON 正文"))).toBe(
      "旧版非 JSON 正文"
    );
  });

  it("maps weekly and monthly report structures to their existing section labels", () => {
    const content = {
      overview: "整体进展",
      projectUpdates: [{ projectName: "Recall", summary: "完成拆分" }],
      completed: [{ text: "完成测试" }],
      decisions: [{ text: "保留显式依赖" }],
      risks: [{ text: "仍需全量回归" }],
      nextWeekSuggestions: ["继续验证"],
    };

    expect(parseReportSections(reportItem("weekly", content))).toEqual([
      { title: "本周概览", items: ["整体进展"] },
      { title: "项目进展", items: ["Recall：完成拆分"] },
      { title: "完成事项", items: ["完成测试"] },
      { title: "关键决策", items: ["保留显式依赖"] },
      { title: "风险与阻塞", items: ["仍需全量回归"] },
      { title: "下周计划", items: ["继续验证"] },
    ]);

    expect(parseReportSections(reportItem("monthly", content))).toEqual([
      { title: "本月概览", items: ["整体进展"] },
      { title: "主要项目", items: ["Recall：完成拆分"] },
      { title: "关键成果", items: ["完成测试"] },
      { title: "重要决策", items: ["保留显式依赖"] },
      { title: "持续风险", items: ["仍需全量回归"] },
      { title: "下月重点", items: ["继续验证"] },
    ]);
  });
});
