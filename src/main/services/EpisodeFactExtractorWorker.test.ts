import { describe, expect, it, vi } from "vitest";
import {
  buildEpisodeFactPrompt,
  EpisodeFactExtractorWorker,
  EPISODE_FACT_PROMPT_CHAR_BUDGET,
  sanitizeVisibleContentForEpisodeFacts,
} from "./EpisodeFactExtractorWorker";
import { EpisodeFactExtractorOutputSchema } from "../models/schemas";

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
    expect(result.userPrompt).toContain("episodeActivities");
    expect(result.userPrompt).toContain("每个输入 episode 的 sceneId");
    expect(result.promptChars).toBeLessThan(EPISODE_FACT_PROMPT_CHAR_BUDGET);
  });

  it("validates Episode activity classifications independently from facts", () => {
    const parsed = EpisodeFactExtractorOutputSchema.parse({
      episodeActivities: [{
        sceneId: "scene-1",
        category: "coding",
        confidence: 0.92,
      }],
      facts: [],
      discardedNoise: [],
    });

    expect(parsed.episodeActivities).toEqual([{
      sceneId: "scene-1",
      category: "coding",
      confidence: 0.92,
    }]);
  });

  it("keeps fact extraction usable when the model omits Episode classifications", () => {
    const parsed = EpisodeFactExtractorOutputSchema.parse({
      facts: [],
      discardedNoise: [],
    });

    expect(parsed.episodeActivities).toEqual([]);
  });

  it("persists valid classifications back to their Episodes", async () => {
    const scene = {
      id: "scene-1",
      title: "修复 Recall",
      summary: "编写和调试代码",
      startAt: "2026-07-16T00:00:00.000Z",
      endAt: "2026-07-16T00:01:00.000Z",
      projectId: null,
      confidence: 0.9,
      activityCategory: "unknown",
      activityConfidence: 0,
      factIds: [],
      observationIds: ["obs-1"],
      entityNames: [],
      taskIds: [],
      decisionIds: [],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
      deletedAt: null,
      derivationKey: "episode:v1:obs-1",
      derivationVersion: 1,
    } as const;
    const update = vi.fn(() => ({ ...scene, activityCategory: "coding", activityConfidence: 0.94 }));
    const worker = new EpisodeFactExtractorWorker({
      modelGateway: {} as never,
      modelJobQueue: {
        enqueueMultimodalJob: vi.fn(async () => ({
          ok: true,
          data: {
            episodeActivities: [{ sceneId: "scene-1", category: "coding", confidence: 0.94 }],
            facts: [],
            discardedNoise: [],
          },
          modelJobId: "job-1",
          attempts: 1,
        })),
      } as never,
      factRepo: { create: vi.fn() } as never,
      observationRepo: {
        getById: vi.fn(() => ({
          id: "obs-1",
          capturedAt: "2026-07-16T00:00:00.000Z",
          appName: "Visual Studio Code",
          windowTitle: "Recall",
          visibleContent: [],
          detectedEntities: [],
          possibleTasks: [],
          possibleDecisions: [],
          uncertainties: [],
        })),
      } as never,
      sceneRepo: { update } as never,
      memoryObjectRepo: {
        listProjects: vi.fn(() => []),
        listTasks: vi.fn(() => []),
        listProjectAliases: vi.fn(() => []),
        listPersonAliases: vi.fn(() => []),
      } as never,
    });

    const result = await worker.run({
      scenes: [scene as never],
      multimodalModelConfigId: "model-1",
    });

    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith("scene-1", {
      activityCategory: "coding",
      activityConfidence: 0.94,
    });
    expect(result.data?.episodeActivities).toEqual([
      { sceneId: "scene-1", category: "coding", confidence: 0.94 },
    ]);
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
