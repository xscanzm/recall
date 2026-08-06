import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelJobQueue,
  parseRetryAfterMs,
  computeBackoffWithJitter,
  MAX_TOTAL_REQUEST_BUDGET,
  MULTIMODAL_CONCURRENCY,
} from "./ModelJobQueue";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelJobQueue retry metadata & Rate Limit governance", () => {
  it("parses Retry-After header both in seconds and in HTTP Date format", () => {
    expect(parseRetryAfterMs("120")).toBe(120000);
    expect(parseRetryAfterMs(" 5 ")).toBe(5000);

    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const parsed = parseRetryAfterMs(futureDate);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(10000);

    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
  });

  it("computes backoff with Full Jitter correctly", () => {
    const backoff = computeBackoffWithJitter("rate_limited", 1);
    expect(backoff).toBeGreaterThanOrEqual(0);
    expect(backoff).toBeLessThanOrEqual(60000);

    const customRetryAfter = computeBackoffWithJitter("rate_limited", 1, 15000);
    expect(customRetryAfter).toBe(15000);
  });

  it("enforces Endpoint Cooldown isolation and releases concurrency slot during wait", () => {
    const queue = new ModelJobQueue();
    expect(queue.isEndpointInCooldown("endpoint-a")).toBe(false);

    queue.setEndpointCooldown("endpoint-a", 10000);
    expect(queue.isEndpointInCooldown("endpoint-a")).toBe(true);
    expect(queue.isEndpointInCooldown("endpoint-b")).toBe(false);
  });

  it("keeps a cooled-down endpoint queued while unrelated endpoints continue", async () => {
    const queue = new ModelJobQueue();
    const limited = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      rateLimitKey: "endpoint-a",
      executor: vi.fn(async () => ({
        ok: false,
        errorCode: "rate_limited",
        retryAfterMs: 60_000,
        rateLimitKey: "endpoint-a",
        requestCount: 1,
      })),
    });
    await vi.waitFor(() => expect(queue.isEndpointInCooldown("endpoint-a")).toBe(true));

    const sameEndpointExecutor = vi.fn(async () => ({ ok: true }));
    const sameEndpoint = queue.enqueueMultimodalJob({
      type: "reporter",
      rateLimitKey: "endpoint-a",
      executor: sameEndpointExecutor,
    });
    const otherEndpoint = queue.enqueueMultimodalJob({
      type: "reporter",
      rateLimitKey: "endpoint-b",
      executor: vi.fn(async () => ({ ok: true, requestCount: 1 })),
    });

    await expect(otherEndpoint).resolves.toMatchObject({ ok: true, requestCount: 1 });
    expect(sameEndpointExecutor).not.toHaveBeenCalled();
    await queue.stopAndDrainActive();
    await expect(limited).resolves.toMatchObject({ errorCode: "stopped" });
    await expect(sameEndpoint).resolves.toMatchObject({ errorCode: "stopped" });
  });

  it("releases a concurrency slot while a retry waits", async () => {
    const queue = new ModelJobQueue();
    const blockers = Array.from({ length: MULTIMODAL_CONCURRENCY - 1 }, () => deferred<{ ok: true; requestCount: number }>());
    const blockerJobs = blockers.map((blocker) => queue.enqueueMultimodalJob({
      type: "reporter",
      executor: () => blocker.promise,
    }));
    await vi.waitFor(() => expect(queue.getStatus().running).toBe(MULTIMODAL_CONCURRENCY - 1));

    const retryingExecutor = vi.fn(async () => ({
      ok: false,
      errorCode: "rate_limited",
      retryAfterMs: 60_000,
      requestCount: 1,
    }));
    const unrelatedExecutor = vi.fn(async () => ({ ok: true, requestCount: 1 }));
    const retrying = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      rateLimitKey: "endpoint-a",
      executor: retryingExecutor,
    });
    await vi.waitFor(() => expect(retryingExecutor).toHaveBeenCalledOnce());
    const unrelated = queue.enqueueMultimodalJob({
      type: "reporter",
      rateLimitKey: "endpoint-b",
      executor: unrelatedExecutor,
    });
    await expect(unrelated).resolves.toMatchObject({ ok: true });
    expect(unrelatedExecutor).toHaveBeenCalledOnce();

    blockers.forEach((blocker) => blocker.resolve({ ok: true, requestCount: 1 }));
    await Promise.all(blockerJobs);
    await queue.stopAndDrainActive();
    await expect(retrying).resolves.toMatchObject({ errorCode: "stopped" });
  });

  it("enforces the HTTP request budget across logical retries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const queue = new ModelJobQueue();
    const executor = vi.fn(async () => ({
      ok: false,
      errorCode: "network_error",
      errorMessage: "temporary",
      requestCount: 3,
    }));

    const result = await queue.enqueueMultimodalJob({ type: "reporter", executor });

    expect(executor).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ok: false, attempts: 2, requestCount: MAX_TOTAL_REQUEST_BUDGET });
    expect(result.errorMessage).toContain("请求预算");
  });

  it("cancels pending work and waits for active executors during shutdown", async () => {
    const queue = new ModelJobQueue();
    const active = Array.from({ length: MULTIMODAL_CONCURRENCY }, () => deferred<{ ok: true; requestCount: number }>());
    const activeJobs = active.map((item) => queue.enqueueMultimodalJob({
      type: "reporter",
      executor: () => item.promise,
    }));
    const pendingExecutor = vi.fn(async () => ({ ok: true, requestCount: 1 }));
    const pending = queue.enqueueMultimodalJob({ type: "reporter", executor: pendingExecutor });
    await vi.waitFor(() => expect(queue.getStatus()).toMatchObject({ running: MULTIMODAL_CONCURRENCY, pending: 1 }));

    let drained = false;
    const drain = queue.stopAndDrainActive(1000).then(() => { drained = true; });
    await expect(pending).resolves.toMatchObject({ errorCode: "stopped", requestCount: 0 });
    expect(pendingExecutor).not.toHaveBeenCalled();
    expect(drained).toBe(false);

    active.forEach((item) => item.resolve({ ok: true, requestCount: 1 }));
    await Promise.all(activeJobs);
    await drain;
    expect(drained).toBe(true);
  });

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

  it("does not retry 520/524 upstream timeouts", async () => {
    const queue = new ModelJobQueue();
    const executor = vi.fn(async () => ({
      ok: false,
      errorCode: "upstream_timeout",
      errorMessage: "HTTP 524",
      requestCount: 1,
    }));

    const result = await queue.enqueueMultimodalJob({ type: "observer_batch", executor });

    expect(executor).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_timeout",
      attempts: 1,
      requestCount: 1,
    });
  });

  it("retries async_poll_timeout because the idempotency key prevents duplicate generation", async () => {
    vi.useFakeTimers();
    const queue = new ModelJobQueue();
    const executor = vi.fn(async () => ({
      ok: false,
      errorCode: "async_poll_timeout",
      errorMessage: "本地轮询超时，幂等键已持有",
      requestCount: 1,
    }));

    const pending = queue.enqueueMultimodalJob({ type: "observer_batch", executor });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;

    expect(executor).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      ok: false,
      errorCode: "async_poll_timeout",
      attempts: 3,
      requestCount: 3,
    });
    vi.useRealTimers();
  });

  it("retries network failures using fake timers", async () => {
    vi.useFakeTimers();
    const queue = new ModelJobQueue();
    const executor = vi.fn()
      .mockResolvedValueOnce({ ok: false, errorCode: "network_error", jobId: "job-1" })
      .mockResolvedValueOnce({ ok: true, data: { value: 1 }, jobId: "job-2" });

    const pending = queue.enqueueMultimodalJob({
      type: "timeline_builder",
      executor,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(executor).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      modelJobId: "job-2",
      attempts: 2,
    });
  });

  it("deduplicates pending jobs by dedupeKey", async () => {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
