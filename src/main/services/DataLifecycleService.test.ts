import { describe, expect, it, vi } from "vitest";
import { DataLifecycleService } from "./DataLifecycleService";

function setup(cascade: (facts: never[], scenes: never[]) => void = vi.fn()) {
  let observationCount = 1;
  const statements: string[] = [];
  const db = {
    transaction: (operation: () => void) => () => {
      const snapshot = observationCount;
      try { operation(); } catch (error) { observationCount = snapshot; throw error; }
    },
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      return { run: vi.fn(() => ({ changes: 1 })) };
    }),
  };
  const calls: string[] = [];
  const deps = {
    db,
    observationRepo: {
      listByCapturedAt: vi.fn(() => [{ id: "obs-1", screenshotPaths: ["p1", "p2"] }]),
      deleteByCapturedAt: vi.fn(() => { observationCount = 0; return 1; }),
      updateScreenshotRetention: vi.fn(),
    },
    factRepo: { softDeleteBySourceObservationIds: vi.fn(() => []) },
    sceneRepo: { softDeleteByObservationIds: vi.fn(() => []) },
    screenshotCache: {
      deleteFiles: vi.fn(async () => ({ deletedScreenshots: 1, attempted: 2, failed: 1 })),
      clearAll: vi.fn(async () => ({ deletedScreenshots: 2, attempted: 2, failed: 0 })),
    },
    captureService: { drain: vi.fn(async () => { calls.push("capture-drain"); }) },
    captureBatcher: {
      suspendAndFlush: vi.fn(async () => { calls.push("batch-flush"); }),
      resumeAccepting: vi.fn(() => { calls.push("accept"); }),
    },
    batchProcessor: { drain: vi.fn(async () => { calls.push("processor-drain"); }) },
    isObserving: vi.fn(() => true),
    pauseSources: vi.fn(() => { calls.push("pause"); }),
    resumeSources: vi.fn(() => { calls.push("resume"); }),
    cascade,
  };
  return { getObservationCount: () => observationCount, deps, calls, statements, service: new DataLifecycleService(deps as never) };
}

describe("DataLifecycleService", () => {
  it("drains before the transaction, reports partial cleanup, and restores observation", async () => {
    const { service, calls } = setup();
    const result = await service.forgetRecent("15m");
    expect(calls).toEqual(["pause", "capture-drain", "batch-flush", "processor-drain", "accept", "resume"]);
    expect(result.fileCleanup).toEqual({ status: "partial", attempted: 2, deleted: 1, failed: 1 });
  });

  it("rolls back all DB changes and still restores observation when cascade fails", async () => {
    const { service, getObservationCount, calls } = setup(() => { throw new Error("cascade failed"); });
    await expect(service.forgetRecent("15m")).rejects.toThrow("cascade failed");
    expect(getObservationCount()).toBe(1);
    expect(calls.slice(-2)).toEqual(["accept", "resume"]);
  });

  it("deletes matching durable capture inbox and batch records", async () => {
    const { service, statements } = setup();
    await service.forgetRecent("15m");
    expect(statements.some((sql) => sql.includes("DELETE FROM capture_inbox"))).toBe(true);
    expect(statements.some((sql) => sql.includes("DELETE FROM capture_batches"))).toBe(true);
    expect(statements.some((sql) => sql.includes("$.capturedAt"))).toBe(true);
  });

  it("clears feedback and model I/O while retaining settings tables", async () => {
    const { service, statements } = setup();
    await service.clearAll();
    expect(statements).toContain("DELETE FROM user_feedback");
    expect(statements).toContain("DELETE FROM model_jobs");
    expect(statements).not.toContain("DELETE FROM settings");
    expect(statements).not.toContain("DELETE FROM model_configs");
    expect(statements).not.toContain("DELETE FROM privacy_rules");
  });
});
