import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { RecallApi } from "../preload";
import { ipcContracts, type IpcRequest, type IpcResponse } from "../../shared/ipcContracts";
import { handleValidated } from "./validated";
import { invokeValidated } from "./invokeValidated";

describe("IPC contracts", () => {
  it("applies request defaults and rejects malformed values", () => {
    expect(ipcContracts["memory:search"].request.parse({ query: "recall" })).toEqual({ query: "recall", limit: 50, offset: 0 });
    expect(() => ipcContracts["workReport:generate"].request.parse({ dateKey: "bad", selectedBlockIds: [], style: "brief" })).toThrow();
    expect(() => ipcContracts["timeline:get"].response.parse({ ok: true, data: [{ id: "incomplete" }] })).toThrow();
  });

  it("validates handler input and output with a stable error code", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    handleValidated(ipc as never, "memory:search", () => ({ results: [], total: 0 }));
    await expect(registered!(undefined as never, { query: "" })).rejects.toMatchObject({ code: "schema_invalid" });

    handleValidated(ipc as never, "memory:search", () => ({ results: [], total: -1 }));
    await expect(registered!(undefined as never, { query: "valid" })).rejects.toMatchObject({ code: "schema_invalid" });
  });

  it("validates preload invocations in both directions", async () => {
    const ipc = { invoke: vi.fn(async () => ({ results: [], total: 0 })) };
    await expect(invokeValidated(ipc as never, "memory:search", { query: "recall" })).resolves.toEqual({ results: [], total: 0 });
    expect(ipc.invoke).toHaveBeenCalledWith("memory:search", { query: "recall", limit: 50, offset: 0 });
    ipc.invoke.mockResolvedValueOnce({ results: [], total: -1 });
    await expect(invokeValidated(ipc as never, "memory:search", { query: "recall" })).rejects.toThrow();
  });

  it("derives preload signatures from the shared contract", () => {
    expectTypeOf<Parameters<RecallApi["memory"]["search"]>[0]>().toEqualTypeOf<IpcRequest<"memory:search">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["memory"]["search"]>>>().toEqualTypeOf<IpcResponse<"memory:search">>();
    expectTypeOf<Parameters<RecallApi["workReport"]["generate"]>[0]>().toEqualTypeOf<IpcRequest<"workReport:generate">>();
  });

  it("covers lifecycle, launch, export, and report schema boundaries", () => {
    expect(ipcContracts["capture:forgetRecent"].request.parse({ duration: "today" })).toEqual({ duration: "today" });
    expect(() => ipcContracts["capture:forgetRecent"].request.parse({ duration: "2h" })).toThrow();
    expect(ipcContracts["app:setLaunchAtLogin"].response.parse({ ok: true, enabled: false })).toEqual({ ok: true, enabled: false });
    expect(ipcContracts["data:export"].request.parse(undefined)).toEqual({});
    expect(() => ipcContracts["data:export"].response.parse({ ok: true, export: { meta: { counts: { facts: -1 } } } })).toThrow();
    expect(() => ipcContracts["workReport:generate"].request.parse({ dateKey: "2026-02-30", selectedBlockIds: [], style: "casual" })).toThrow();
  });
});
