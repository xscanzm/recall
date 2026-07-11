import { describe, expect, it } from "vitest";
import { MemoryAskOutputSchema } from "./schemas";

describe("MemoryAskOutputSchema", () => {
  it("accepts source IDs without model-authored metadata", () => {
    expect(
      MemoryAskOutputSchema.parse({ answer: "answer", sourceIds: ["fact-1"] })
    ).toEqual({ answer: "answer", sourceIds: ["fact-1"] });
  });

  it("continues to validate legacy source objects", () => {
    expect(
      MemoryAskOutputSchema.safeParse({
        answer: "answer",
        sources: [{ id: "fact-1", type: "fact", title: "title" }],
      }).success
    ).toBe(true);
  });
});
