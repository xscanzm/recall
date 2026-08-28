import { describe, expect, it } from "vitest";
import { buildOcrFallbackObservations } from "./OcrObservationBuilder";
import type { BatchCaptureBundle, BatchFrameOcrResult } from "../models/types";

function frame(overrides: Partial<BatchCaptureBundle["frames"][number]> = {}): BatchCaptureBundle["frames"][number] {
  return {
    captureId: "cap_test",
    capturedAt: "2026-08-28T10:00:00.000Z",
    timezone: "Asia/Shanghai",
    appName: "Google Chrome",
    windowTitle: "回声Recall 文档",
    captureReason: "content_changed",
    activitySignals: {
      keyboardActive: false,
      mouseActive: false,
      idleSeconds: 0,
      activeWindowStableSeconds: 0,
    },
    imagePaths: [],
    retentionPolicy: "today",
    ...overrides,
  };
}

function bundle(overrides: Partial<BatchCaptureBundle> = {}): BatchCaptureBundle {
  return {
    batchId: "batch_test",
    frames: [frame(), frame(), frame()],
    compressedImagePaths: ["a.png", "b.png", "c.png"],
    capturedAtStart: "2026-08-28T10:00:00.000Z",
    capturedAtEnd: "2026-08-28T10:03:00.000Z",
    timezone: "Asia/Shanghai",
    appName: "Google Chrome",
    windowTitle: "回声Recall 文档",
    captureReason: "batch_flush",
    imagePaths: [],
    retentionPolicy: "today",
    ...overrides,
  };
}

describe("buildOcrFallbackObservations", () => {
  it("builds one observation per submitted frame with 1-based frameIndex", () => {
    const ocr: BatchFrameOcrResult[] = [
      { frameIndex: 1, text: "第一帧的屏幕文字\n第二行", lines: ["第一帧的屏幕文字", "第二行"], engine: "rapidocr", mode: "full" },
      { frameIndex: 2, text: "", lines: [], engine: "rapidocr", mode: "full" },
      { frameIndex: 3, text: "第三帧文字", lines: ["第三帧文字"], engine: "rapidocr", mode: "full" },
    ];
    const result = buildOcrFallbackObservations(bundle({ ocrResults: ocr }));
    expect(result.observations).toHaveLength(3);
    expect(result.emptyOcrFrames).toBe(1);
    expect(result.observations.map((o) => o.frameIndex)).toEqual([1, 2, 3]);
    expect(result.observations[0].visibleContent[0].fullText).toContain("第一帧的屏幕文字");
    expect(result.observations[1].confidence).toBeLessThan(result.observations[0].confidence);
    expect(result.observations[0].sceneSummary).toContain("回声Recall 文档");
    // ObserverOutputV2 不带 appName（落库时由 normalizer 附加）；索引访问避免把领域字段塞进 vision 输出契约
    expect((result.observations[0] as unknown as Record<string, unknown>).appName).toBeUndefined();
  });

  it("expands exact_reuse duplicate frames from their source observation", () => {
    const ocr: BatchFrameOcrResult[] = [
      { frameIndex: 1, text: "源帧文字", lines: ["源帧文字"], engine: "rapidocr", mode: "full" },
      { frameIndex: 2, text: "", lines: [], engine: "rapidocr", mode: "exact_reuse", reuseFromFrameIndex: 1 },
    ];
    const result = buildOcrFallbackObservations(
      bundle({
        frames: [frame(), frame({ captureId: "cap_test_2" })],
        compressedImagePaths: ["a.png", "b.png"],
        ocrResults: ocr,
      })
    );
    // 帧 2 是帧 1 的精确复用：不单独提交，扩展自帧 1 的 observation
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].visibleContent[0].fullText).toBe("源帧文字");
    expect(result.observations[1].visibleContent[0].fullText).toBe("源帧文字");
    expect(result.observations[1].frameIndex).toBe(2);
  });

  it("marks degraded semantics via uncertainties and conservative fields", () => {
    const result = buildOcrFallbackObservations(bundle({
      ocrResults: [{ frameIndex: 1, text: "some text", lines: ["some text"], engine: "rapidocr", mode: "full" }],
      compressedImagePaths: ["a.png"],
      frames: [frame()],
    }));
    const obs = result.observations[0];
    expect(obs.sensitivity).toBe("normal");
    expect(obs.privacyRisk).toBe("medium");
    expect(obs.detectedEntities).toEqual([]);
    expect(obs.possibleTasks).toEqual([]);
    expect(obs.uncertainties.join(" ")).toContain("降级");
  });
});
