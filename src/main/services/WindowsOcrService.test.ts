import { describe, expect, it, vi } from "vitest";
import { WindowsOcrService } from "./WindowsOcrService";

describe("WindowsOcrService", () => {
  it("returns frame-aligned OCR evidence", async () => {
    const runPowerShell = vi.fn(async () => JSON.stringify({
      available: true,
      language: "zh-Hans-CN",
      results: [
        { frameIndex: 2, text: "第二帧", lines: ["第二帧"] },
        { frameIndex: 1, text: "First frame", lines: ["First frame"] },
      ],
    }));
    const service = new WindowsOcrService({ platform: "win32", runPowerShell });

    const result = await service.recognizeImages(["first.png", "second.png"]);

    expect(result.available).toBe(true);
    expect(result.frames).toEqual([
      {
        frameIndex: 1,
        text: "First frame",
        lines: ["First frame"],
        blocks: undefined,
        language: "zh-Hans-CN",
        engine: "windows_ocr",
        errorCode: undefined,
      },
      {
        frameIndex: 2,
        text: "第二帧",
        lines: ["第二帧"],
        blocks: undefined,
        language: "zh-Hans-CN",
        engine: "windows_ocr",
        errorCode: undefined,
      },
    ]);
    expect(runPowerShell).toHaveBeenCalledWith(["first.png", "second.png"], 90_000);
  });

  it("keeps missing frame results aligned instead of shifting later frames", async () => {
    const service = new WindowsOcrService({
      platform: "win32",
      runPowerShell: async () => JSON.stringify({
        available: true,
        language: "en-US",
        results: [{ frameIndex: 2, text: "second", lines: ["second"] }],
      }),
    });

    const result = await service.recognizeImages(["first.png", "second.png"]);

    expect(result.frames[0]).toMatchObject({
      frameIndex: 1,
      text: "",
      errorCode: "windows_ocr_missing_result",
    });
    expect(result.frames[1]).toMatchObject({ frameIndex: 2, text: "second" });
  });

  it("parses line and word bounding boxes without inventing confidence", async () => {
    const service = new WindowsOcrService({
      platform: "win32",
      runPowerShell: async () => JSON.stringify({
        available: true,
        language: "zh-Hans-CN",
        results: [{
          frameIndex: 1,
          text: "完整一行",
          lines: ["完整一行"],
          blocks: [{
            id: "line_1",
            text: "完整一行",
            boundingBox: { x: 10, y: 20, width: 80, height: 18 },
            words: [
              { text: "完整", boundingBox: { x: 10, y: 20, width: 38, height: 18 } },
              { text: "一行", boundingBox: { x: 52, y: 20, width: 38, height: 18 } },
            ],
          }],
        }],
      }),
    });

    const result = await service.recognizeImages(["frame.png"]);

    expect(result.frames[0].blocks).toEqual([{
      id: "line_1",
      text: "完整一行",
      boundingBox: { x: 10, y: 20, width: 80, height: 18 },
      words: [
        { text: "完整", boundingBox: { x: 10, y: 20, width: 38, height: 18 }, confidence: undefined },
        { text: "一行", boundingBox: { x: 52, y: 20, width: 38, height: 18 }, confidence: undefined },
      ],
      confidence: undefined,
    }]);
  });

  it("drops malformed blocks while preserving the frame text", async () => {
    const service = new WindowsOcrService({
      platform: "win32",
      runPowerShell: async () => JSON.stringify({
        available: true,
        results: [{
          frameIndex: 1,
          text: "text survives",
          lines: ["text survives"],
          blocks: [{ text: "bad", boundingBox: { x: 0, y: 0, width: -1, height: 2 } }],
        }],
      }),
    });

    const result = await service.recognizeImages(["frame.png"]);

    expect(result.frames[0]).toMatchObject({ text: "text survives", blocks: [] });
  });

  it("degrades cleanly when PowerShell output is invalid", async () => {
    const service = new WindowsOcrService({
      platform: "win32",
      runPowerShell: async () => "not-json",
    });

    const result = await service.recognizeImages(["frame.png"]);

    expect(result.available).toBe(false);
    expect(result.errorCode).toBe("windows_ocr_invalid_output");
    expect(result.frames[0]).toMatchObject({ text: "", lines: [] });
  });

  it("does not start PowerShell on unsupported platforms", async () => {
    const runPowerShell = vi.fn(async () => "");
    const service = new WindowsOcrService({ platform: "linux", runPowerShell });

    const result = await service.recognizeImages(["frame.png"]);

    expect(runPowerShell).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      available: false,
      errorCode: "windows_ocr_unsupported_platform",
    });
  });

  it("turns process failures into non-fatal empty evidence", async () => {
    const service = new WindowsOcrService({
      platform: "win32",
      runPowerShell: async () => {
        throw new Error("spawn failed");
      },
    });

    await expect(service.recognizeImages(["frame.png"])).resolves.toMatchObject({
      available: false,
      errorCode: "windows_ocr_process_failed",
      frames: [{ frameIndex: 1, text: "", lines: [] }],
    });
  });
});
