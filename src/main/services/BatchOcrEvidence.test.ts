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
    const stableBlocks = Array.from(
      { length: 20 },
      (_, index) => block(`stable-${index}`, `Stable ${index}`, 10, 10 + index * 24)
    );
    const changedBlock = block("changed", "After", 10, 40);
    const firstText = [...stableBlocks, block("before", "Before", 10, 600)]
      .map((item) => item.text).join("\n");
    const secondText = [...stableBlocks, changedBlock]
      .map((item) => item.text).join("\n");
    const json = buildBatchOcrEvidenceJson([
      {
        frameIndex: 1,
        text: firstText,
        lines: firstText.split("\n"),
        blocks: [...stableBlocks, block("before", "Before", 10, 600)],
        mode: "full",
      },
      {
        frameIndex: 2,
        text: secondText,
        lines: secondText.split("\n"),
        blocks: [...stableBlocks, changedBlock],
        mode: "delta",
        deltaFromFrameIndex: 1,
        delta: {
          unchangedBlockIds: stableBlocks.map((item) => item.id),
          addedBlocks: [],
          changedBlocks: [{ previousBlockId: "before", block: changedBlock }],
          removedBlocks: [],
        },
      },
      {
        frameIndex: 3,
        text: secondText,
        lines: secondText.split("\n"),
        blocks: [...stableBlocks, changedBlock],
        mode: "delta",
        deltaFromFrameIndex: 2,
        delta: {
          unchangedBlockIds: [...stableBlocks, changedBlock].map((item) => item.id),
          addedBlocks: [],
          changedBlocks: [],
          removedBlocks: [],
        },
      },
    ], [0, 1, 2]);

    const parsed = JSON.parse(json);
    expect(parsed[0]).toMatchObject({
      frameIndex: 1,
      mode: "full",
    });
    expect(parsed[0].blocks).toHaveLength(21);
    expect(parsed[0].blocks[0]).toEqual(["stable-0", "Stable 0"]);
    expect(parsed[1]).toEqual({
      frameIndex: 2,
      source: "windows_ocr_original_image",
      available: true,
      mode: "delta",
      baseFrameIndex: 1,
      unchangedBlockCount: 20,
      addedBlocks: [],
      changedBlocks: [["before", ["changed", "After"]]],
      removedBlockIds: [],
    });
  });

  it("resolves a delta base through an omitted exact duplicate frame", () => {
    const baseline = Array.from(
      { length: 20 },
      (_, index) => block(`base-${index}`, `Base ${index}`, 0, index * 20)
    );
    const added = block("next", "next", 0, 500);
    const baselineText = baseline.map((item) => item.text).join("\n");
    const currentText = [...baseline, added].map((item) => item.text).join("\n");
    const json = buildBatchOcrEvidenceJson([
      { frameIndex: 1, text: baselineText, lines: baselineText.split("\n"), blocks: baseline, mode: "full" },
      { frameIndex: 2, text: baselineText, lines: baselineText.split("\n"), blocks: baseline, mode: "exact_reuse", reuseFromFrameIndex: 1 },
      {
        frameIndex: 3,
        text: currentText,
        lines: currentText.split("\n"),
        blocks: [...baseline, added],
        mode: "delta",
        deltaFromFrameIndex: 2,
        delta: {
          unchangedBlockIds: baseline.map((item) => item.id),
          addedBlocks: [added],
          changedBlocks: [],
          removedBlocks: [],
        },
      },
    ], [0, 2]);

    expect(JSON.parse(json)[1]).toMatchObject({ mode: "delta", baseFrameIndex: 1 });
  });

  it("falls back to a full structured frame when a large delta costs more bytes", () => {
    const previous = Array.from({ length: 20 }, (_, index) => block(`old-${index}`, `Old ${index}`, 0, index * 20));
    const current = Array.from({ length: 20 }, (_, index) => block(`new-${index}`, `New ${index}`, 0, index * 20));
    const json = buildBatchOcrEvidenceJson([
      { frameIndex: 1, text: "old", lines: ["old"], blocks: previous, mode: "full" },
      {
        frameIndex: 2,
        text: "new",
        lines: ["new"],
        blocks: current,
        mode: "delta",
        deltaFromFrameIndex: 1,
        delta: {
          unchangedBlockIds: [],
          addedBlocks: [],
          changedBlocks: current.map((item, index) => ({ previousBlockId: `old-${index}`, block: item })),
          removedBlocks: [],
        },
      },
    ], [0, 1]);

    expect(JSON.parse(json)[1]).toMatchObject({ mode: "full_text", text: "new" });
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
