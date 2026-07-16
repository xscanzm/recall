import { describe, expect, it } from "vitest";
import {
  buildEpisodeFactPrompt,
  EPISODE_FACT_PROMPT_CHAR_BUDGET,
  sanitizeVisibleContentForEpisodeFacts,
} from "./EpisodeFactExtractorWorker";

describe("EpisodeFactExtractorWorker prompt boundaries", () => {
  it("never forwards persisted OCR evidence or coordinates to L2", () => {
    const fullText = "模型校正后的完整文字";
    const result = sanitizeVisibleContentForEpisodeFacts([{
      type: "document",
      summary: "summary",
      fullText,
      keyTextSnippets: ["完整文字"],
      ocrEvidence: {
        text: "原始 OCR",
        blocks: Array.from({ length: 2_000 }, (_, index) => ({
          id: `block-${index}`,
          text: "重复坐标数据",
          boundingBox: { x: index, y: index, width: 100, height: 20 },
          words: [{
            text: "重复坐标数据",
            boundingBox: { x: index, y: index, width: 100, height: 20 },
          }],
        })),
      },
    }]);

    expect(result).toEqual([{
      type: "document",
      summary: "summary",
      fullText,
      keyTextSnippets: ["完整文字"],
    }]);
    expect(JSON.stringify(result)).not.toContain("boundingBox");
    expect(JSON.stringify(result)).not.toContain("ocrEvidence");
  });

  it("preserves normal fullText exactly when the prompt is within budget", () => {
    const input = extractorInput("完整正文");
    const result = buildEpisodeFactPrompt(input, "（无）");

    expect(result.compactedFullTextCount).toBe(0);
    expect(result.userPrompt).toContain("完整正文");
    expect(result.promptChars).toBeLessThan(EPISODE_FACT_PROMPT_CHAR_BUDGET);
  });

  it("compacts only the model copy of oversized fullText by actual prompt size", () => {
    const fullText = `开头${"内容".repeat(100_000)}结尾`;
    const input = extractorInput(fullText);
    const result = buildEpisodeFactPrompt(input, "（无）");

    expect(result.promptChars).toBeLessThanOrEqual(EPISODE_FACT_PROMPT_CHAR_BUDGET);
    expect(result.compactedFullTextCount).toBe(1);
    expect(result.userPrompt).toContain("开头");
    expect(result.userPrompt).toContain("结尾");
    expect(input.episodes[0].observations[0].visibleContent[0].fullText).toBe(fullText);
  });
});

function extractorInput(fullText: string) {
  return {
    episodes: [{
      sceneId: "scene-1",
      title: "title",
      summary: "summary",
      startAt: "2026-07-16T00:00:00.000Z",
      endAt: "2026-07-16T00:01:00.000Z",
      entityNames: [],
      observationIds: ["obs-1"],
      observations: [{
        id: "obs-1",
        visibleContent: [{
          type: "document",
          summary: "summary",
          fullText,
          keyTextSnippets: [],
        }],
      }],
    }],
    activeKnownProjects: [],
    activeTasks: [],
    userFeedbackSummary: "",
  };
}
