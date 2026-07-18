import { describe, expect, it } from "vitest";
import {
  MonthlyReportOutputSchema,
  PersonalReviewGenerateInputSchema,
  ReportGenerateInputSchema,
} from "./schemas";

describe("report generation requirement schemas", () => {
  it("accepts an optional temporary requirement", () => {
    expect(PersonalReviewGenerateInputSchema.parse({
      dateKey: "2026-07-17",
      generationRequirement: "本次重点关注决策变化",
    })).toEqual({
      dateKey: "2026-07-17",
      generationRequirement: "本次重点关注决策变化",
    });

    expect(ReportGenerateInputSchema.parse({
      type: "weekly",
      dateKey: "2026-07-13",
      generationRequirement: "突出客户沟通",
    }).generationRequirement).toBe("突出客户沟通");
  });

  it("rejects oversized temporary requirements", () => {
    const generationRequirement = "x".repeat(2001);
    expect(() => PersonalReviewGenerateInputSchema.parse({
      dateKey: "2026-07-17",
      generationRequirement,
    })).toThrow();
    expect(() => ReportGenerateInputSchema.parse({
      type: "monthly",
      dateKey: "2026-07-01",
      generationRequirement,
    })).toThrow();
  });

  it("keeps monthly output on month-specific period fields", () => {
    const parsed = MonthlyReportOutputSchema.parse({
      monthStart: "2026-07-01",
      monthEnd: "2026-07-31",
      headline: "七月交付月报",
      overview: "本月完成主要交付。",
      projectUpdates: [],
      completed: [],
      decisions: [],
      risks: [],
      nextMonthSuggestions: ["下月继续推进验证"],
    });

    expect(parsed.monthStart).toBe("2026-07-01");
    expect(parsed.monthEnd).toBe("2026-07-31");
    expect(parsed.nextMonthSuggestions).toEqual(["下月继续推进验证"]);
    expect("weekStart" in parsed).toBe(false);
    expect("nextWeekSuggestions" in parsed).toBe(false);
  });

  it("normalizes legacy period names when a model returns weekly keys", () => {
    const parsed = MonthlyReportOutputSchema.parse({
      weekStart: "2026-02-01",
      weekEnd: "2026-02-28",
      headline: "二月月报",
      overview: "本月完成主要交付。",
      projectUpdates: [],
      completed: [],
      decisions: [],
      risks: [],
      nextWeekSuggestions: ["下月继续推进验证"],
    });

    expect(parsed.monthStart).toBe("2026-02-01");
    expect(parsed.monthEnd).toBe("2026-02-28");
    expect(parsed.nextMonthSuggestions).toEqual(["下月继续推进验证"]);
  });
});
