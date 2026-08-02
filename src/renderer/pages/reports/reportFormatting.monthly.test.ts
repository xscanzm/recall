import { describe, expect, it } from "vitest";
import { formatReportAsText, type MonthlyReportContent } from "./reportFormatting";

describe("monthly report text formatting", () => {
  it("uses month and next-month wording", () => {
    const content: MonthlyReportContent = {
      monthStart: "2026-07-01",
      monthEnd: "2026-07-31",
      headline: "七月交付月报",
      overview: "本月完成主要交付。",
      projectUpdates: [],
      completed: [],
      decisions: [],
      risks: [],
      nextMonthSuggestions: ["下月继续推进验证"],
    };

    const text = formatReportAsText(content, content.headline, "2026-07-01", "monthly");

    expect(text).toContain("月份：2026-07-01 ~ 2026-07-31");
    expect(text).toContain("## 下月重点");
    expect(text).not.toContain("周期：");
    expect(text).not.toContain("下周建议");
  });
});
