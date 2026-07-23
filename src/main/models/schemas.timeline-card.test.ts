import { describe, expect, it } from "vitest";
import { TimelineCardOutputSchema } from "./schemas";

const validCard = {
  title: "整理时间轴窗口",
  summary: "完成窗口调度与水位线检查。",
  category: "coding",
  projectNames: ["Recall"],
  highlights: [],
  generatedTasks: [],
  generatedDecisions: [],
  reportable: true,
  privateRisk: "low",
  privateRiskReason: "",
  confidence: 0.9,
};

describe("TimelineCardOutputSchema", () => {
  it("accepts one semantic card", () => {
    expect(TimelineCardOutputSchema.safeParse(validCard).success).toBe(true);
  });

  it.each([
    ["array", [validCard]],
    ["blocks wrapper", { blocks: [validCard] }],
    ["model id", { ...validCard, id: "model-id" }],
    ["model date", { ...validCard, dateKey: "2026-07-23" }],
    ["model time", { ...validCard, startAt: "2026-07-23T01:03:00.000Z" }],
    ["model observation sources", { ...validCard, sourceObservationIds: ["o1"] }],
    ["model fact sources", { ...validCard, sourceFactIds: ["f1"] }],
    ["model episode sources", { ...validCard, sourceSceneIds: ["e1"] }],
  ])("rejects %s", (_name, value) => {
    expect(TimelineCardOutputSchema.safeParse(value).success).toBe(false);
  });
});
