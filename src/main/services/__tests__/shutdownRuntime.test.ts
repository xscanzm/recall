import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetShutdownStateForTests, shutdownRuntime } from "../shutdownRuntime";

describe("shutdownRuntime", () => {
  beforeEach(() => {
    resetShutdownStateForTests();
  });

  it("drains producers and pipelines before closing the database", async () => {
    const callOrder: string[] = [];
    const step = (name: string) => vi.fn(async () => { callOrder.push(name); });
    const stopReportScheduler = step("reportScheduler.stop");
    const stopTimelineCoordinator = step("timelineWindowCoordinator.stop");
    const persistTimelineTail = step("timelineWindowCoordinator.persistTailForShutdown");
    const stopActivityService = step("activityService.stop");
    const stopCaptureService = step("captureService.stop");
    const drainCaptureService = step("captureService.drain");
    const drainCaptureBatcher = step("captureBatcher.drain");
    const stopOcrService = step("ocrService.stop");
    const drainBatchProcessor = step("batchProcessor.stopAndDrainActive");
    const drainModelJobQueue = step("modelJobQueue.stopAndDrainActive");

    await shutdownRuntime({
      reportScheduler: { stop: stopReportScheduler },
      timelineWindowCoordinator: {
        stop: stopTimelineCoordinator,
        persistTailForShutdown: persistTimelineTail,
      },
      activityService: { stop: stopActivityService },
      captureService: { stop: stopCaptureService, drain: drainCaptureService },
      captureBatcher: { drain: drainCaptureBatcher },
      ocrService: { stop: stopOcrService },
      batchProcessor: { stopAndDrainActive: drainBatchProcessor },
      modelJobQueue: { stopAndDrainActive: drainModelJobQueue },
      trayService: { destroy: () => { callOrder.push("trayService.destroy"); } },
      closeDatabase: () => { callOrder.push("closeDatabase"); },
      exitApp: () => { callOrder.push("exitApp"); },
    }, 1234);

    expect(callOrder).toEqual([
      "reportScheduler.stop",
      "timelineWindowCoordinator.stop",
      "activityService.stop",
      "captureService.stop",
      "captureService.drain",
      "captureBatcher.drain",
      "timelineWindowCoordinator.persistTailForShutdown",
      "ocrService.stop",
      "batchProcessor.stopAndDrainActive",
      "modelJobQueue.stopAndDrainActive",
      "trayService.destroy",
      "closeDatabase",
      "exitApp",
    ]);
    expect(drainModelJobQueue).toHaveBeenCalledWith(1234);
  });

  it("continues after best-effort scheduler cleanup fails", async () => {
    const closeDatabase = vi.fn();
    await expect(shutdownRuntime({
      reportScheduler: { stop: () => { throw new Error("scheduler failed"); } },
      closeDatabase,
    })).resolves.toBeUndefined();

    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("does not close SQLite when a critical drain fails", async () => {
    const closeDatabase = vi.fn();
    const exitApp = vi.fn();
    await expect(shutdownRuntime({
      captureBatcher: { drain: async () => { throw new Error("flush failed"); } },
      modelJobQueue: { stopAndDrainActive: async () => undefined },
      closeDatabase,
      exitApp,
    })).rejects.toThrow("did not drain cleanly");

    expect(closeDatabase).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it("is idempotent while shutdown is still in progress", async () => {
    let finishDrain: (() => void) | undefined;
    const drain = new Promise<void>((resolve) => { finishDrain = resolve; });
    const closeDatabase = vi.fn();
    const deps = {
      batchProcessor: { stopAndDrainActive: vi.fn(() => drain) },
      closeDatabase,
    };

    const first = shutdownRuntime(deps);
    const second = shutdownRuntime(deps);
    expect(second).toBe(first);
    expect(closeDatabase).not.toHaveBeenCalled();

    finishDrain?.();
    await Promise.all([first, second]);
    expect(deps.batchProcessor.stopAndDrainActive).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
