import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  analyzeCaptureVisualQuality,
  calculateScreenCrop,
  findMatchingWindowSource,
  shouldUseScreenCropFallback,
} from "./CaptureService";

const sources = [
  { id: "window:41:0", name: "Recall - Notes" },
  { id: "window:42:0", name: "Recall - Notes" },
  { id: "window:43:0", name: " Recall - Notes " },
];

describe("findMatchingWindowSource", () => {
  it("requires both the native window id and the exact trimmed title", () => {
    expect(findMatchingWindowSource(sources, { windowId: 42, windowTitle: "Recall - Notes" }))
      .toBe(sources[1]);
    expect(findMatchingWindowSource(sources, { windowId: 42, windowTitle: "Other" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowId: 99, windowTitle: "Recall - Notes" })).toBeUndefined();
  });

  it("never falls back to a partial, case-insensitive, or empty title match", () => {
    expect(findMatchingWindowSource(sources, { windowTitle: "Recall" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowTitle: "recall - notes" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowTitle: "   " })).toBeUndefined();
  });
});

describe("capture quality fallback", () => {
  it("detects a pure black WPS-style frame as degenerate", async () => {
    const quality = await analyzeCaptureVisualQuality(await solidPng("#000000"));

    expect(quality.nearBlackRatio).toBe(1);
    expect(quality.isDegenerate).toBe(true);
  });

  it("still detects a black frame with one small UI overlay", async () => {
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#000000" },
    })
      .composite([{
        input: Buffer.from('<svg width="100" height="30"><rect width="100" height="30" fill="white"/><text x="8" y="20" font-size="12">SUM</text></svg>'),
        left: 320,
        top: 280,
      }])
      .png()
      .toBuffer();
    const quality = await analyzeCaptureVisualQuality(image);

    expect(quality.nearBlackRatio).toBeGreaterThan(0.99);
    expect(quality.isDegenerate).toBe(true);
  });

  it("selects a materially richer screen crop but not another black image", async () => {
    const blackQuality = await analyzeCaptureVisualQuality(await solidPng("#000000"));
    const worksheetQuality = await analyzeCaptureVisualQuality(await worksheetPng());

    expect(worksheetQuality.isDegenerate).toBe(false);
    expect(shouldUseScreenCropFallback(blackQuality, worksheetQuality)).toBe(true);
    expect(shouldUseScreenCropFallback(blackQuality, blackQuality)).toBe(false);
  });
});

describe("calculateScreenCrop", () => {
  it("maps display-independent window bounds to a 150% screen thumbnail", () => {
    expect(calculateScreenCrop(
      { x: 1360, y: 100, width: 800, height: 500 },
      { x: 1280, y: 0, width: 1280, height: 720 },
      { width: 1920, height: 1080 }
    )).toEqual({
      region: { left: 120, top: 150, width: 1200, height: 750 },
      coverage: 1,
    });
  });

  it("reports partial coverage so cross-display crops can be rejected", () => {
    const crop = calculateScreenCrop(
      { x: 1100, y: 100, width: 400, height: 500 },
      { x: 1280, y: 0, width: 1280, height: 720 },
      { width: 1920, height: 1080 }
    );

    expect(crop?.coverage).toBeCloseTo(0.55);
  });
});

async function solidPng(color: string): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 600, channels: 3, background: color },
  }).png().toBuffer();
}

async function worksheetPng(): Promise<Buffer> {
  const lines = Array.from({ length: 18 }, (_, index) =>
    `<line x1="0" y1="${index * 32}" x2="800" y2="${index * 32}" stroke="#b6bcc6"/>`
  ).join("");
  const columns = Array.from({ length: 12 }, (_, index) =>
    `<line x1="${index * 70}" y1="0" x2="${index * 70}" y2="600" stroke="#b6bcc6"/>`
  ).join("");
  return sharp(Buffer.from(
    `<svg width="800" height="600"><rect width="800" height="600" fill="#ffffff"/>${lines}${columns}<text x="80" y="80" font-size="24">WPS worksheet 123</text></svg>`
  )).png().toBuffer();
}
