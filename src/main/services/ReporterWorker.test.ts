import { describe, expect, it } from "vitest";
import {
  buildMonthlyPrompt,
  filterReportableSources,
  getCalendarMonthRange,
} from "./ReporterWorker";

describe("filterReportableSources", () => {
  it("excludes explicit non-reportable and high-private legacy sources", () => {
    const sources = [
      { id: "legacy" },
      { id: "safe", reportable: true, privateRisk: "medium" },
      { id: "not-reportable", reportable: false, privateRisk: "low" },
      { id: "private", reportable: true, privateRisk: "high" },
    ];

    expect(filterReportableSources(sources).map((source) => source.id)).toEqual([
      "legacy",
      "safe",
    ]);
  });
});

describe("monthly report contract", () => {
  it("calculates the complete calendar month", () => {
    expect(getCalendarMonthRange("2026-02")).toEqual({
      monthStart: "2026-02-01",
      monthEnd: "2026-02-28",
    });
    expect(getCalendarMonthRange("2024-02")).toEqual({
      monthStart: "2024-02-01",
      monthEnd: "2024-02-29",
    });
  });

  it("uses month-specific prompt fields and terminology", () => {
    const prompt = buildMonthlyPrompt('{"monthStart":"2026-07-01","monthEnd":"2026-07-31"}');
    expect(prompt).toContain("本月");
    expect(prompt).toContain("下月重点");
    expect(prompt).toContain("monthStart/monthEnd");
    expect(prompt).toContain("nextMonthSuggestions");
    expect(prompt).toContain("不要输出 weekStart、weekEnd 或 nextWeekSuggestions");
    expect(prompt).not.toContain("输出 JSON，符合周报 schema");
  });
});
