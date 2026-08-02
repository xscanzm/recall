// src/main/services/ModelJobRetentionService.test.ts
// model_jobs 调试载荷自动清理调度服务单测（todo 8）
//
// 约定：better-sqlite3 原生模块按 Electron 版本编译，无法在纯 node 的 vitest 中加载，
// 因此沿用 DataLifecycleService.test.ts 的 mock-db 惯例——mock 的 run() 按本服务的
// SQL 语义（terminal 状态 + created_at < cutoff → 两列置 NULL）模拟行级效果，
// 同时用精确 SQL 断言锁定真实语句不得漂移。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_JOB_DEBUG_RETENTION_DAYS,
  MODEL_JOB_DEBUG_RETENTION_DAYS_ENV,
  MODEL_JOB_RETENTION_INTERVAL_MS,
  ModelJobRetentionService,
  resolveModelJobDebugRetentionDays,
} from "./ModelJobRetentionService";

interface SimRow {
  id: string;
  status: string;
  createdAt: string;
  rawInputJson: string | null;
  debugEventsJson: string | null;
  outputJson: string | null;
}

/** 按本服务 SQL 语义模拟的 db：terminal 状态且 created_at < cutoff 的行两列置 NULL */
function createSimulatedDb(rows: SimRow[]) {
  const statements: string[] = [];
  const runCalls: unknown[][] = [];
  const prepare = vi.fn((sql: string) => {
    statements.push(sql);
    return {
      run: vi.fn((...params: unknown[]) => {
        runCalls.push(params);
        const cutoff = params[0] as string;
        let changes = 0;
        for (const row of rows) {
          const terminal = row.status === "succeeded" || row.status === "failed";
          if (terminal && row.createdAt < cutoff && (row.rawInputJson !== null || row.debugEventsJson !== null)) {
            row.rawInputJson = null;
            row.debugEventsJson = null;
            changes++;
          }
        }
        return { changes };
      }),
    };
  });
  return { db: { prepare }, rows, statements, runCalls };
}

const daysAgoIso = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

const EXPECTED_SQL =
  "UPDATE model_jobs SET raw_input_json = NULL, debug_events_json = NULL " +
  "WHERE status IN ('succeeded', 'failed') AND created_at < ?";

const normalizeSql = (sql: string): string => sql.replace(/\s+/g, " ").trim();

function terminalRow(id: string, createdAtIso: string): SimRow {
  return {
    id,
    status: "succeeded",
    createdAt: createdAtIso,
    rawInputJson: `{"prompt":"${id}"}`,
    debugEventsJson: "[]",
    outputJson: `{"ok":true,"id":"${id}"}`,
  };
}

describe("ModelJobRetentionService.runOnce", () => {
  it("clears debug payloads only on terminal model_jobs older than the retention window", () => {
    const old31 = daysAgoIso(31);
    const recent10 = daysAgoIso(10);
    const old40 = daysAgoIso(40);
    const { db, rows, statements, runCalls } = createSimulatedDb([
      terminalRow("job-old", old31),
      terminalRow("job-recent", recent10),
      { id: "job-running", status: "running", createdAt: daysAgoIso(31), rawInputJson: "x", debugEventsJson: "[]", outputJson: null },
      { id: "job-failed-old", status: "failed", createdAt: old40, rawInputJson: "y", debugEventsJson: "[]", outputJson: null },
    ]);

    const service = new ModelJobRetentionService({ db: db as never }, 30);
    const cleared = service.runOnce();

    // 精确 SQL：只 SET 两个调试列、只匹配 terminal 状态、只按 created_at 兜底过滤
    expect(normalizeSql(statements[0])).toBe(EXPECTED_SQL);
    // cutoff = now - 30 天，作为唯一绑定参数
    expect(runCalls[0]).toHaveLength(1);
    const cutoff = runCalls[0][0] as string;
    expect(cutoff > daysAgoIso(31)).toBe(true);
    expect(cutoff < daysAgoIso(29)).toBe(true);

    // 仅 31 天前的 succeeded 行与 40 天前的 failed 行被清空（failed 走 created_at 兜底）
    expect(cleared).toBe(2);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["job-old"].rawInputJson).toBeNull();
    expect(byId["job-old"].debugEventsJson).toBeNull();
    expect(byId["job-failed-old"].rawInputJson).toBeNull();
    expect(byId["job-failed-old"].debugEventsJson).toBeNull();
    // 10 天内的行与 running 行不被触碰
    expect(byId["job-recent"].rawInputJson).toBe(`{"prompt":"job-recent"}`);
    expect(byId["job-recent"].debugEventsJson).toBe("[]");
    expect(byId["job-running"].rawInputJson).toBe("x");
    expect(byId["job-running"].debugEventsJson).toBe("[]");
    // 其余字段保留
    expect(byId["job-old"].outputJson).toBe(`{"ok":true,"id":"job-old"}`);
    expect(byId["job-old"].status).toBe("succeeded");
    expect(byId["job-old"].createdAt).toBe(old31);
  });

  it("is idempotent: a second run clears nothing and leaves rows unchanged", () => {
    const { db, rows, runCalls } = createSimulatedDb([
      terminalRow("job-old", daysAgoIso(31)),
      terminalRow("job-recent", daysAgoIso(10)),
    ]);
    const service = new ModelJobRetentionService({ db: db as never }, 30);

    const first = service.runOnce();
    const second = service.runOnce();

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(runCalls).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["job-old"].rawInputJson).toBeNull();
    expect(byId["job-old"].debugEventsJson).toBeNull();
    expect(byId["job-recent"].rawInputJson).toBe(`{"prompt":"job-recent"}`);
  });

  it("honors a custom retention window via constructor", () => {
    const { db, rows } = createSimulatedDb([
      terminalRow("job-2d", daysAgoIso(2)),
      terminalRow("job-12h", daysAgoIso(0.5)),
    ]);
    const service = new ModelJobRetentionService({ db: db as never }, 1);

    service.runOnce();

    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["job-2d"].rawInputJson).toBeNull();
    expect(byId["job-12h"].rawInputJson).toBe(`{"prompt":"job-12h"}`);
  });
});

describe("resolveModelJobDebugRetentionDays", () => {
  it("defaults to 30 days when the env var is absent", () => {
    expect(MODEL_JOB_DEBUG_RETENTION_DAYS).toBe(30);
    expect(resolveModelJobDebugRetentionDays({})).toBe(30);
  });

  it("reads the RECALL_MODEL_JOB_DEBUG_RETENTION_DAYS env override", () => {
    expect(
      resolveModelJobDebugRetentionDays({ [MODEL_JOB_DEBUG_RETENTION_DAYS_ENV]: "60" })
    ).toBe(60);
  });

  it("falls back to 30 for invalid or non-positive values", () => {
    expect(resolveModelJobDebugRetentionDays({ [MODEL_JOB_DEBUG_RETENTION_DAYS_ENV]: "abc" })).toBe(30);
    expect(resolveModelJobDebugRetentionDays({ [MODEL_JOB_DEBUG_RETENTION_DAYS_ENV]: "0" })).toBe(30);
    expect(resolveModelJobDebugRetentionDays({ [MODEL_JOB_DEBUG_RETENTION_DAYS_ENV]: "-5" })).toBe(30);
  });
});

describe("ModelJobRetentionService scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a daily timer and runs once on start", () => {
    const { db, runCalls } = createSimulatedDb([terminalRow("job-old", daysAgoIso(31))]);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const service = new ModelJobRetentionService({ db: db as never }, 30);

    service.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(MODEL_JOB_RETENTION_INTERVAL_MS);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(runCalls).toHaveLength(0); // 首次清理延迟到事件循环，不在 start() 内同步执行

    vi.advanceTimersByTime(0);
    expect(runCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1); // 仅剩每日 interval
  });

  it("is a no-op when already started", () => {
    const { db } = createSimulatedDb([]);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const service = new ModelJobRetentionService({ db: db as never }, 30);

    service.start();
    service.start();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the daily timer on stop and can be restarted", () => {
    const { db, runCalls } = createSimulatedDb([terminalRow("job-old", daysAgoIso(31))]);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const service = new ModelJobRetentionService({ db: db as never }, 30);

    service.start();
    const intervalHandle = vi.getTimerCount() > 0 ? null : null;
    void intervalHandle;
    service.stop();

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    service.start();
    vi.advanceTimersByTime(0);
    expect(runCalls).toHaveLength(1);
    service.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
