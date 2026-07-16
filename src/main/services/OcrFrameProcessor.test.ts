import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureBundle, OcrTextBlock } from "../models/types";
import { OcrFrameProcessor, diffBlocks } from "./OcrFrameProcessor";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OcrFrameProcessor", () => {
  it("runs OCR once and reuses an exact decoded-pixel duplicate in the same batch", async () => {
    const imagePath = await createImage({ r: 255, g: 255, b: 255 });
    const recognizeImages = vi.fn(async (paths: string[]) => ({
      available: true,
      frames: paths.map((_imagePath, index) => ocrFrame(index + 1, "same text")),
    }));
    const processor = new OcrFrameProcessor({ ocrService: { recognizeImages } });

    const prepared = await processor.prepareBatch([
      frame("capture-1", imagePath),
      frame("capture-2", imagePath),
    ]);

    expect(recognizeImages).toHaveBeenCalledWith([imagePath]);
    expect(prepared.results[0].mode).toBe("full");
    expect(prepared.results[1]).toMatchObject({
      mode: "exact_reuse",
      reuseFromFrameIndex: 1,
      text: "same text",
    });
  });

  it("does not skip OCR for a near duplicate and reports a spatial text change", async () => {
    const firstPath = await createImage({ r: 250, g: 250, b: 250 });
    const secondPath = await createImage({ r: 249, g: 250, b: 250 });
    const recognizeImages = vi.fn(async (paths: string[]) => ({
      available: true,
      frames: paths.map((_imagePath, index) => ocrFrame(index + 1, index === 0 ? "before" : "after")),
    }));
    const processor = new OcrFrameProcessor({ ocrService: { recognizeImages } });

    const prepared = await processor.prepareBatch([
      frame("capture-1", firstPath),
      frame("capture-2", secondPath),
    ]);

    expect(recognizeImages).toHaveBeenCalledWith([firstPath, secondPath]);
    expect(prepared.results[1].mode).toBe("delta");
    expect(prepared.results[1].delta?.changedBlocks).toHaveLength(1);
    expect(prepared.results[1].delta?.unchangedBlockIds).toHaveLength(0);
  });

  it("does not expose staged reuse until commit is called", async () => {
    const imagePath = await createImage({ r: 240, g: 240, b: 240 });
    const recognizeImages = vi.fn(async (paths: string[]) => ({
      available: true,
      frames: paths.map((_imagePath, index) => ocrFrame(index + 1, "durable")),
    }));
    const processor = new OcrFrameProcessor({ ocrService: { recognizeImages } });

    await processor.prepareBatch([frame("capture-1", imagePath)]);
    const second = await processor.prepareBatch([frame("capture-2", imagePath)]);
    expect(second.results[0].mode).toBe("full");

    second.commit();
    const third = await processor.prepareBatch([frame("capture-3", imagePath)]);
    expect(third.results[0]).toMatchObject({
      mode: "exact_reuse",
      reusedFromCaptureId: "capture-2",
    });
    expect(recognizeImages).toHaveBeenCalledTimes(2);
  });

  it("bounds committed contexts", async () => {
    const firstPath = await createImage({ r: 220, g: 220, b: 220 });
    const secondPath = await createImage({ r: 221, g: 221, b: 221 });
    const recognizeImages = vi.fn(async (paths: string[]) => ({
      available: true,
      frames: paths.map((_imagePath, index) => ocrFrame(index + 1, "text")),
    }));
    const processor = new OcrFrameProcessor({
      ocrService: { recognizeImages },
      maxContexts: 1,
    });

    const first = await processor.prepareBatch([frame("one", firstPath, "App One")]);
    first.commit();
    const second = await processor.prepareBatch([frame("two", secondPath, "App Two")]);
    second.commit();

    expect(processor.getCommittedContextCount()).toBe(1);
  });
});

describe("diffBlocks", () => {
  it("keeps identical spatial text, changes replaced text, and preserves uncertain additions", () => {
    const previous = [
      block("stable", "Stable", 10, 10),
      block("change", "Before", 10, 40),
      block("removed", "Removed", 10, 70),
    ];
    const current = [
      block("new-stable", "Stable", 10, 10),
      block("new-change", "After", 10, 40),
      block("added", "Added", 300, 300),
    ];

    const delta = diffBlocks(previous, current);

    expect(delta.unchangedBlockIds).toEqual(["stable"]);
    expect(delta.changedBlocks).toEqual([{ previousBlockId: "change", block: current[1] }]);
    expect(delta.addedBlocks).toEqual([current[2]]);
    expect(delta.removedBlocks.map((item) => item.id)).toEqual(["removed"]);
  });
});

function frame(captureId: string, imagePath: string, appName = "Recall Test"): CaptureBundle {
  return {
    captureId,
    capturedAt: "2026-07-16T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    appName,
    windowTitle: "OCR Window",
    captureReason: "content_changed",
    activitySignals: {
      keyboardActive: false,
      mouseActive: false,
      idleSeconds: 0,
      activeWindowStableSeconds: 60,
    },
    imagePaths: [imagePath],
    retentionPolicy: "today",
  };
}

function ocrFrame(frameIndex: number, text: string) {
  return {
    frameIndex,
    text,
    lines: [text],
    language: "en-US",
    blocks: [block("line_1", text, 10, 10)],
  };
}

function block(id: string, text: string, x: number, y: number): OcrTextBlock {
  return {
    id,
    text,
    boundingBox: { x, y, width: 100, height: 20 },
    words: [{ text, boundingBox: { x, y, width: 100, height: 20 } }],
  };
}

async function createImage(background: { r: number; g: number; b: number }): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-ocr-frame-"));
  tempDirs.push(dir);
  const imagePath = path.join(dir, "frame.png");
  await sharp({
    create: { width: 320, height: 180, channels: 3, background },
  }).png().toFile(imagePath);
  return imagePath;
}
