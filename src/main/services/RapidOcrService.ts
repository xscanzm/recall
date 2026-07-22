import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BatchFrameOcrResult,
  OcrBoundingBox,
  OcrTextBlock,
  OcrWordResult,
} from "../models/types";
import type {
  ManagedOcrBatchService,
  OcrBatchResult,
  OcrBatchService,
} from "./OcrService";
import { unavailableOcrBatch } from "./OcrService";
import { logger } from "./Logger";

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 120_000;
const DEFAULT_PER_FRAME_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const MAX_STDOUT_BUFFER_BYTES = 16 * 1024 * 1024;
const STREAM_RESPONSE_MODE = "frame_stream_v1";

type SpawnWorker = () => ChildProcessWithoutNullStreams;

interface PendingRequest {
  frameCount: number;
  frames: Map<number, BatchFrameOcrResult>;
  metadata: WorkerMetadata;
  startedAt: number;
  timeoutMs: number;
  resolve: (result: OcrBatchResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RawWorkerResponse {
  id?: unknown;
  type?: unknown;
  available?: unknown;
  engine?: unknown;
  model?: unknown;
  engineVersion?: unknown;
  errorCode?: unknown;
  frame?: unknown;
  frames?: unknown;
}

interface WorkerMetadata {
  engine: string;
  model?: string;
  engineVersion?: string;
}

interface TimeoutBudgetConfig {
  initializationTimeoutMs?: number;
  perFrameTimeoutMs?: number;
  maxTimeoutMs?: number;
}

type RapidOcrTransportErrorCode =
  | "rapidocr_timeout"
  | "rapidocr_worker_crashed"
  | "rapidocr_invalid_output"
  | "rapidocr_service_stopped";

class RapidOcrRequestError extends Error {
  constructor(
    readonly errorCode: RapidOcrTransportErrorCode,
    message: string,
    readonly jobId: string,
    readonly frameCount: number,
    readonly completedFrameCount: number,
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    readonly partialResult: OcrBatchResult
  ) {
    super(message);
    this.name = "RapidOcrRequestError";
  }
}

export interface RapidOcrServiceConfig {
  fallback?: OcrBatchService;
  /** Fixed timeout override retained for tests and explicit deployments. */
  timeoutMs?: number;
  initializationTimeoutMs?: number;
  perFrameTimeoutMs?: number;
  maxTimeoutMs?: number;
  spawnWorker?: SpawnWorker;
  workerPath?: string;
  pythonExecutable?: string;
}

/** Persistent RapidOCR JSONL adapter. It never interpolates image paths into a command line. */
export class RapidOcrService implements ManagedOcrBatchService {
  private readonly fallback?: OcrBatchService;
  private readonly fixedTimeoutMs?: number;
  private readonly timeoutBudget: TimeoutBudgetConfig;
  private readonly spawnWorker: SpawnWorker;
  private worker: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private pending = new Map<string, PendingRequest>();
  private requestTail: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(config: RapidOcrServiceConfig = {}) {
    this.fallback = config.fallback;
    this.fixedTimeoutMs = config.timeoutMs;
    this.timeoutBudget = {
      initializationTimeoutMs: config.initializationTimeoutMs,
      perFrameTimeoutMs: config.perFrameTimeoutMs,
      maxTimeoutMs: config.maxTimeoutMs,
    };
    this.spawnWorker = config.spawnWorker ?? createDefaultSpawner(config);
  }

  async recognizeImages(imagePaths: string[]): Promise<OcrBatchResult> {
    if (imagePaths.length === 0) return { available: true, frames: [] };
    if (this.stopped) {
      return this.runFallback(imagePaths, "rapidocr_service_stopped");
    }

    try {
      const result = await this.enqueueRequest(imagePaths);
      if (!result.available) {
        return this.fallbackFailedFrames(imagePaths, result);
      }
      return this.fallbackFailedFrames(imagePaths, result);
    } catch (error) {
      if (error instanceof RapidOcrRequestError) {
        if (error.errorCode !== "rapidocr_service_stopped") {
          logger.warn({
            jobId: error.jobId,
            jobType: "rapidocr",
            status: "failed",
            errorCode: error.errorCode,
            durationMs: error.elapsedMs,
            message: `RapidOCR ${error.errorCode}: ${error.completedFrameCount}/${error.frameCount} frames completed within ${error.timeoutMs}ms budget`,
          });
        }
        return this.fallbackFailedFrames(imagePaths, error.partialResult);
      }
      logger.warn({
        jobType: "rapidocr",
        status: "failed",
        errorCode: "rapidocr_worker_crashed",
        message: `RapidOCR worker failed to start: ${error instanceof Error ? error.name : "unknown_error"}`,
      });
      return this.runFallback(imagePaths, "rapidocr_worker_crashed");
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.failWorker("rapidocr_service_stopped", "RapidOCR worker stopped", true);
  }

  private async enqueueRequest(imagePaths: string[]): Promise<OcrBatchResult> {
    const previous = this.requestTail;
    let release: () => void = () => undefined;
    this.requestTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try {
      if (this.stopped) {
        return unavailableOcrBatch(
          imagePaths.length,
          "rapidocr_service_stopped",
          "rapidocr"
        );
      }
      return await this.sendRequest(imagePaths);
    } finally {
      release();
    }
  }

  private sendRequest(imagePaths: string[]): Promise<OcrBatchResult> {
    const worker = this.ensureWorker();
    const id = randomUUID();
    const timeoutMs = this.fixedTimeoutMs ?? calculateRapidOcrTimeoutMs(
      imagePaths.length,
      this.timeoutBudget
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failWorker("rapidocr_timeout", "RapidOCR request timed out", true);
      }, timeoutMs);
      this.pending.set(id, {
        frameCount: imagePaths.length,
        frames: new Map(),
        metadata: { engine: "rapidocr" },
        startedAt: Date.now(),
        timeoutMs,
        resolve,
        reject,
        timer,
      });
      worker.stdin.write(`${JSON.stringify({
        id,
        type: "recognize",
        responseMode: STREAM_RESPONSE_MODE,
        imagePaths,
      })}\n`, "utf8", (error) => {
        if (error) {
          this.failWorker(
            "rapidocr_worker_crashed",
            "RapidOCR worker stdin failed",
            true
          );
        }
      });
    });
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker) return this.worker;
    const worker = this.spawnWorker();
    this.worker = worker;
    this.stdoutBuffer = "";
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    worker.stderr.resume();
    worker.once("error", () => {
      this.failWorker("rapidocr_worker_crashed", "RapidOCR worker process error", false);
    });
    worker.once("close", (code) => {
      if (this.worker !== worker) return;
      this.failWorker(
        "rapidocr_worker_crashed",
        `RapidOCR worker exited with code ${String(code)}`,
        false
      );
    });
    return worker;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
      this.failWorker("rapidocr_invalid_output", "RapidOCR output exceeded limit", true);
      return;
    }

    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: RawWorkerResponse;
    try {
      parsed = JSON.parse(line) as RawWorkerResponse;
    } catch {
      this.failWorker("rapidocr_invalid_output", "RapidOCR returned invalid JSON", true);
      return;
    }
    if (typeof parsed.id !== "string") {
      this.failWorker(
        "rapidocr_invalid_output",
        "RapidOCR response is missing a request id",
        true
      );
      return;
    }
    const request = this.pending.get(parsed.id);
    if (!request) return;
    if (parsed.type === undefined) {
      this.completeRequest(parsed.id, parseWorkerResponse(parsed, request.frameCount));
      return;
    }
    if (parsed.type === "frame") {
      const metadata = parseWorkerMetadata(parsed, request.metadata);
      const frame = parseFrame(parsed.frame, request.frameCount, metadata);
      if (!frame || parsed.available !== true || request.frames.has(frame.frameIndex)) {
        this.failWorker(
          "rapidocr_invalid_output",
          "RapidOCR returned an invalid streamed frame",
          true
        );
        return;
      }
      request.metadata = metadata;
      request.frames.set(frame.frameIndex, frame);
      return;
    }
    if (parsed.type === "complete") {
      request.metadata = parseWorkerMetadata(parsed, request.metadata);
      if (typeof parsed.available !== "boolean") {
        this.failWorker(
          "rapidocr_invalid_output",
          "RapidOCR completion is missing availability",
          true
        );
        return;
      }
      if (parsed.available && request.frames.size !== request.frameCount) {
        this.failWorker(
          "rapidocr_invalid_output",
          "RapidOCR completed without all frame results",
          true
        );
        return;
      }
      const errorCode = typeof parsed.errorCode === "string"
        ? parsed.errorCode
        : parsed.available ? undefined : "rapidocr_unavailable";
      this.completeRequest(
        parsed.id,
        buildStreamResult(request, errorCode, parsed.available)
      );
      return;
    }
    this.failWorker(
      "rapidocr_invalid_output",
      "RapidOCR returned an unknown response type",
      true
    );
  }

  private completeRequest(id: string, result: OcrBatchResult): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.resolve(result);
  }

  private failWorker(
    errorCode: RapidOcrTransportErrorCode,
    message: string,
    kill: boolean
  ): void {
    const worker = this.worker;
    this.worker = null;
    this.stdoutBuffer = "";
    if (kill && worker && !worker.killed) terminateWorkerProcessTree(worker);
    for (const [id, request] of this.pending.entries()) {
      clearTimeout(request.timer);
      const elapsedMs = Math.max(0, Date.now() - request.startedAt);
      request.reject(new RapidOcrRequestError(
        errorCode,
        message,
        id,
        request.frameCount,
        request.frames.size,
        request.timeoutMs,
        elapsedMs,
        buildStreamResult(request, errorCode, request.frames.size > 0)
      ));
    }
    this.pending.clear();
  }

  private async runFallback(imagePaths: string[], errorCode: string): Promise<OcrBatchResult> {
    if (!this.fallback) {
      return unavailableOcrBatch(imagePaths.length, errorCode, "rapidocr");
    }
    try {
      return await this.fallback.recognizeImages(imagePaths);
    } catch {
      return unavailableOcrBatch(
        imagePaths.length,
        "rapidocr_and_fallback_failed",
        "rapidocr"
      );
    }
  }

  private async fallbackFailedFrames(
    imagePaths: string[],
    result: OcrBatchResult
  ): Promise<OcrBatchResult> {
    if (!this.fallback) return result;
    const failedIndexes = result.frames.flatMap((frame, index) =>
      frame.errorCode ? [index] : []
    );
    if (failedIndexes.length === 0) return result;

    try {
      const fallback = await this.fallback.recognizeImages(
        failedIndexes.map((index) => imagePaths[index])
      );
      const frames = [...result.frames];
      failedIndexes.forEach((originalIndex, fallbackIndex) => {
        const fallbackFrame = fallback.frames[fallbackIndex];
        if (fallbackFrame && !fallbackFrame.errorCode) {
          frames[originalIndex] = {
            ...fallbackFrame,
            frameIndex: originalIndex + 1,
          };
        }
      });
      const hasSuccessfulFrame = frames.some((frame) => !frame.errorCode);
      const hasFailedFrame = frames.some((frame) => !!frame.errorCode);
      return {
        available: hasSuccessfulFrame,
        frames,
        ...(hasFailedFrame && result.errorCode ? { errorCode: result.errorCode } : {}),
      };
    } catch {
      return result;
    }
  }
}

export function calculateRapidOcrTimeoutMs(
  frameCount: number,
  config: TimeoutBudgetConfig = {}
): number {
  const initializationTimeoutMs = nonNegativeBudget(
    config.initializationTimeoutMs,
    DEFAULT_INITIALIZATION_TIMEOUT_MS
  );
  const perFrameTimeoutMs = nonNegativeBudget(
    config.perFrameTimeoutMs,
    DEFAULT_PER_FRAME_TIMEOUT_MS
  );
  const maxTimeoutMs = Math.max(1, nonNegativeBudget(
    config.maxTimeoutMs,
    DEFAULT_MAX_TIMEOUT_MS
  ));
  const frames = Math.max(0, Math.floor(frameCount));
  return Math.min(maxTimeoutMs, initializationTimeoutMs + perFrameTimeoutMs * frames);
}

function nonNegativeBudget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined
    ? Math.max(0, Math.floor(value))
    : fallback;
}

function parseWorkerMetadata(
  raw: RawWorkerResponse,
  fallback: WorkerMetadata
): WorkerMetadata {
  return {
    engine: typeof raw.engine === "string" ? raw.engine : fallback.engine,
    model: typeof raw.model === "string" ? raw.model : fallback.model,
    engineVersion: typeof raw.engineVersion === "string"
      ? raw.engineVersion
      : fallback.engineVersion,
  };
}

function buildStreamResult(
  request: Pick<PendingRequest, "frameCount" | "frames" | "metadata">,
  errorCode: string | undefined,
  available: boolean
): OcrBatchResult {
  return {
    available,
    ...(errorCode ? { errorCode } : {}),
    frames: Array.from({ length: request.frameCount }, (_, index) =>
      request.frames.get(index + 1) ?? {
        frameIndex: index + 1,
        text: "",
        lines: [],
        blocks: [],
        ...request.metadata,
        errorCode: errorCode ?? "rapidocr_missing_result",
      }
    ),
  };
}

function createDefaultSpawner(config: RapidOcrServiceConfig): SpawnWorker {
  return () => {
    const workerPath = config.workerPath ?? resolveWorkerPath();
    const isExecutable = path.extname(workerPath).toLowerCase() === ".exe";
    const command = isExecutable
      ? workerPath
      : config.pythonExecutable ?? process.env.RECALL_PYTHON_PATH ?? "python";
    const args = isExecutable ? [] : ["-u", workerPath];
    return spawn(command, args, {
      cwd: path.dirname(workerPath),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
}

function terminateWorkerProcessTree(worker: ChildProcessWithoutNullStreams): void {
  if (process.platform !== "win32" || !worker.pid) {
    worker.kill();
    return;
  }
  const killer = spawn(
    "taskkill.exe",
    ["/pid", String(worker.pid), "/t", "/f"],
    { windowsHide: true, stdio: "ignore" }
  );
  const fallbackKill = () => {
    if (!worker.killed) worker.kill();
  };
  killer.once("error", fallbackKill);
  killer.once("close", (code) => {
    if (code !== 0) fallbackKill();
  });
  killer.unref();
}

function resolveWorkerPath(): string {
  const configured = process.env.RECALL_RAPIDOCR_WORKER_PATH?.trim();
  if (configured) return path.resolve(configured);
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const packagedExecutable = resourcesPath
    ? path.join(resourcesPath, "ocr", "rapidocr-worker", "rapidocr-worker.exe")
    : "";
  if (packagedExecutable && fs.existsSync(packagedExecutable)) return packagedExecutable;
  const developmentExecutable = path.resolve(
    __dirname,
    "../../../resources/ocr/rapidocr-worker/rapidocr-worker.exe"
  );
  if (fs.existsSync(developmentExecutable)) return developmentExecutable;
  const legacyExecutable = path.resolve(
    __dirname,
    "../../../resources/ocr/rapidocr-worker.exe"
  );
  if (fs.existsSync(legacyExecutable)) return legacyExecutable;
  return path.resolve(__dirname, "../../../resources/ocr/rapidocr_worker.py");
}

function parseWorkerResponse(raw: RawWorkerResponse, frameCount: number): OcrBatchResult {
  const available = raw.available === true;
  const engine = typeof raw.engine === "string" ? raw.engine : "rapidocr";
  const model = typeof raw.model === "string" ? raw.model : undefined;
  const engineVersion = typeof raw.engineVersion === "string" ? raw.engineVersion : undefined;
  const errorCode = typeof raw.errorCode === "string" ? raw.errorCode : undefined;
  if (!available) return unavailableOcrBatch(frameCount, errorCode ?? "rapidocr_unavailable", engine);

  const byFrame = new Map<number, BatchFrameOcrResult>();
  for (const value of Array.isArray(raw.frames) ? raw.frames : []) {
    const frame = parseFrame(value, frameCount, { engine, model, engineVersion });
    if (frame) byFrame.set(frame.frameIndex, frame);
  }
  return {
    available: true,
    frames: Array.from({ length: frameCount }, (_, index) =>
      byFrame.get(index + 1) ?? {
        frameIndex: index + 1,
        text: "",
        lines: [],
        blocks: [],
        engine,
        model,
        engineVersion,
        errorCode: "rapidocr_missing_result",
      }
    ),
  };
}

function parseFrame(
  value: unknown,
  frameCount: number,
  metadata: Pick<BatchFrameOcrResult, "engine" | "model" | "engineVersion">
): BatchFrameOcrResult | null {
  if (!value || typeof value !== "object") return null;
  const frame = value as Record<string, unknown>;
  const frameIndex = Number(frame.frameIndex);
  if (!Number.isInteger(frameIndex) || frameIndex < 1 || frameIndex > frameCount) return null;
  return {
    frameIndex,
    text: typeof frame.text === "string" ? frame.text : "",
    lines: Array.isArray(frame.lines)
      ? frame.lines.filter((line): line is string => typeof line === "string")
      : [],
    blocks: parseBlocks(frame.blocks),
    language: typeof frame.language === "string" ? frame.language : undefined,
    errorCode: typeof frame.errorCode === "string" ? frame.errorCode : undefined,
    ...metadata,
  };
}

function parseBlocks(value: unknown): OcrTextBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    const boundingBox = parseBoundingBox(block.boundingBox);
    if (!boundingBox) return [];
    return [{
      id: typeof block.id === "string" && block.id ? block.id : `line_${index + 1}`,
      text: typeof block.text === "string" ? block.text : "",
      boundingBox,
      words: parseWords(block.words),
      confidence: parseConfidence(block.confidence),
    }];
  });
}

function parseWords(value: unknown): OcrWordResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const word = item as Record<string, unknown>;
    const boundingBox = parseBoundingBox(word.boundingBox);
    if (!boundingBox || typeof word.text !== "string") return [];
    return [{
      text: word.text,
      boundingBox,
      confidence: parseConfidence(word.confidence),
    }];
  });
}

function parseBoundingBox(value: unknown): OcrBoundingBox | null {
  if (!value || typeof value !== "object") return null;
  const box = value as Record<string, unknown>;
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

function parseConfidence(value: unknown): number | undefined {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : undefined;
}
