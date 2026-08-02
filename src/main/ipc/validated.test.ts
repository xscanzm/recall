import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { RecallApi } from "../preload";
import { ipcContracts, type IpcRequest, type IpcResponse } from "../../shared/ipcContracts";
import { handleValidated, isTrustedSender } from "./validated";
import { invokeValidated } from "./invokeValidated";
import { addTrustedWebContents, removeTrustedWebContents, resetTrustedWebContents } from "./trustedWebContents";

const memorySearchOk: (event: IpcMainInvokeEvent, input: IpcRequest<"memory:search">) => IpcResponse<"memory:search"> = () => ({
  results: [],
  total: 0,
  quality: "none",
  queryTerms: [],
});

describe("IPC contracts", () => {
  beforeEach(() => {
    resetTrustedWebContents();
    addTrustedWebContents(TRUSTED_SENDER_ID);
  });

  it("applies request defaults and rejects malformed values", () => {
    expect(ipcContracts["memory:search"].request.parse({ query: "recall" })).toEqual({ query: "recall", limit: 50, offset: 0, filters: {} });
    expect(ipcContracts["memory:ask"].request.parse({ mode: "summary", candidates: [{ id: "fact-1", type: "fact" }] })).toEqual({
      mode: "summary",
      candidates: [{ id: "fact-1", type: "fact" }],
    });
    expect(() => ipcContracts["memory:ask"].request.parse({ mode: "answer", candidates: [{ id: "fact-1", type: "fact" }] })).toThrow();
    expect(ipcContracts["memory:ask"].request.parse({ mode: "answer", question: "为什么这样决定？", candidates: [{ id: "fact-1", type: "fact" }] })).toMatchObject({
      mode: "answer",
      question: "为什么这样决定？",
    });
    expect(ipcContracts["memory:getDetail"].request.parse({ id: "block-1", type: "timeline" })).toEqual({ id: "block-1", type: "timeline" });
    expect(() => ipcContracts["workReport:generate"].request.parse({ dateKey: "bad", selectedBlockIds: [], style: "brief" })).toThrow();
    expect(() => ipcContracts["timeline:get"].response.parse({ ok: true, data: [{ id: "incomplete" }] })).toThrow();
  });

  it("validates handler input and output with a stable error code", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    handleValidated(ipc as never, "memory:search", () => ({ results: [], total: 0, quality: "none", queryTerms: [] }));
    await expect(registered!(trustedEvent() as never, { query: "" })).rejects.toMatchObject({ code: "schema_invalid" });

    handleValidated(ipc as never, "memory:search", () => ({ results: [], total: -1, quality: "none", queryTerms: [] }));
    await expect(registered!(trustedEvent() as never, { query: "valid" })).rejects.toMatchObject({ code: "schema_invalid" });
  });

  it("validates the optional work report generation requirement", () => {
    const valid = ipcContracts["workReport:generate"].request.parse({
      dateKey: "2026-07-17",
      selectedBlockIds: ["block_1"],
      style: "standard",
      generationRequirement: "本次突出风险",
    });
    expect(valid.generationRequirement).toBe("本次突出风险");

    expect(() => ipcContracts["workReport:generate"].request.parse({
      dateKey: "2026-07-17",
      selectedBlockIds: ["block_1"],
      style: "standard",
      generationRequirement: "x".repeat(2001),
    })).toThrow();
  });

  it("validates preload invocations in both directions", async () => {
    const ipc = { invoke: vi.fn(async () => ({ results: [], total: 0, quality: "none", queryTerms: [] })) };
    await expect(invokeValidated(ipc as never, "memory:search", { query: "recall" })).resolves.toEqual({ results: [], total: 0, quality: "none", queryTerms: [] });
    expect(ipc.invoke).toHaveBeenCalledWith("memory:search", { query: "recall", limit: 50, offset: 0, filters: {} });
    ipc.invoke.mockResolvedValueOnce({ results: [], total: -1, quality: "none", queryTerms: [] });
    await expect(invokeValidated(ipc as never, "memory:search", { query: "recall" })).rejects.toThrow();
  });

  it("derives preload signatures from the shared contract", () => {
    expectTypeOf<Parameters<RecallApi["memory"]["search"]>[0]>().toEqualTypeOf<IpcRequest<"memory:search">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["memory"]["search"]>>>().toEqualTypeOf<IpcResponse<"memory:search">>();
    expectTypeOf<Parameters<RecallApi["memory"]["getDetail"]>[0]>().toEqualTypeOf<IpcRequest<"memory:getDetail">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["memory"]["ask"]>>>().toEqualTypeOf<IpcResponse<"memory:ask">>();
    expectTypeOf<Parameters<RecallApi["workReport"]["generate"]>[0]>().toEqualTypeOf<IpcRequest<"workReport:generate">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["window"]["minimize"]>>>().toEqualTypeOf<IpcResponse<"window:minimize">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["window"]["toggleMaximize"]>>>().toEqualTypeOf<IpcResponse<"window:toggleMaximize">>();
    expectTypeOf<Parameters<RecallApi["window"]["drag"]>[0]>().toEqualTypeOf<IpcRequest<"window:drag">>();
    expectTypeOf<Awaited<ReturnType<RecallApi["activity"]["getDayOverview"]>>>().toEqualTypeOf<IpcResponse<"activity:getDayOverview">>();
  });

  it("covers lifecycle, launch, export, and report schema boundaries", () => {
    expect(ipcContracts["capture:forgetRecent"].request.parse({ duration: "today" })).toEqual({ duration: "today" });
    expect(() => ipcContracts["capture:forgetRecent"].request.parse({ duration: "2h" })).toThrow();
    expect(ipcContracts["app:setLaunchAtLogin"].response.parse({ ok: true, enabled: false })).toEqual({ ok: true, enabled: false });
    expect(ipcContracts["window:close"].response.parse({ ok: true })).toEqual({ ok: true });
    expect(ipcContracts["activity:getDayOverview"].response.parse({
      ok: true,
      data: {
        stats: {
          totalObservedMinutes: 120,
          categorizedMinutes: { coding: 40 },
          pendingMinutes: 80,
          sampleCount: 100,
        },
        episodes: [],
        windows: [],
        observedStartAt: null,
        observedEndAt: null,
      },
    })).toMatchObject({ ok: true, data: { stats: { totalObservedMinutes: 120 } } });
    expect(ipcContracts["data:export"].request.parse(undefined)).toEqual({});
    expect(() => ipcContracts["data:export"].response.parse({ ok: true, export: { meta: { counts: { facts: -1 } } } })).toThrow();
    expect(() => ipcContracts["workReport:generate"].request.parse({ dateKey: "2026-02-30", selectedBlockIds: [], style: "casual" })).toThrow();
  });
});

const TRUSTED_SENDER_ID = 1001;

/** 主 frame 的 mock：senderFrame 与 sender.mainFrame 是同一个对象引用（与 Electron 一致）。 */
function trustedEvent(): { sender: { id: number; mainFrame: object }; senderFrame: object } {
  const mainFrame = {};
  return { sender: { id: TRUSTED_SENDER_ID, mainFrame }, senderFrame: mainFrame };
}

describe("IPC sender validation (isTrustedSender)", () => {
  beforeEach(() => {
    resetTrustedWebContents();
    addTrustedWebContents(TRUSTED_SENDER_ID);
  });

  it("accepts a trusted main-frame sender", () => {
    expect(isTrustedSender(trustedEvent())).toBe(true);
  });

  it("rejects when senderFrame is null (destroyed/navigating window, fail closed)", () => {
    const event = { sender: { id: TRUSTED_SENDER_ID, mainFrame: {} }, senderFrame: null };
    expect(isTrustedSender(event)).toBe(false);
  });

  it("rejects when senderFrame is undefined or the event is null", () => {
    expect(isTrustedSender(undefined)).toBe(false);
    expect(isTrustedSender(null)).toBe(false);
  });

  it("rejects a child frame even from a trusted webContents", () => {
    const mainFrame = {};
    const event = { sender: { id: TRUSTED_SENDER_ID, mainFrame }, senderFrame: {} };
    expect(isTrustedSender(event)).toBe(false);
  });

  it("rejects a sender whose webContents id is not in the trusted set (fail closed)", () => {
    const event = { sender: { id: 9999, mainFrame: {} }, senderFrame: {} };
    expect(isTrustedSender(event)).toBe(false);
  });

  it("rejects after the webContents id has been removed from the registry", () => {
    removeTrustedWebContents(TRUSTED_SENDER_ID);
    expect(isTrustedSender(trustedEvent())).toBe(false);
  });
});

describe("handleValidated sender gate", () => {
  beforeEach(() => {
    resetTrustedWebContents();
    addTrustedWebContents(TRUSTED_SENDER_ID);
  });

  it("runs the handler for a trusted main-frame sender", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    const handler = vi.fn(memorySearchOk);
    handleValidated(ipc as never, "memory:search", handler);
    await expect(registered!(trustedEvent() as never, { query: "recall" })).resolves.toEqual({
      results: [],
      total: 0,
      quality: "none",
      queryTerms: [],
    });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects with untrusted_sender when the webContents is not trusted", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    const handler = vi.fn(memorySearchOk);
    handleValidated(ipc as never, "memory:search", handler);
    const untrusted = { sender: { id: 42, mainFrame: {} }, senderFrame: {} };
    await expect(registered!(untrusted as never, { query: "recall" })).rejects.toMatchObject({ code: "untrusted_sender" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects with untrusted_sender on a null senderFrame (fail closed)", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    const handler = vi.fn(memorySearchOk);
    handleValidated(ipc as never, "memory:search", handler);
    const nullFrame = { sender: { id: TRUSTED_SENDER_ID, mainFrame: {} }, senderFrame: null };
    await expect(registered!(nullFrame as never, { query: "recall" })).rejects.toMatchObject({ code: "untrusted_sender" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects with untrusted_sender from a child frame even when trusted", async () => {
    let registered: ((event: never, input: unknown) => Promise<unknown>) | undefined;
    const ipc = { removeHandler: vi.fn(), handle: vi.fn((_channel, handler) => { registered = handler; }) };
    const handler = vi.fn(memorySearchOk);
    handleValidated(ipc as never, "memory:search", handler);
    const mainFrame = {};
    const childFrame = { sender: { id: TRUSTED_SENDER_ID, mainFrame }, senderFrame: {} };
    await expect(registered!(childFrame as never, { query: "recall" })).rejects.toMatchObject({ code: "untrusted_sender" });
    expect(handler).not.toHaveBeenCalled();
  });
});
