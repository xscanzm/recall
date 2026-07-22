import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureBatcher } from "./CaptureBatcher";
import { BatchProcessor } from "./BatchProcessor";
import type { BatchStage } from "../db/repositories/CaptureInboxRepository";

const bundle = {
  batchId: "batch-1", frames: [], capturedAtStart: "2026-01-01T00:00:00.000Z",
  capturedAtEnd: "2026-01-01T00:00:00.000Z", timezone: "UTC", appName: "Test",
  windowTitle: "Test", captureReason: "batch_flush", imagePaths: [],
  compressedImagePaths: ["image.jpg"], retentionPolicy: "today",
} as const;

afterEach(() => vi.restoreAllMocks());

function repository() {
  let attempts = 0;
  let status = "pending";
  const stages: Record<BatchStage, string> = { observer: "pending", episode: "pending", atom: "pending", linker: "pending" };
  let checkpoint = {};
  return {
    recoverRunningBatches: vi.fn(() => 0),
    listProcessableBatches: vi.fn(() => status === "pending" && attempts < 3
      ? [{ batchId: bundle.batchId, bundle, status, attempts, lastError: null, stages: { ...stages }, checkpoint }] : []),
    markRunning: vi.fn(() => { attempts += 1; status = "running"; }),
    updateBatchBundle: vi.fn(),
    markSucceeded: vi.fn(() => { status = "succeeded"; }),
    markFailed: vi.fn((_id, _error, retry) => { status = retry ? "pending" : "failed"; }),
    checkpointRunning: vi.fn(() => { status = "pending"; }),
    markStageRunning: vi.fn((_id: string, stage: BatchStage) => { stages[stage] = "running"; }),
    markStageSucceeded: vi.fn((_id: string, stage: BatchStage, patch = {}) => { stages[stage] = "succeeded"; checkpoint = { ...checkpoint, ...patch }; }),
    markStageFailed: vi.fn((_id: string, stage: BatchStage) => { stages[stage] = "failed"; }),
    state: () => ({ attempts, status }),
  };
}

describe("BatchProcessor", () => {
  it("retries a failed batch and marks the same durable id successful exactly once", async () => {
    vi.spyOn(CaptureBatcher, "restoreCompressedImages").mockResolvedValue(true);
    vi.spyOn(CaptureBatcher, "cleanupCompressedImages").mockImplementation(() => undefined);
    const repo = repository();
    const process = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue({ steps: { observerExtractor: true, normalizer: { failed: 0 }, episodes: true, atoms: true, linkerSceneJudge: true }, errors: [] });
    const processor = new BatchProcessor(repo as never, { processBatchCaptureBundle: process } as never);
    await processor.drain();
    expect(process).toHaveBeenCalledTimes(2);
    expect(repo.markSucceeded).toHaveBeenCalledTimes(1);
    expect(repo.state()).toEqual({ attempts: 2, status: "succeeded" });
  });

  it("stops after three attempts and does not process an exhausted record again", async () => {
    vi.spyOn(CaptureBatcher, "restoreCompressedImages").mockResolvedValue(true);
    const cleanup = vi.spyOn(CaptureBatcher, "cleanupCompressedImages").mockImplementation(() => undefined);
    const repo = repository();
    const process = vi.fn().mockRejectedValue(new Error("permanent"));
    const processor = new BatchProcessor(repo as never, { processBatchCaptureBundle: process } as never);
    await processor.drain();
    await processor.drain();
    expect(process).toHaveBeenCalledTimes(3);
    expect(repo.markFailed.mock.calls.map((call) => call[2])).toEqual([true, true, false]);
    expect(repo.state()).toEqual({ attempts: 3, status: "failed" });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("recovers interrupted running batches without reviving terminal failures", async () => {
    const recoverRunningBatches = vi.fn(() => 2);
    const repo = {
      recoverRunningBatches,
      listProcessableBatches: vi.fn(() => []),
    };
    const processor = new BatchProcessor(repo as never, {} as never);

    processor.start();
    await processor.drain();

    expect(recoverRunningBatches).toHaveBeenCalledOnce();
    expect("recoverFailedBatches" in repo).toBe(false);
  });

  it("idempotently waits for active work and does not claim new batches after stop", async () => {
    vi.spyOn(CaptureBatcher, "restoreCompressedImages").mockResolvedValue(true);
    vi.spyOn(CaptureBatcher, "cleanupCompressedImages").mockImplementation(() => undefined);
    const secondBundle = { ...bundle, batchId: "batch-2" };
    let firstStatus = "pending";
    let secondStatus = "pending";
    let allowSecond = false;
    const repo = {
      recoverRunningBatches: vi.fn(() => 0),
      listProcessableBatches: vi.fn(() => {
        if (firstStatus === "pending") {
          return [{ batchId: bundle.batchId, bundle, status: firstStatus, attempts: 0, lastError: null, stages: {}, checkpoint: {} }];
        }
        if (allowSecond && secondStatus === "pending") {
          return [{ batchId: secondBundle.batchId, bundle: secondBundle, status: secondStatus, attempts: 0, lastError: null, stages: {}, checkpoint: {} }];
        }
        return [];
      }),
      markRunning: vi.fn((batchId: string) => {
        if (batchId === bundle.batchId) firstStatus = "running";
        if (batchId === secondBundle.batchId) secondStatus = "running";
      }),
      updateBatchBundle: vi.fn(),
      markSucceeded: vi.fn((batchId: string) => {
        if (batchId === bundle.batchId) firstStatus = "succeeded";
        if (batchId === secondBundle.batchId) secondStatus = "succeeded";
      }),
      markFailed: vi.fn(),
      markStageRunning: vi.fn(),
      markStageSucceeded: vi.fn(),
      markStageFailed: vi.fn(),
    };
    let finishPipeline: ((value: unknown) => void) | undefined;
    const process = vi.fn(() => new Promise((resolve) => { finishPipeline = resolve; }));
    const processor = new BatchProcessor(repo as never, { processBatchCaptureBundle: process } as never);
    processor.start();
    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce());

    const firstDrain = processor.stopAndDrainActive();
    const secondDrain = processor.stopAndDrainActive();
    expect(secondDrain).toBe(firstDrain);
    allowSecond = true;
    let drained = false;
    void firstDrain.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    finishPipeline?.({
      steps: {
        observerExtractor: true,
        normalizer: { failed: 0 },
        episodes: true,
        atoms: true,
        linkerSceneJudge: true,
      },
      errors: [],
    });
    await firstDrain;

    expect(repo.markSucceeded).toHaveBeenCalledWith(bundle.batchId);
    expect(process).toHaveBeenCalledOnce();
    expect(secondStatus).toBe("pending");
  });
});
