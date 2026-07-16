import { describe, expect, it, vi } from "vitest";
import type { CaptureBundle, ObserverOutputV2 } from "../models/types";
import { ObservationNormalizer } from "./ObservationNormalizer";

describe("ObservationNormalizer local OCR evidence", () => {
  it("persists complete structured OCR evidence without replacing model fullText", () => {
    const create = vi.fn((input) => ({
      ...input,
      id: "obs-1",
      createdAt: "2026-07-16T00:00:00.000Z",
    }));
    const normalizer = new ObservationNormalizer({
      observationRepo: { create } as never,
    });

    normalizer.normalize({
      visionOutput: observation("模型校正后的完整文字"),
      captureBundle: capture(),
      ocrResult: {
        frameIndex: 1,
        text: "原始 OCR 全文",
        lines: ["原始 OCR 全文"],
        language: "zh-Hans-CN",
        mode: "delta",
        deltaFromFrameIndex: 1,
        blocks: [{
          id: "block-1",
          text: "原始 OCR 全文",
          boundingBox: { x: 10, y: 20, width: 120, height: 24 },
          words: [{
            text: "原始 OCR 全文",
            boundingBox: { x: 10, y: 20, width: 120, height: 24 },
          }],
        }],
        delta: {
          unchangedBlockIds: [],
          addedBlocks: [],
          changedBlocks: [],
          removedBlocks: [],
        },
      },
    });

    const visibleContent = create.mock.calls[0][0].visibleContent;
    expect(visibleContent[0].fullText).toBe("模型校正后的完整文字");
    expect(visibleContent[0].ocrEvidence).toMatchObject({
      source: "windows_ocr_original_image",
      text: "原始 OCR 全文",
      mode: "delta",
      blocks: [{ id: "block-1", text: "原始 OCR 全文" }],
    });
  });

  it("keeps old observations unchanged when a batch has no OCR result", () => {
    const create = vi.fn((input) => ({
      ...input,
      id: "obs-2",
      createdAt: "2026-07-16T00:00:00.000Z",
    }));
    const normalizer = new ObservationNormalizer({
      observationRepo: { create } as never,
    });

    normalizer.normalize({
      visionOutput: observation("legacy"),
      captureBundle: capture(),
    });

    expect(create.mock.calls[0][0].visibleContent).toEqual([
      { type: "document", summary: "summary", fullText: "legacy", keyTextSnippets: [] },
    ]);
  });
});

function observation(fullText: string): ObserverOutputV2 {
  return {
    sceneSummary: "summary",
    userFacingSummary: "summary",
    likelyWorkPurpose: "test",
    visibleContent: [{ type: "document", summary: "summary", fullText, keyTextSnippets: [] }],
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

function capture(): CaptureBundle {
  return {
    captureId: "capture-1",
    capturedAt: "2026-07-16T00:00:00.000Z",
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
    imagePaths: [],
    retentionPolicy: "today",
  };
}
