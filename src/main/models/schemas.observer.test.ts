import { describe, expect, it } from "vitest";
import {
  BATCH_OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
  BATCH_OBSERVER_PROMPT_TEMPLATE,
  OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
  OBSERVER_PROMPT_TEMPLATE,
} from "./prompts";
import { ObserverOutputV2Schema } from "./schemas";

function observerOutput(fullText: string) {
  return {
    sceneSummary: "正在查看图片中的名单",
    userFacingSummary: "查看一张包含获奖名单的图片。",
    likelyWorkPurpose: "核对名单和奖项",
    visibleContent: [{
      type: "document",
      summary: "图片中的获奖名单",
      fullText,
      keyTextSnippets: ["获奖者", "奖项"],
    }],
    detectedEntities: [],
    possibleUserIntent: "核对获奖名单",
    possibleTasks: [],
    possibleDecisions: [],
    possibleProjectProgress: [],
    privacyRisk: "low",
    privacyRiskReason: "未发现明显隐私风险",
    reportableSignal: "no",
    reportableReason: "仅为资料查看",
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties: [],
  };
}

describe("L0 full visible text contract", () => {
  it("preserves complete text longer than the old evidence limit", () => {
    const fullText = Array.from({ length: 200 }, (_, index) => `第${index + 1}行：Matilda 人间唢呐奖`).join("\n");
    const parsed = ObserverOutputV2Schema.parse(observerOutput(fullText));
    expect(parsed.visibleContent[0].fullText).toBe(fullText);
    expect(parsed.visibleContent[0].fullText).toContain("第200行");
  });

  it("rejects a new observation that omits fullText", () => {
    const value = observerOutput("获奖者\n奖项") as { visibleContent: Array<Record<string, unknown>> };
    delete value.visibleContent[0].fullText;
    expect(ObserverOutputV2Schema.safeParse(value).success).toBe(false);
  });

  it.each([
    OBSERVER_PROMPT_TEMPLATE,
    OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
    BATCH_OBSERVER_EXTRACTOR_PROMPT_TEMPLATE,
    BATCH_OBSERVER_PROMPT_TEMPLATE,
  ])("requires exhaustive transcription in every observation prompt", (prompt) => {
    expect(prompt).toContain("fullText 是 L0 的原始信息源");
    expect(prompt).toContain("禁止挑选、概括、省略");
    expect(prompt).toContain("fullText");
  });
});
