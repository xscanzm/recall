// src/main/ipc/handlers.deleteObject.test.ts
// P1 (plan todo 9): memory:deleteObject 级联删除事务化
//
// 验证目标：
// 1. soft delete + cascadeMark 整体包进 deps.db.transaction 同步体；
// 2. 事务体收到的是同步函数（better-sqlite3 transaction 只接受同步函数，
//    传 async 函数会提前提交、永不回滚、测试假绿）；
// 3. 级联失败 → 整个事务回滚 + 结构化错误（带 code），不再吞错返回成功；
// 4. deleteImage（异步副作用）在事务提交之后执行，绝不在事务内触发。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: vi.fn(() => "C:\\test"), quit: vi.fn(), getVersion: vi.fn(() => "0.0.0-test") },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { ipcMain } from "electron";
import type { IpcDeps } from "./handlers";
import { registerIpcHandlers } from "./handlers";
import { addTrustedWebContents, resetTrustedWebContents } from "./trustedWebContents";

const TRUSTED_SENDER_ID = 3001;
const mainFrame = {};

function trustedEvent(): { sender: { id: number; mainFrame: object }; senderFrame: object } {
  return { sender: { id: TRUSTED_SENDER_ID, mainFrame }, senderFrame: mainFrame };
}

interface TxHarness {
  db: { transaction: (fn: unknown) => () => unknown; prepare: (sql: string) => { all: () => unknown[] } };
  log: string[];
  rollbacks: number;
  insideTx: () => boolean;
}

/**
 * 模拟 better-sqlite3 事务语义：
 * - transaction(fn) 返回一个可调用函数（同一函数可多次调用，异常后回滚并重抛）；
 * - 断言传入的是同步函数（constructor.name === "Function"；async 为 "AsyncFunction"）；
 * - 记录 begin/commit/rollback 顺序，供 deleteImage 排序断言使用。
 */
function makeTxDb(): TxHarness {
  const log: string[] = [];
  let depth = 0;
  let rollbacks = 0;
  const db = {
    prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
    transaction: (fn: unknown) => {
      // 关键约束：better-sqlite3 transaction 只接受同步函数
      expect(typeof fn).toBe("function");
      expect((fn as () => unknown).constructor.name).toBe("Function");
      return () => {
        depth += 1;
        log.push("tx:begin");
        try {
          const result = (fn as () => unknown)();
          log.push("tx:commit");
          return result;
        } catch (err) {
          rollbacks += 1;
          log.push("tx:rollback");
          throw err;
        } finally {
          depth -= 1;
        }
      };
    },
  };
  return { db, log, get rollbacks() { return rollbacks; }, insideTx: () => depth > 0 };
}

function buildDeps(): {
  deps: IpcDeps;
  tx: TxHarness;
  deleteImage: ReturnType<typeof vi.fn>;
  mocks: {
    factRepo: { softDelete: ReturnType<typeof vi.fn>; getByIdActive: ReturnType<typeof vi.fn> };
    reportRepo: { markStaleMany: ReturnType<typeof vi.fn>; findReportsReferencingFact: ReturnType<typeof vi.fn> };
    memoryObjectRepo: Record<string, ReturnType<typeof vi.fn>>;
  };
} {
  const tx = makeTxDb();
  const deleteImage = vi.fn(async (_reportId: string) => {
    // deleteImage 是异步副作用：绝不允许在事务开启期间执行
    expect(tx.insideTx()).toBe(false);
    tx.log.push("deleteImage");
  });
  const mocks = {
    factRepo: {
      getByIdActive: vi.fn().mockReturnValue({ id: "fact-1", type: "fact" }),
      softDelete: vi.fn().mockReturnValue(true),
      update: vi.fn(),
    },
    sceneRepo: {
      getByIdActive: vi.fn().mockReturnValue(null),
      softDelete: vi.fn().mockReturnValue(true),
    },
    memoryObjectRepo: {
      softDeleteTask: vi.fn().mockReturnValue(true),
      softDeletePerson: vi.fn().mockReturnValue(true),
      softDeleteDecision: vi.fn().mockReturnValue(true),
      archiveProject: vi.fn().mockReturnValue(true),
      findOrphansByFactId: vi.fn().mockReturnValue([]),
      removeFactFromSourceLinks: vi.fn(),
      markOrphaned: vi.fn(),
    },
    reportRepo: {
      findReportsReferencingFact: vi.fn().mockReturnValue([{ id: "report-1" }]),
      findReportsReferencingScene: vi.fn().mockReturnValue([]),
      markStaleMany: vi.fn(),
    },
  };
  const deps = {
    db: tx.db,
    factRepo: mocks.factRepo,
    sceneRepo: mocks.sceneRepo,
    memoryObjectRepo: mocks.memoryObjectRepo,
    reportRepo: mocks.reportRepo,
    correctionLifecycleRepo: { enqueue: vi.fn() },
    memoryEdgeRepo: { updateStatusByNode: vi.fn() },
    infographicService: { deleteImage },
  } as unknown as IpcDeps;
  return { deps, tx, deleteImage, mocks };
}

function registerAndGetHandler(deps: IpcDeps) {
  registerIpcHandlers(deps);
  const registered = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === "memory:deleteObject");
  expect(registered).toBeDefined();
  return registered![1] as (event: unknown, input: unknown) => unknown;
}

function captureError(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTrustedWebContents();
  addTrustedWebContents(TRUSTED_SENDER_ID);
});

describe("memory:deleteObject transaction wrapper", () => {
  it("deletes a fact inside a sync transaction and returns ok", () => {
    const { deps, tx, deleteImage } = buildDeps();
    const handler = registerAndGetHandler(deps);

    const result = handler(trustedEvent(), { id: "fact-1", type: "fact" });

    expect(result).toEqual({ ok: true });
    expect(deps.factRepo!.softDelete).toHaveBeenCalledWith("fact-1");
    expect(deps.reportRepo!.markStaleMany).toHaveBeenCalledWith(["report-1"], "source_deleted");
    // deleteImage 在 tx:commit 之后执行（不在事务内）
    expect(tx.log).toEqual(["tx:begin", "tx:commit", "deleteImage"]);
    expect(deleteImage).toHaveBeenCalledWith("report-1");
  });

  it("passes a synchronous (non-async) function to db.transaction", () => {
    const { deps, tx } = buildDeps();
    const handler = registerAndGetHandler(deps);

    handler(trustedEvent(), { id: "task-1", type: "task" });

    // makeTxDb 在注册时断言 fn.constructor.name === "Function"（async 为 "AsyncFunction"）
    expect(tx.log).toEqual(["tx:begin", "tx:commit"]);
    expect(deps.memoryObjectRepo!.softDeleteTask).toHaveBeenCalledWith("task-1");
  });

  it("rolls back the whole transaction and throws a structured error when cascade fails", () => {
    const { deps, tx, mocks } = buildDeps();
    mocks.reportRepo.markStaleMany.mockImplementation(() => {
      throw new Error("cascade boom");
    });
    const handler = registerAndGetHandler(deps);

    const err = captureError(() => handler(trustedEvent(), { id: "fact-1", type: "fact" }));

    expect(err).not.toBeNull();
    expect((err as Error & { code?: string }).code).toBe("delete_cascade_failed");
    expect((err as Error).message).toContain("cascade boom");
    expect(tx.rollbacks).toBe(1);
    expect(tx.log).toEqual(["tx:begin", "tx:rollback"]);
    // 级联失败 → 未提交 → deleteImage 不应被触发
    expect(deps.infographicService!.deleteImage).not.toHaveBeenCalled();
  });

  it("rolls back and reports not_found when the object is missing", () => {
    const { deps, tx, mocks } = buildDeps();
    mocks.factRepo.softDelete.mockReturnValue(false);
    const handler = registerAndGetHandler(deps);

    const err = captureError(() => handler(trustedEvent(), { id: "fact-1", type: "fact" }));

    expect((err as Error & { code?: string }).code).toBe("not_found");
    expect(tx.rollbacks).toBe(1);
  });

  it("fails with not_ready when db is unavailable", () => {
    const { deps } = buildDeps();
    (deps as { db?: unknown }).db = undefined;
    const handler = registerAndGetHandler(deps);

    const err = captureError(() => handler(trustedEvent(), { id: "fact-1", type: "fact" }));

    expect((err as Error & { code?: string }).code).toBe("not_ready");
  });

  it("deletes task/person/decision/project without cascade or deleteImage", () => {
    const { deps, tx, deleteImage } = buildDeps();
    const handler = registerAndGetHandler(deps);

    expect(handler(trustedEvent(), { id: "task-1", type: "task" })).toEqual({ ok: true });
    expect(handler(trustedEvent(), { id: "person-1", type: "person" })).toEqual({ ok: true });
    expect(handler(trustedEvent(), { id: "decision-1", type: "decision" })).toEqual({ ok: true });
    expect(handler(trustedEvent(), { id: "project-1", type: "project" })).toEqual({ ok: true });

    expect(deps.memoryObjectRepo!.softDeleteTask).toHaveBeenCalledWith("task-1");
    expect(deps.memoryObjectRepo!.softDeletePerson).toHaveBeenCalledWith("person-1");
    expect(deps.memoryObjectRepo!.softDeleteDecision).toHaveBeenCalledWith("decision-1");
    expect(deps.memoryObjectRepo!.archiveProject).toHaveBeenCalledWith("project-1");
    expect(tx.rollbacks).toBe(0);
    expect(deleteImage).not.toHaveBeenCalled();
  });
});
