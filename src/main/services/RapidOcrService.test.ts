import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OcrBatchService } from "./OcrService";
import { logger } from "./Logger";
import {
  calculateRapidOcrTimeoutMs,
  RapidOcrService,
} from "./RapidOcrService";

describe("RapidOcrService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses an initialization budget plus a per-frame budget with a hard cap", () => {
    expect(calculateRapidOcrTimeoutMs(1)).toBe(150_000);
    expect(calculateRapidOcrTimeoutMs(6)).toBe(300_000);
    expect(calculateRapidOcrTimeoutMs(20)).toBe(300_000);
  });

  it("keeps one worker alive and correlates frame-aligned JSONL responses", async () => {
    const worker = new FakeWorker((request) => ({
      id: request.id,
      available: true,
      engine: "rapidocr",
      model: "PP-OCRv6-small",
      engineVersion: "3.9.2",
      frames: request.imagePaths.map((_path: string, index: number) => ({
        frameIndex: index + 1,
        text: `frame ${index + 1}`,
        lines: [`frame ${index + 1}`],
        blocks: [],
        language: "multi",
      })),
    }));
    const spawnWorker = vi.fn(() => worker.asChildProcess());
    const service = new RapidOcrService({ spawnWorker });

    const first = await service.recognizeImages(["one.png", "two.png"]);
    const second = await service.recognizeImages(["three.png"]);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    expect(first.available).toBe(true);
    expect(first.frames.map((frame) => [frame.text, frame.engine, frame.model])).toEqual([
      ["frame 1", "rapidocr", "PP-OCRv6-small"],
      ["frame 2", "rapidocr", "PP-OCRv6-small"],
    ]);
    expect(second.frames[0].engineVersion).toBe("3.9.2");
  });

  it("falls back when RapidOCR reports that its runtime is unavailable", async () => {
    const worker = new FakeWorker((request) => ({
      id: request.id,
      available: false,
      errorCode: "rapidocr_import_failed",
      frames: [],
    }));
    const fallback = fallbackService("windows fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
    });

    const result = await service.recognizeImages(["frame.png"]);

    expect(result.frames[0].text).toBe("windows fallback");
    expect(fallback.recognizeImages).toHaveBeenCalledOnce();
  });

  it("falls back only failed RapidOCR frames and keeps successful frames", async () => {
    const worker = new FakeWorker((request) => ({
      id: request.id,
      available: true,
      engine: "rapidocr",
      frames: [
        { frameIndex: 1, text: "rapid", lines: ["rapid"], blocks: [] },
        { frameIndex: 2, text: "", lines: [], blocks: [], errorCode: "rapidocr_frame_failed" },
      ],
    }));
    const fallback = fallbackService("windows fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
    });

    const result = await service.recognizeImages(["one.png", "two.png"]);

    expect(fallback.recognizeImages).toHaveBeenCalledWith(["two.png"]);
    expect(result.frames.map((frame) => [frame.frameIndex, frame.text, frame.engine])).toEqual([
      [1, "rapid", "rapidocr"],
      [2, "windows fallback", "windows_ocr"],
    ]);
  });

  it("waits for complete while accumulating streamed frame responses", async () => {
    let requestId = "";
    let settled = false;
    const worker = new FakeWorker((request) => {
      requestId = request.id;
      return {
        id: request.id,
        type: "frame",
        available: true,
        engine: "rapidocr",
        model: "PP-OCRv6-small",
        engineVersion: "3.9.2",
        frame: { frameIndex: 1, text: "first", lines: ["first"], blocks: [] },
      };
    });
    const service = new RapidOcrService({ spawnWorker: () => worker.asChildProcess() });

    const resultPromise = service.recognizeImages(["one.png", "two.png"]);
    void resultPromise.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    worker.stdout.write(`${JSON.stringify({
      id: requestId,
      type: "frame",
      available: true,
      engine: "rapidocr",
      model: "PP-OCRv6-small",
      engineVersion: "3.9.2",
      frame: { frameIndex: 2, text: "second", lines: ["second"], blocks: [] },
    })}\n${JSON.stringify({ id: requestId, type: "complete", available: true })}\n`);

    const result = await resultPromise;
    expect(result.frames.map((frame) => frame.text)).toEqual(["first", "second"]);
  });

  it("restarts and falls back after malformed worker output", async () => {
    const log = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const worker = new FakeWorker(() => "not-json");
    const fallback = fallbackService("safe fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
    });

    const result = await service.recognizeImages(["frame.png"]);

    expect(result.frames[0].text).toBe("safe fallback");
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "rapidocr_invalid_output",
    }));
  });

  it("keeps streamed frames and falls back only missing frames after timeout", async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const worker = new FakeWorker((request) => ({
      id: request.id,
      type: "frame",
      available: true,
      engine: "rapidocr",
      frame: { frameIndex: 1, text: "rapid", lines: ["rapid"], blocks: [] },
    }));
    const fallback = fallbackService("timeout fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
      timeoutMs: 50,
    });

    const promise = service.recognizeImages(["one.png", "two.png"]);
    await vi.advanceTimersByTimeAsync(51);
    const result = await promise;

    expect(result.frames.map((frame) => frame.text)).toEqual(["rapid", "timeout fallback"]);
    expect(fallback.recognizeImages).toHaveBeenCalledWith(["two.png"]);
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "rapidocr_timeout",
      durationMs: 50,
    }));
  });

  it("keeps streamed frames and classifies an unexpected worker exit", async () => {
    const log = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    // 回调里要引用 worker 自身。用 holder 绕开"声明前引用"：
    // 回调只在 new 返回之后才被触发，此时 holder.current 已赋值。
    const holder: { current: FakeWorker | null } = { current: null };
    const worker = new FakeWorker((request) => {
      setTimeout(() => holder.current?.emit("close", 9, null), 0);
      return {
        id: request.id,
        type: "frame",
        available: true,
        engine: "rapidocr",
        frame: { frameIndex: 1, text: "rapid", lines: ["rapid"], blocks: [] },
      };
    });
    holder.current = worker;
    const fallback = fallbackService("crash fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
    });

    const result = await service.recognizeImages(["one.png", "two.png"]);

    expect(result.frames.map((frame) => frame.text)).toEqual(["rapid", "crash fallback"]);
    expect(fallback.recognizeImages).toHaveBeenCalledWith(["two.png"]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "rapidocr_worker_crashed",
    }));
  });

  it("keeps streamed frames before invalid output and falls back only missing frames", async () => {
    const worker = new FakeWorker((request) => [
      {
        id: request.id,
        type: "frame",
        available: true,
        engine: "rapidocr",
        frame: { frameIndex: 1, text: "rapid", lines: ["rapid"], blocks: [] },
      },
      "not-json",
    ]);
    const fallback = fallbackService("invalid fallback");
    const service = new RapidOcrService({
      spawnWorker: () => worker.asChildProcess(),
      fallback,
    });

    const result = await service.recognizeImages(["one.png", "two.png"]);

    expect(result.frames.map((frame) => frame.text)).toEqual(["rapid", "invalid fallback"]);
    expect(fallback.recognizeImages).toHaveBeenCalledWith(["two.png"]);
  });

  it("stops the persistent worker explicitly", async () => {
    const worker = new FakeWorker(() => undefined);
    const service = new RapidOcrService({ spawnWorker: () => worker.asChildProcess() });
    void service.recognizeImages(["frame.png"]);
    await new Promise((resolve) => setImmediate(resolve));

    await service.stop();

    expect(worker.kill).toHaveBeenCalledOnce();
  });
});

function fallbackService(text: string): OcrBatchService & {
  recognizeImages: ReturnType<typeof vi.fn>;
} {
  return {
    recognizeImages: vi.fn(async (paths: string[]) => ({
      available: true,
      frames: paths.map((_path, index) => ({
        frameIndex: index + 1,
        text,
        lines: [text],
        blocks: [],
        engine: "windows_ocr",
      })),
    })),
  };
}

class FakeWorker extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    queueMicrotask(() => this.emit("close", 1, null));
    return true;
  });
  readonly stdin: Writable;
  private requestBuffer = "";

  constructor(
    private readonly onRequest: (
      request: { id: string; imagePaths: string[] }
    ) => Record<string, unknown> | string | Array<Record<string, unknown> | string> | undefined
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.requestBuffer += chunk.toString("utf8");
        const newline = this.requestBuffer.indexOf("\n");
        if (newline >= 0) {
          const request = JSON.parse(this.requestBuffer.slice(0, newline)) as {
            id: string;
            imagePaths: string[];
          };
          this.requestBuffer = this.requestBuffer.slice(newline + 1);
          const response = this.onRequest(request);
          if (response !== undefined) {
            const responses = Array.isArray(response) ? response : [response];
            queueMicrotask(() => {
              for (const item of responses) {
                const line = typeof item === "string" ? item : JSON.stringify(item);
                this.stdout.write(`${line}\n`);
              }
            });
          }
        }
        callback();
      },
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
