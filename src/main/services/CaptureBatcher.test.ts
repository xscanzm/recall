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
      errorCode: "windows_ocr_unhandled_error",
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
