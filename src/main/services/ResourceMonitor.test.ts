import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./Logger";
import { ResourceMonitor } from "./ResourceMonitor";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ResourceMonitor", () => {
  it("records resource state and alerts on sustained queue growth and overdue batches", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const state = {
      capturePending: 1,
      batchPending: 0,
      batchActive: 0,
      overdueActive: 0,
    };
    const monitor = new ResourceMonitor({
      captureBatcher: {
        getStatus: () => ({
          pending: state.capturePending,
          inMemory: state.capturePending,
          memoryCapacity: 12,
          flushing: false,
        }),
      },
      batchProcessor: {
        getStatus: () => ({
          active: state.batchActive,
          capacity: 2,
          pending: state.batchPending,
          retries: 4,
          oldestActiveMs: state.overdueActive ? 10 : 0,
          overdueActive: state.overdueActive,
          stopping: false,
        }),
      },
      modelJobQueue: {
        getStatus: () => ({ pending: 0, running: 0, retries: 2, paused: false }),
      },
      embeddingIndexerService: {
        getStatus: () => ({ running: false, queued: 0, batchSize: 4 }),
      },
    }, { intervalMs: 10_000, queueGrowthThreshold: 2 });

    monitor.start();
    await vi.waitFor(() => expect(info).toHaveBeenCalledOnce());

    state.capturePending = 2;
    await vi.advanceTimersByTimeAsync(10_000);
    state.capturePending = 3;
    state.overdueActive = 1;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(info).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "queue_growth" }));
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "batch_processing_timeout" }));
    const latestLog = info.mock.calls.at(-1)?.[0];
    expect(latestLog?.jobType).toBe("resource_monitor");
    expect(JSON.parse(latestLog?.message ?? "{}")).toMatchObject({ capturePending: 3 });

    monitor.stop();
  });
});
