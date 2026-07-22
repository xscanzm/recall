import { describe, expect, it } from "vitest";
import type { BatchCaptureBundle, ObserverOutputV2 } from "../models/types";
import {
  buildObserverBatchFramePlan,
  expandObserverObservations,
} from "./ObserverBatchFrames";

describe("ObserverBatchFrames", () => {
  it("omits only exact in-batch duplicates and expands model output back to every frame", () => {
    const bundle = batch([
      { mode: "full" },
      { mode: "exact_reuse", reuseFromFrameIndex: 1 },
      { mode: "delta", deltaFromFrameIndex: 2 },
    ]);

    const plan = buildObserverBatchFramePlan(bundle);

    expect(plan.submittedFrames.map((frame) => frame.originalFrameIndex)).toEqual([0, 2]);
    const expanded = expandObserverObservations([
      observation(1, "first"),
      observation(2, "third"),
    ], plan);
    expect(expanded.map((item) => [item.frameIndex, item.sceneSummary])).toEqual([
      [1, "first"],
      [2, "first"],
      [3, "third"],
    ]);
    expect(expanded[1]).not.toBe(expanded[0]);
  });

  it("keeps cross-batch OCR reuse submitted because no model observation is available", () => {
    const bundle = batch([{ mode: "exact_reuse", reusedFromCaptureId: "old-capture" }]);

    const plan = buildObserverBatchFramePlan(bundle);

    expect(plan.submittedFrames).toHaveLength(1);
    expect(plan.duplicateSourceByOriginalFrameIndex.size).toBe(0);
  });

  it("does not use an unavailable compressed source frame for duplicate expansion", () => {
    const bundle = batch([
      { mode: "full" },
      { mode: "exact_reuse", reuseFromFrameIndex: 1 },
    ]);
    bundle.compressedImagePaths[0] = "";

    const plan = buildObserverBatchFramePlan(bundle);

    expect(plan.submittedFrames.map((frame) => frame.originalFrameIndex)).toEqual([1]);
  });

  it("submits near-identical frames even when OCR sees no text changes", () => {
    const bundle = batch([
      { mode: "full" },
      { mode: "delta", deltaFromFrameIndex: 1 },
    ]);
    bundle.ocrResults![0].screenSignature = signature("0000000000000000");
    bundle.ocrResults![1].screenSignature = signature("0000000000000003");
    bundle.ocrResults![1].delta = {
      unchangedBlockIds: ["same"],
      addedBlocks: [],
      changedBlocks: [],
      removedBlocks: [],
    };

    const plan = buildObserverBatchFramePlan(bundle);

    expect(plan.submittedFrames.map((frame) => frame.originalFrameIndex)).toEqual([0, 1]);
    expect(plan.duplicateSourceByOriginalFrameIndex.size).toBe(0);
  });

  it("preserves boundary frames and visually different frames", () => {
    const manual = batch([
      { mode: "full" },
      { mode: "delta", deltaFromFrameIndex: 1 },
    ]);
    manual.frames[1].captureReason = "manual_capture";
    manual.ocrResults![0].screenSignature = signature("0000000000000000");
    manual.ocrResults![1].screenSignature = signature("0000000000000001");
    manual.ocrResults![1].delta = emptyDelta();

    const changed = batch([
      { mode: "full" },
      { mode: "delta", deltaFromFrameIndex: 1 },
    ]);
    changed.ocrResults![0].screenSignature = signature("0000000000000000");
    changed.ocrResults![1].screenSignature = signature("000000000000000f");
    changed.ocrResults![1].delta = emptyDelta();

    expect(buildObserverBatchFramePlan(manual).submittedFrames).toHaveLength(2);
    expect(buildObserverBatchFramePlan(changed).submittedFrames).toHaveLength(2);
  });
});

function signature(dHash: string) {
  return { pixelHash: dHash, dHash, width: 100, height: 100 };
}

function emptyDelta() {
  return { unchangedBlockIds: [], addedBlocks: [], changedBlocks: [], removedBlocks: [] };
}

function batch(
  modes: Array<{ mode: "full" | "exact_reuse" | "delta"; reuseFromFrameIndex?: number; deltaFromFrameIndex?: number; reusedFromCaptureId?: string }>
): BatchCaptureBundle {
  return {
    batchId: "batch",
    frames: modes.map((_mode, index) => ({
      captureId: `capture-${index + 1}`,
      capturedAt: `2026-07-16T00:00:0${index}.000Z`,
      timezone: "Asia/Shanghai",
      appName: "Recall",
      windowTitle: "Window",
      captureReason: "content_changed",
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: [`original-${index + 1}.png`],
      retentionPolicy: "today",
    })),
    capturedAtStart: "2026-07-16T00:00:00.000Z",
    capturedAtEnd: "2026-07-16T00:00:02.000Z",
    timezone: "Asia/Shanghai",
    appName: "Recall",
    windowTitle: "Window",
    captureReason: "batch_flush",
    imagePaths: modes.map((_mode, index) => `original-${index + 1}.png`),
    compressedImagePaths: modes.map((_mode, index) => `compressed-${index + 1}.jpg`),
    ocrResults: modes.map((mode, index) => ({
      frameIndex: index + 1,
      text: `text ${index + 1}`,
      lines: [`text ${index + 1}`],
      ...mode,
    })),
    retentionPolicy: "today",
  };
}

function observation(frameIndex: number, sceneSummary: string): ObserverOutputV2 {
  return {
    frameIndex,
    sceneSummary,
    userFacingSummary: sceneSummary,
    likelyWorkPurpose: "test",
    visibleContent: [{ type: "document", summary: sceneSummary, fullText: sceneSummary, keyTextSnippets: [] }],
    detectedEntities: [],
    possibleUserIntent: "",
    possibleTasks: [],
    possibleDecisions: [],
    possibleProjectProgress: [],
    privacyRisk: "low",
    privacyRiskReason: "",
    reportableSignal: "no",
    reportableReason: "",
    sensitivity: "normal",
    confidence: 1,
    uncertainties: [],
  };
}
