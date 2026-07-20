import { describe, expect, it } from "vitest";
import { dailyReportRecordToWorkReport } from "./reportAdapters";

describe("dailyReportRecordToWorkReport", () => {
  it("projects an automatic daily report into the work report view model", () => {
    const result = dailyReportRecordToWorkReport({
      id: "daily-1",
      dateKey: "2026-07-20",
      title: "日报 2026-07-20",
      contentJson: JSON.stringify({
        headline: "今天完成了关键推进",
        overview: "围绕发布任务持续推进。",
        projectUpdates: [{ projectName: "Recall", summary: "完成报告链路修复。" }],
        completed: [{ text: "修复日报展示", confidence: 0.9, evidenceFactIds: ["fact-1"] }],
        openTasks: [{ text: "补充回归测试", status: "open" }],
        decisions: [{ text: "保持两种报告类型独立" }],
        risks: [{ text: "需要观察历史数据兼容性" }],
        tomorrowSuggestions: ["验证自动生成结果"],
        needsReview: [{ text: "一条待确认事项", reason: "证据不足" }],
      }),
      sourceFactIds: ["fact-1"],
      sourceSceneIds: ["scene-1"],
    });

    expect(result).toMatchObject({
      id: "daily-1",
      dateKey: "2026-07-20",
      reportType: "daily",
      sourceFactIds: ["fact-1"],
      sourceSceneIds: ["scene-1"],
      sections: {
        completed: ["修复日报展示"],
        projectProgress: ["Recall：完成报告链路修复。"],
        risks: ["需要观察历史数据兼容性"],
        tomorrowPlan: ["验证自动生成结果"],
      },
    });
    expect(result?.plainText).toContain("待处理事项");
    expect(result?.plainText).toContain("保持两种报告类型独立");
  });

  it("keeps an edited automatic report body", () => {
    const result = dailyReportRecordToWorkReport({
      id: "daily-edited",
      dateKey: "2026-07-20",
      title: "日报 2026-07-20",
      contentJson: JSON.stringify({ plainText: "用户编辑后的日报正文", edited: true }),
    });

    expect(result?.plainText).toBe("用户编辑后的日报正文");
    expect(result?.reportType).toBe("daily");
  });
});
