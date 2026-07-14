import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { shouldRetryMemorySearchExpansion } from "./memorySearchHandlers";

describe("memory search expansion fallback", () => {
  it.each(["invalid_json", "schema_invalid", "unknown_error"])("retries %s without response_format", (errorCode) => {
    expect(shouldRetryMemorySearchExpansion({ ok: false, errorCode })).toBe(true);
  });

  it("retries when JSON repair itself fails with HTTP 500", () => {
    expect(shouldRetryMemorySearchExpansion({
      ok: false,
      errorCode: "network_error",
      errorMessage: "repair 调用失败: 服务端错误 (HTTP 500): Internal server error",
    })).toBe(true);
  });

  it("does not reinterpret ordinary network failures as JSON fallback", () => {
    expect(shouldRetryMemorySearchExpansion({
      ok: false,
      errorCode: "network_error",
      errorMessage: "服务端错误 (HTTP 500)",
    })).toBe(false);
    expect(shouldRetryMemorySearchExpansion({ ok: true })).toBe(false);
  });
});
