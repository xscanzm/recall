import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BatchCaptureBundle, CaptureBundle } from "../models/types";
import { CaptureBatcher } from "./CaptureBatcher";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CaptureBatcher OCR and compression", () => {
  it("exposes pending original paths so cache cleanup cannot race OCR", () => {
    const pending = {
      captureId: "capture-protected",
      capturedAt: new Date(0).toISOString(),
      timezone: "UTC",
      appName: "Recall Test",
      windowTitle: "Protected",
      captureReason: "manual_capture" as const,
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: ["C:\\cache\\capture.png"],
      stitchedImagePath: "C:\\cache\\stitched.png",
      retentionPolicy: "delete_immediately" as const,
    };
    let pendingReads = 0;
    const batcher = new CaptureBatcher({
      repository: {
        listPendingCaptures: () => pendingReads++ === 0 ? [] : [pending],
        enqueueCapture: () => true,
        createBatch: () => true,
      } as never,
      ocrFrameProcessor: {
        prepareBatch: async () => ({ results: [], commit: () => undefined }),
      },
    });

    expect(batcher.getPendingImagePaths()).toEqual([
      "C:\\cache\\stitched.png",
      "C:\\cache\\capture.png",
    ]);
    batcher.stop();
  });

  it("drains every queued frame and stops accepting new captures", async () => {
    const batchSizes: number[] = [];
    const repository = {
      listPendingCaptures: () => [],
      enqueueCapture: () => true,
      createBatch: (batch: BatchCaptureBundle) => {
        batchSizes.push(batch.frames.length);
        return true;
      },
    };
    const batcher = new CaptureBatcher({
      repository: repository as never,
      ocrFrameProcessor: {
        prepareBatch: async (frames) => ({
          results: frames.map((_, index) => ({
            frameIndex: index + 1,
            text: "",
            lines: [],
            blocks: [],
          })),
          commit: () => undefined,
        }),
      },
    });
    const makeFrame = (index: number): CaptureBundle => ({
      captureId: `capture-${index}`,
      capturedAt: new Date(index * 1000).toISOString(),
      timezone: "UTC",
      appName: "Recall Test",
      windowTitle: "Drain Test",
      captureReason: "manual_capture",
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: [],
      retentionPolicy: "today",
    });

    for (let index = 0; index < 7; index += 1) batcher.add(makeFrame(index));
    await batcher.drain();

    expect(batchSizes).toEqual([6, 1]);
    expect(batcher.add(makeFrame(8))).toBe(false);
  });

  it("lets the idle timer slide with new frames instead of cutting a nearly-full batch", async () => {
    vi.useFakeTimers();
    try {
      const batchSizes: number[] = [];
      const batcher = new CaptureBatcher({
        repository: {
          listPendingCaptures: () => [],
          enqueueCapture: () => true,
          createBatch: (batch: BatchCaptureBundle) => {
            batchSizes.push(batch.frames.length);
            return true;
          },
        } as never,
        ocrFrameProcessor: {
          prepareBatch: async () => ({ results: [], commit: () => undefined }),
        },
      });
      const frame = (index: number): CaptureBundle => ({
        captureId: `capture-${index}`,
        capturedAt: new Date(index * 70_000).toISOString(),
        timezone: "UTC",
        appName: "Recall Test",
        windowTitle: "Idle Test",
        captureReason: "manual_capture",
        activitySignals: {
          keyboardActive: false, mouseActive: false, idleSeconds: 0, activeWindowStableSeconds: 60,
        },
        imagePaths: [],
        retentionPolicy: "today",
      });

      // 真实节奏约 70 秒一帧：攒满 6 帧要 350 秒，旧的固定 5 分钟定时器会中途切一刀。
      for (let index = 0; index < 6; index += 1) {
        batcher.add(frame(index));
        await vi.advanceTimersByTimeAsync(70_000);
      }
      expect(batchSizes).toEqual([6]);

      // 活动停下来之后，残批才由空闲兜底提交。
      batcher.add(frame(6));
      await vi.advanceTimersByTimeAsync(140_000);
      expect(batchSizes).toEqual([6]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(batchSizes).toEqual([6, 1]);
      batcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps the fallback by batch age when frames keep trickling in", async () => {
    vi.useFakeTimers();
    try {
      const batchSizes: number[] = [];
      const batcher = new CaptureBatcher({
        repository: {
          listPendingCaptures: () => [],
          enqueueCapture: () => true,
          createBatch: (batch: BatchCaptureBundle) => {
            batchSizes.push(batch.frames.length);
            return true;
          },
        } as never,
        ocrFrameProcessor: {
          prepareBatch: async () => ({ results: [], commit: () => undefined }),
        },
      });
      const frame = (index: number): CaptureBundle => ({
        captureId: `capture-${index}`,
        capturedAt: new Date(index * 120_000).toISOString(),
        timezone: "UTC",
        appName: "Recall Test",
        windowTitle: "Age Cap",
        captureReason: "manual_capture",
        activitySignals: {
          keyboardActive: false, mouseActive: false, idleSeconds: 0, activeWindowStableSeconds: 60,
        },
        imagePaths: [],
        retentionPolicy: "today",
      });

      // 每 120 秒一帧，空闲定时器永远被顺延；年龄上限必须在 10 分钟处兜住。
      for (let index = 0; index < 5; index += 1) {
        batcher.add(frame(index));
        await vi.advanceTimersByTimeAsync(120_000);
      }
      expect(batchSizes).toEqual([5]);
      batcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes the original image before persisting an optimized JPEG", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-capture-batcher-"));
    tempDirs.push(tempDir);
    const sourcePath = path.join(tempDir, "original.png");
    const compressedDir = path.join(tempDir, "compressed");
    await sharp({
      create: {
        width: 1_200,
        height: 600,
        channels: 3,
        background: { r: 244, g: 248, b: 252 },
      },
    }).png().toFile(sourcePath);

    let storedBundle: BatchCaptureBundle | null = null;
    const repository = {
      listPendingCaptures: vi.fn(() => []),
      enqueueCapture: vi.fn(() => true),
      createBatch: vi.fn((bundle: BatchCaptureBundle) => {
        storedBundle = bundle;
        return true;
      }),
    };
    const recognizeImages = vi.fn(async (imagePaths: string[]) => ({
      available: true,
      frames: imagePaths.map((_, index) => ({
        frameIndex: index + 1,
        text: "未压缩原图 OCR",
        lines: ["未压缩原图 OCR"],
        language: "zh-Hans-CN",
      })),
    }));
    const batcher = new CaptureBatcher({
      repository: repository as never,
      compressedDir,
      ocrService: { recognizeImages },
    });
    const frame: CaptureBundle = {
      captureId: "capture-1",
      capturedAt: "2026-07-16T00:00:00.000Z",
      timezone: "Asia/Shanghai",
      appName: "Recall Test",
      windowTitle: "OCR Test",
      captureReason: "manual_capture",
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: [sourcePath],
      retentionPolicy: "today",
    };

    batcher.add(frame);
    await batcher.flush();
    batcher.stop();

    expect(recognizeImages).toHaveBeenCalledWith([sourcePath]);
    expect(storedBundle).not.toBeNull();
    const bundle = storedBundle as unknown as BatchCaptureBundle;
    expect(bundle.ocrResults).toHaveLength(1);
    expect(bundle.ocrResults?.[0]).toMatchObject({
      frameIndex: 1,
      text: "未压缩原图 OCR",
      lines: ["未压缩原图 OCR"],
      language: "zh-Hans-CN",
      mode: "full",
    });
    expect(bundle.compressedImagePaths).toHaveLength(1);
    const metadata = await sharp(bundle.compressedImagePaths[0]).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(800);
    expect(metadata.chromaSubsampling).toBe("4:2:0");
  });

  it("continues batching when OCR throws unexpectedly", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-capture-batcher-"));
    tempDirs.push(tempDir);
    const sourcePath = path.join(tempDir, "original.png");
    await sharp({
      create: {
        width: 900,
        height: 500,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).png().toFile(sourcePath);
    let storedBundle: BatchCaptureBundle | null = null;
    const repository = {
      listPendingCaptures: () => [],
      enqueueCapture: () => true,
      createBatch: (bundle: BatchCaptureBundle) => {
        storedBundle = bundle;
        return true;
      },
    };
    const batcher = new CaptureBatcher({
      repository: repository as never,
      compressedDir: path.join(tempDir, "compressed"),
      ocrService: { recognizeImages: async () => { throw new Error("OCR unavailable"); } },
    });

    batcher.add({
      captureId: "capture-2",
      capturedAt: "2026-07-16T00:01:00.000Z",
      timezone: "Asia/Shanghai",
      appName: "Recall Test",
      windowTitle: "OCR Failure Test",
      captureReason: "manual_capture",
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: [sourcePath],
      retentionPolicy: "today",
    });
    await batcher.flush();
    batcher.stop();

    expect(storedBundle).not.toBeNull();
    const bundle = storedBundle as unknown as BatchCaptureBundle;
    expect(bundle.ocrResults?.[0]).toMatchObject({
      frameIndex: 1,
      text: "",
      errorCode: "local_ocr_unhandled_error",
    });
    expect(fs.existsSync(bundle.compressedImagePaths[0])).toBe(true);
  });

  it("commits staged OCR state only after the durable batch insert succeeds", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-capture-batcher-"));
    tempDirs.push(tempDir);
    const sourcePath = path.join(tempDir, "original.png");
    await sharp({
      create: {
        width: 900,
        height: 500,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    }).png().toFile(sourcePath);
    const commit = vi.fn();
    const prepareBatch = vi.fn(async () => ({
      results: [{ frameIndex: 1, text: "durable", lines: ["durable"], mode: "full" as const }],
      commit,
    }));
    const repository = {
      listPendingCaptures: () => [],
      enqueueCapture: () => true,
      createBatch: () => false,
    };
    const batcher = new CaptureBatcher({
      repository: repository as never,
      compressedDir: path.join(tempDir, "compressed"),
      ocrFrameProcessor: { prepareBatch },
    });

    batcher.add({
      captureId: "capture-not-inserted",
      capturedAt: "2026-07-16T00:02:00.000Z",
      timezone: "Asia/Shanghai",
      appName: "Recall Test",
      windowTitle: "Durability Test",
      captureReason: "manual_capture",
      activitySignals: {
        keyboardActive: false,
        mouseActive: false,
        idleSeconds: 0,
        activeWindowStableSeconds: 60,
      },
      imagePaths: [sourcePath],
      retentionPolicy: "today",
    });
    await batcher.flush();
    batcher.stop();

    expect(prepareBatch).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });
});
