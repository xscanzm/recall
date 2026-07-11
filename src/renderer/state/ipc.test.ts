import { describe, expect, it } from "vitest";
import { unwrapList, unwrapOptional } from "./ipc";

describe("Today IPC result unwrapping", () => {
  it("surfaces IPC failures", () => {
    const failure = { ok: false as const, error: "database unavailable", code: "unknown_error" };
    expect(() => unwrapList(failure)).toThrow("database unavailable");
    expect(() => unwrapOptional(failure)).toThrow("database unavailable");
  });

  it("keeps successful empty results distinct from failures", () => {
    expect(unwrapList({ ok: true, data: [] })).toEqual([]);
    expect(unwrapOptional({ ok: true, data: null })).toBeUndefined();
  });
});
