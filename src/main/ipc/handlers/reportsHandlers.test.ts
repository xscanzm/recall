import { beforeEach, describe, expect, it, vi } from "vitest";

type RegisteredHandler = (_event: object, input?: unknown) => unknown;

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, RegisteredHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      electronMock.handlers.set(channel, handler);
    }),
  },
}));

import type { IpcDeps } from "../handlers";
import { registerReportHandlers } from "./reportsHandlers";

function createDeps(overrides: Partial<IpcDeps>): IpcDeps {
  return {
    getStatus: () => {
      throw new Error("not used");
    },
    setStatus: () => undefined,
    subscribeStatus: () => () => undefined,
    getMainWindow: () => null,
    settingsService: {} as IpcDeps["settingsService"],
    modelGateway: {} as IpcDeps["modelGateway"],
    ...overrides,
  };
}

function serviceMock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

function getHandler(channel: string): RegisteredHandler {
  const handler = electronMock.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return handler;
}

describe("report IPC handlers", () => {
  beforeEach(() => {
    electronMock.handlers.clear();
  });

  it("preserves the loose list filter and clamps its limit", () => {
    const list = vi.fn(() => []);
    registerReportHandlers(createDeps({
      reportRepo: serviceMock<NonNullable<IpcDeps["reportRepo"]>>({ list }),
    }));

    getHandler("reports:list")({}, {
      type: "daily",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      limit: 999,
      ignored: true,
    });

    expect(list).toHaveBeenCalledWith({
      type: "daily",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      limit: 200,
    });
  });

  it("keeps the monthly report project association side effect", async () => {
    const update = vi.fn();
    const generateMonthlyReportNow = vi.fn(async () => ({ ok: true, reportId: "report-1" }));
    registerReportHandlers(createDeps({
      reportRepo: serviceMock<NonNullable<IpcDeps["reportRepo"]>>({ update }),
      reportScheduler: serviceMock<NonNullable<IpcDeps["reportScheduler"]>>({
        generateMonthlyReportNow,
      }),
    }));

    const result = await getHandler("reports:generate")({}, {
      type: "monthly",
      dateKey: "2026-07-22",
      projectId: "project-1",
      generationRequirement: "重点关注风险",
    });

    expect(generateMonthlyReportNow).toHaveBeenCalledWith("2026-07", "重点关注风险");
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith("report-1", {
      type: "monthly",
      projectId: "project-1",
    });
    expect(result).toEqual({ ok: true, reportId: "report-1" });
  });

  it("rejects invalid edited report JSON with the original error code", () => {
    registerReportHandlers(createDeps({
      reportRepo: serviceMock<NonNullable<IpcDeps["reportRepo"]>>({ update: vi.fn() }),
    }));

    expect(() => getHandler("reports:update")({}, {
      id: "report-1",
      contentJson: "not-json",
    })).toThrow(expect.objectContaining({
      code: "schema_invalid",
      message: "reports:update contentJson 不是合法 JSON",
    }));
  });
});
