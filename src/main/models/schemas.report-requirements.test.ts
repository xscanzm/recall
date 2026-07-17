import { describe, expect, it } from "vitest";
import {
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
});
