import { describe, expect, it } from "vitest";
import {
  BatchObserverExtractorOutputSchema,
  BatchObserverOutputSchema,
  EpisodeFactExtractorOutputSchema,
  ExtractorOutputSchema,
  ExtractorOutputV2Schema,
} from "./schemas";

const validFact = {
  type: "knowledge",
  content: "记住了一个知识点",
  peopleHints: [],
  importance: 0.8,
  confidence: 0.9,
  inferred: true,
  evidenceText: "从画面中看到",
  sourceObservationIds: [],
  tags: [],
  displayUse: ["memory"],
  reportable: true,
  privateRisk: "low",
  userValue: "medium",
};

describe("extractor output missing-array fallback", () => {
  it("V2 episode extractor: missing facts defaults to []", () => {
    const parsed = EpisodeFactExtractorOutputSchema.parse({
      episodeActivities: [{ sceneId: "s1", category: "coding", confidence: 0.8 }],
    });
    expect(parsed.facts).toEqual([]);
  });

  it("V2 extractor: empty object defaults facts to []", () => {
    const parsed = ExtractorOutputV2Schema.parse({});
    expect(parsed.facts).toEqual([]);
  });

  it("V1 extractor: empty object defaults facts to []", () => {
    const parsed = ExtractorOutputSchema.parse({});
    expect(parsed.facts).toEqual([]);
  });

  it("batch observer: single non-array observation is wrapped into array", () => {
    const parsed = BatchObserverOutputSchema.parse({
      observations: { frameIndex: 1 },
    });
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].frameIndex).toBe(1);
  });

  it("batch observer extractor: single non-array observation is wrapped into array", () => {
    const parsed = BatchObserverExtractorOutputSchema.parse({
      observations: { frameIndex: 1 },
    });
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].frameIndex).toBe(1);
  });

  it("V2 extractor: bare fact array is still wrapped (no regression)", () => {
    const parsed = ExtractorOutputV2Schema.parse([{ ...validFact }]);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0].type).toBe("knowledge");
  });

  it("V2 extractor: valid output with facts is unchanged", () => {
    const parsed = ExtractorOutputV2Schema.parse({
      facts: [{ ...validFact }],
      discardedNoise: [],
    });
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.facts[0].content).toBe("记住了一个知识点");
  });
});
