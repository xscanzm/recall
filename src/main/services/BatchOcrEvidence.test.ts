import { describe, expect, it } from "vitest";
import { buildBatchOcrEvidenceJson } from "./BatchOcrEvidence";

describe("buildBatchOcrEvidenceJson", () => {
  it("remaps original OCR indexes after a compressed frame is dropped", () => {
    const json = buildBatchOcrEvidenceJson([
      { frameIndex: 1, text: "first", lines: ["first"], language: "en-US" },
      { frameIndex: 2, text: "dropped", lines: ["dropped"], language: "en-US" },
      { frameIndex: 3, text: "第三帧", lines: ["第三", "帧"], language: "zh-Hans-CN" },
    ], [0, 2]);

    expect(JSON.parse(json)).toEqual([
      {
        frameIndex: 1,
        source: "windows_ocr_original_image",
        available: true,
        language: "en-US",
        text: "first",
      },
      {
        frameIndex: 2,
        source: "windows_ocr_original_image",
        available: true,
        language: "zh-Hans-CN",
        text: "第三\n帧",
      },
    ]);
  });

  it("marks old batches without OCR evidence as unavailable", () => {
    expect(JSON.parse(buildBatchOcrEvidenceJson(undefined, [0]))).toEqual([
      {
        frameIndex: 1,
        source: "windows_ocr_original_image",
        available: false,
        text: "",
      },
    ]);
  });

  it("emits one structured baseline and only block changes for the next frame", () => {
    const firstBlock = block("stable", "Stable", 10, 10);
    const changedBlock = block("changed", "After", 10, 40);
    const json = buildBatchOcrEvidenceJson([
      {
        frameIndex: 1,
        text: "Stable\nBefore",
        lines: ["Stable", "Before"],
        blocks: [firstBlock, block("before", "Before", 10, 40)],
        mode: "full",
      },
      {
        frameIndex: 2,
        text: "Stable\nAfter",
        lines: ["Stable", "After"],
        blocks: [firstBlock, changedBlock],
        mode: "delta",
        deltaFromFrameIndex: 1,
        delta: {
          unchangedBlockIds: ["stable"],
          addedBlocks: [],
          changedBlocks: [{ previousBlockId: "before", block: changedBlock }],
          removedBlocks: [],
        },
      },
    ], [0, 1]);

    const parsed = JSON.parse(json);
    expect(parsed[0]).toMatchObject({
      frameIndex: 1,
      mode: "full",
      text: "Stable\nBefore",
      blocks: [{ id: "stable", text: "Stable" }],
    });
    expect(parsed[1]).toEqual({
      frameIndex: 2,
      source: "windows_ocr_original_image",
      available: true,
      mode: "delta",
      baseFrameIndex: 1,
      unchangedBlockCount: 1,
      addedBlocks: [],
      changedBlocks: [{
        previousBlockId: "before",
        block: {
          id: "changed",
          text: "After",
          boundingBox: { x: 10, y: 40, width: 100, height: 20 },
          words: [{ text: "After", boundingBox: { x: 10, y: 40, width: 100, height: 20 } }],
        },
      }],
      removedBlocks: [],
    });
  });

  it("resolves a delta base through an omitted exact duplicate frame", () => {
    const json = buildBatchOcrEvidenceJson([
      { frameIndex: 1, text: "base", lines: ["base"], blocks: [block("base", "base", 0, 0)], mode: "full" },
      { frameIndex: 2, text: "base", lines: ["base"], blocks: [block("base", "base", 0, 0)], mode: "exact_reuse", reuseFromFrameIndex: 1 },
      {
        frameIndex: 3,
        text: "next",
        lines: ["next"],
        blocks: [block("next", "next", 0, 0)],
        mode: "delta",
        deltaFromFrameIndex: 2,
        delta: {
          unchangedBlockIds: [],
          addedBlocks: [block("next", "next", 0, 0)],
          changedBlocks: [],
          removedBlocks: [],
        },
      },
    ], [0, 2]);

    expect(JSON.parse(json)[1]).toMatchObject({ mode: "delta", baseFrameIndex: 1 });
  });
});

function block(id: string, text: string, x: number, y: number) {
  return {
    id,
    text,
    boundingBox: { x, y, width: 100, height: 20 },
    words: [{ text, boundingBox: { x, y, width: 100, height: 20 } }],
  };
}
