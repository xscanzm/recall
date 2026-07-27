import { describe, expect, it, vi } from "vitest";
import type { Observation } from "../models/types";
import type {
  TimelineGenerationWindow,
  TimelineWindowStatus,
} from "../db/repositories/TimelineGenerationWindowRepository";
import {
  TimelineWindowCoordinator,
  TIMELINE_SEAL_GRACE_MS,
} from "./TimelineWindowCoordinator";

const observation = (id: string, capturedAt: string) => ({
  id,
  capturedAt,
  appName: "Editor",
  windowTitle: "Recall",
  sceneSummary: id,
} as Observation);

function makeHarness(input: {
  observations: Observation[];
  watermark?: { totalCount: number; unsettledCount: number; failedCount: number; batchIds: string[] };
  buildResults?: Array<{ ok: boolean; block?: { id: string }; errorMessage?: string }>;
}) {
  const windows = new Map<string, TimelineGenerationWindow>();
  let idCounter = 0;
  const nowIso = () => "2026-07-23T01:00:00.000Z";
  const windowRepo = {
    resetInterruptedGenerating: vi.fn(() => 0),
    create: vi.fn((request) => {
      const now = nowIso();
      const value: TimelineGenerationWindow = {
        id: `window-${++idCounter}`,
        dateKey: request.dateKey,
        collectionStart: request.collectionStart,
        collectionEnd: request.collectionEnd,
        actualStart: null,
        actualEnd: null,
        status: "collecting",
        closeReason: null,
        sourceCompleteness: "complete",
        timelineBlockId: null,
        sourceObservationCount: 0,
        retryCount: 0,
        lastError: null,
        sealedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      windows.set(value.id, value);
      return value;
    }),
    getById: vi.fn((id) => windows.get(id) ?? null),
    getActive: vi.fn((dateKey?: string) => [...windows.values()].find((window) =>
      (!dateKey || window.dateKey === dateKey)
      && ["collecting", "sealing"].includes(window.status)
    ) ?? null),
    listPendingGeneration: vi.fn(() => [...windows.values()].filter((window) =>
      ["ready", "failed"].includes(window.status)
    ).sort((left, right) => left.collectionStart.localeCompare(right.collectionStart))),
    listSucceededPartial: vi.fn(() => [...windows.values()].filter((window) =>
      window.status === "succeeded" && window.sourceCompleteness === "partial"
    )),
    listByDateKey: vi.fn((dateKey) => [...windows.values()].filter((window) => window.dateKey === dateKey)),
    getLastCollectionEnd: vi.fn((dateKey) => [...windows.values()]
      .filter((window) => window.dateKey === dateKey)
      .map((window) => window.collectionEnd)
      .sort()
      .at(-1) ?? null),
    update: vi.fn((id, patch) => {
      const current = windows.get(id)!;
      const updated = {
        ...current,
        ...patch,
        retryCount: current.retryCount + (patch.incrementRetry ? 1 : 0),
      } as TimelineGenerationWindow;
      delete (updated as TimelineGenerationWindow & { incrementRetry?: boolean }).incrementRetry;
      windows.set(id, updated);
      return updated;
    }),
  };
  const observationRepo = {
    listByCapturedAt: vi.fn((query) => input.observations
      .filter((value) => (!query.from || value.capturedAt >= query.from) && (!query.to || value.capturedAt < query.to))
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))
      .slice(0, query.limit)),
  };
  const flush = vi.fn(async () => undefined);
  const drainThroughCapturedAt = vi.fn(async () => undefined);
  const getWindowWatermark = vi.fn(() => input.watermark ?? ({
    totalCount: input.observations.length,
    unsettledCount: 0,
    failedCount: 0,
    batchIds: [],
  }));
  const results = [...(input.buildResults ?? [])];
  const buildWindow = vi.fn(async () => results.shift() ?? ({ ok: true, block: { id: "timeline-1" } }));
  const coordinator = new TimelineWindowCoordinator({
    // 固定时钟：不传 at 的入口（persistTailForShutdown 等）会用 now() 推 dateKey，
    // 跟真实系统日期挂钩的话夹具一过当天就整体落到窗口外。
    now: () => local("09:12:00"),
    windowRepo: windowRepo as never,
    observationRepo: observationRepo as never,
    captureInboxRepo: { getWindowWatermark } as never,
    timelineBuilderWorker: { buildWindow } as never,
    captureBatcher: { flush },
    batchProcessor: { drainThroughCapturedAt },
    timelineBlockRepo: { deleteUnprotectedByDateKey: vi.fn(() => 0) },
  });
  return {
    coordinator,
    windows,
    windowRepo,
    flush,
    drainThroughCapturedAt,
    getWindowWatermark,
    buildWindow,
  };
}

const local = (time: string) => new Date(`2026-07-23T${time}+08:00`);

describe("TimelineWindowCoordinator", () => {
  it("submits irregular samples once after the ten-minute boundary and displays actual evidence time", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local("09:06:00").toISOString()),
      observation("o3", local("09:11:00").toISOString()),
    ] });
    await harness.coordinator.advance(local("09:12:59"));
    expect(harness.buildWindow).not.toHaveBeenCalled();
    await harness.coordinator.advance(new Date(local("09:13:00").getTime() + TIMELINE_SEAL_GRACE_MS));
    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(harness.drainThroughCapturedAt).toHaveBeenCalledWith(
      local("09:03:00").toISOString(),
      local("09:13:00").toISOString()
    );
    expect(harness.buildWindow).toHaveBeenCalledTimes(1);
    expect([...harness.windows.values()][0]).toMatchObject({
      collectionStart: local("09:03:00").toISOString(),
      collectionEnd: local("09:13:00").toISOString(),
      actualStart: local("09:03:00").toISOString(),
      actualEnd: local("09:11:00").toISOString(),
      status: "succeeded",
    });
  });

  it("uses half-open boundaries so the boundary observation starts the next window", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local("09:08:00").toISOString()),
      observation("o3", local("09:13:00").toISOString()),
    ] });
    await harness.coordinator.advance(new Date(local("09:13:00").getTime() + TIMELINE_SEAL_GRACE_MS));
    const windows = [...harness.windows.values()];
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ actualEnd: local("09:08:00").toISOString(), status: "succeeded" });
    expect(windows[1]).toMatchObject({ collectionStart: local("09:13:00").toISOString(), status: "collecting" });
  });

  it.each([
    ["four minutes fifty-nine seconds", "09:07:59", "skipped"],
    ["exactly five minutes", "09:08:00", "succeeded"],
  ])("applies the five-minute lower bound for %s", async (_name, lastTime, expectedStatus) => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local(lastTime).toISOString()),
    ] });
    await harness.coordinator.finalizeTail("idle", { at: local("09:09:00") });
    expect([...harness.windows.values()][0]?.status).toBe(expectedStatus as TimelineWindowStatus);
    expect(harness.buildWindow).toHaveBeenCalledTimes(expectedStatus === "succeeded" ? 1 : 0);
  });

  it("waits for the capture watermark and marks exhausted failures partial", async () => {
    const watermark = { totalCount: 3, unsettledCount: 1, failedCount: 0, batchIds: ["b1"] };
    const harness = makeHarness({
      observations: [
        observation("o1", local("09:03:00").toISOString()),
        observation("o2", local("09:09:00").toISOString()),
      ],
      watermark,
    });
    const due = new Date(local("09:13:00").getTime() + TIMELINE_SEAL_GRACE_MS);
    await harness.coordinator.advance(due);
    expect([...harness.windows.values()][0]).toMatchObject({ status: "sealing" });
    expect(harness.buildWindow).not.toHaveBeenCalled();
    watermark.unsettledCount = 0;
    watermark.failedCount = 1;
    await harness.coordinator.advance(due);
    expect(harness.flush).toHaveBeenCalledTimes(1);
    expect(harness.drainThroughCapturedAt).toHaveBeenCalledTimes(2);
    expect(harness.buildWindow).toHaveBeenCalledWith(expect.objectContaining({ sourceCompleteness: "partial" }));
    expect([...harness.windows.values()][0]).toMatchObject({ status: "succeeded", sourceCompleteness: "partial" });
  });

  it("does not await the active advance again from a batch settlement callback", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local("09:09:00").toISOString()),
    ] });
    harness.drainThroughCapturedAt.mockImplementation(async () => {
      await harness.coordinator.onBatchSettled("succeeded", {} as never);
    });

    const result = await Promise.race([
      harness.coordinator
        .advance(new Date(local("09:13:00").getTime() + TIMELINE_SEAL_GRACE_MS))
        .then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("deadlocked"), 100)),
    ]);

    expect(result).toBe("completed");
    expect([...harness.windows.values()][0]).toMatchObject({ status: "succeeded" });
  });

  it("keeps a failed model window and retries the same identity", async () => {
    const harness = makeHarness({
      observations: [
        observation("o1", local("09:03:00").toISOString()),
        observation("o2", local("09:09:00").toISOString()),
      ],
      buildResults: [
        { ok: false, errorMessage: "provider failed" },
        { ok: true, block: { id: "timeline-stable" } },
      ],
    });
    const due = new Date(local("09:13:00").getTime() + TIMELINE_SEAL_GRACE_MS);
    await harness.coordinator.advance(due);
    const id = [...harness.windows.keys()][0];
    expect(harness.windows.get(id)).toMatchObject({ status: "failed", timelineBlockId: null });
    await harness.coordinator.advance(due);
    expect(harness.windows.get(id)).toMatchObject({ status: "succeeded", timelineBlockId: "timeline-stable" });
    expect(harness.buildWindow).toHaveBeenCalledTimes(2);
    expect(harness.windows).toHaveLength(1);
  });

  it("persists an eligible shutdown tail without calling the model", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local("09:09:00").toISOString()),
    ] });

    await harness.coordinator.persistTailForShutdown();

    expect([...harness.windows.values()][0]).toMatchObject({
      status: "ready",
      closeReason: "shutdown",
      actualStart: local("09:03:00").toISOString(),
      actualEnd: local("09:09:00").toISOString(),
    });
    expect(harness.buildWindow).not.toHaveBeenCalled();
  });

  it("keeps the natural ten-minute boundary when recovering across midnight", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", local("09:03:00").toISOString()),
      observation("o2", local("09:09:00").toISOString()),
    ] });
    await harness.coordinator.advance(local("09:04:00"));
    await harness.coordinator.advance(new Date("2026-07-24T00:01:00+08:00"));

    expect([...harness.windows.values()][0]).toMatchObject({
      collectionEnd: local("09:13:00").toISOString(),
      closeReason: "day_rollover",
      status: "succeeded",
    });
  });

  it("force-seals a rolled-over window whose watermark never settles", async () => {
    // 复现线上死锁：跨天窗口里有 batch 永远算不上终态，unsettledCount 归不了零。
    // 旧实现会在 sealing 上原地打转，把 48 次循环耗光，今天的窗口永远开不出来。
    const harness = makeHarness({
      observations: [
        observation("o1", local("09:03:00").toISOString()),
        observation("o2", local("09:09:00").toISOString()),
        observation("o3", new Date("2026-07-24T09:03:00+08:00").toISOString()),
      ],
      watermark: { totalCount: 3, unsettledCount: 1, failedCount: 0, batchIds: ["b1"] },
    });
    await harness.coordinator.advance(local("09:04:00"));
    expect([...harness.windows.values()][0]).toMatchObject({ status: "collecting" });

    await harness.coordinator.advance(new Date("2026-07-24T09:04:00+08:00"));

    const windows = [...harness.windows.values()];
    // 跨天那一格被强制封窗并标成 partial，而不是卡在 sealing。
    expect(windows[0]).toMatchObject({
      dateKey: "2026-07-23",
      closeReason: "day_rollover",
      status: "succeeded",
      sourceCompleteness: "partial",
    });
    // 关键断言：新的一天必须能开出窗口。
    expect(windows[1]).toMatchObject({ dateKey: "2026-07-24", status: "collecting" });
  });

  it("does not spin when a rolled-over window cannot leave sealing", async () => {
    const harness = makeHarness({
      observations: [observation("o1", local("09:03:00").toISOString())],
      watermark: { totalCount: 1, unsettledCount: 1, failedCount: 0, batchIds: ["b1"] },
    });
    await harness.coordinator.advance(local("09:04:00"));
    const id = [...harness.windows.keys()][0];
    // 模拟封窗完全推不动：任何写入都不改变状态。
    harness.windowRepo.update.mockImplementation((windowId: string) => harness.windows.get(windowId)!);
    harness.windows.set(id, { ...harness.windows.get(id)!, status: "sealing" });

    await harness.coordinator.advance(new Date("2026-07-24T09:04:00+08:00"));

    // 一轮推进只应尝试一次，不能在同一个窗口上反复 drain 48 次。
    expect(harness.drainThroughCapturedAt).toHaveBeenCalledTimes(1);
  });

  it("blocks report generation when the eligible tail still fails after retry", async () => {
    const harness = makeHarness({
      observations: [
        observation("o1", local("09:03:00").toISOString()),
        observation("o2", local("09:09:00").toISOString()),
      ],
      buildResults: [
        { ok: false, errorMessage: "provider failed" },
        { ok: false, errorMessage: "provider failed" },
      ],
    });

    await expect(harness.coordinator.preflightReport("2026-07-23"))
      .rejects.toThrow("provider failed");
    expect(harness.buildWindow).toHaveBeenCalledTimes(2);
    expect([...harness.windows.values()][0]).toMatchObject({ status: "failed", closeReason: "report" });
  });
});
