import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelJobQueue } from "./ModelJobQueue";

afterEach(() => {
  vi.useRealTimers();
});

describe("ModelJobQueue retry metadata", () => {
  it("does not retry deterministic output truncation", async () => {
    const queue = new ModelJobQueue();
    const executor = vi.fn(async () => ({
      ok: false,
      errorCode: "output_truncated",
      errorMessage: "length",
      jobId: "job-1",
    }));

    const result = await queue.enqueueMultimodalJob({
      type: "timeline_builder",
      executor,
    });

    expect(executor).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      modelJobId: "job-1",
      attempts: 1,
    });
  });

  it("retries network failures and exposes the logical queue attempt count", async () => {
    vi.useFakeTimers();
    const queue = new ModelJobQueue();
    const executor = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorCode: "network_error", jobId: "job-1" })
      .mockResolvedValueOnce({ ok: true, data: { value: 1 }, jobId: "job-2" });

    const pending = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      executor,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(executor).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      modelJobId: "job-2",
      attempts: 2,
    });
  });

  it("deduplicates pending jobs by date key", async () => {
    let resolveExecutor!: (value: { ok: true; data: string; jobId: string }) => void;
    const executor = vi.fn(() => new Promise<{ ok: true; data: string; jobId: string }>((resolve) => {
      resolveExecutor = resolve;
    }));
    const queue = new ModelJobQueue();

    const first = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      dedupeKey: "timeline_builder:2026-07-11",
      executor,
    });
    const second = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      dedupeKey: "timeline_builder:2026-07-11",
      executor,
    });
    resolveExecutor({ ok: true, data: "done", jobId: "job-1" });

    await expect(first).resolves.toMatchObject({ data: "done" });
    await expect(second).resolves.toMatchObject({ data: "done" });
    expect(executor).toHaveBeenCalledOnce();
  });
});
