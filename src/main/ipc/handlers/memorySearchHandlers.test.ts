import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { ipcMain } from "electron";
import { MemoryAskOutputSchema } from "../../models/schemas";
import type { IpcDeps } from "../handlers";
import { registerMemorySearchHandlers, shouldRetryMemorySearchExpansion } from "./memorySearchHandlers";

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("memory AI requests", () => {
  it("uses the shared model output budget instead of a memory-specific token cap", async () => {
    const callByConfigId = vi.fn().mockResolvedValue({
      ok: true,
      data: { answer: "总结内容", sourceIds: ["fact-1"] },
    });
    const deps = {
      memorySearchRepo: {
        getCandidates: vi.fn().mockReturnValue([{
          id: "fact-1",
          type: "fact",
          title: "事实标题",
          summary: "事实摘要",
          createdAt: "2026-07-27T10:00:00.000Z",
        }]),
        getDetail: vi.fn().mockReturnValue({ contentSections: [], sources: [] }),
      },
      modelGateway: {
        resolveConfigId: vi.fn().mockResolvedValue("text-model"),
        callByConfigId,
      },
    } as unknown as IpcDeps;

    registerMemorySearchHandlers(deps);
    const registered = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "memory:ask");
    expect(registered).toBeDefined();

    const result = await registered![1]({} as never, {
      mode: "summary",
      candidates: [{ id: "fact-1", type: "fact" }],
    });

    expect(result).toMatchObject({ ok: true, answer: "总结内容" });
    expect(callByConfigId).toHaveBeenCalledWith(expect.any(Object), MemoryAskOutputSchema);
    expect(callByConfigId.mock.calls[0][0]).not.toHaveProperty("maxTokens");
  });

  it("proves memory:search handler delegates to hybridSearchService when available", async () => {
    const searchMock = vi.fn().mockResolvedValue({
      results: [{
        id: "fact-hybrid",
        type: "fact",
        title: "Hybrid Hit",
        summary: "摘要",
        createdAt: "2026-07-28T00:00:00.000Z",
        relevance: 5.0,
        matchReasons: ["semantic_similarity"],
        sourceCount: 1,
      }],
      total: 1,
      quality: "strong",
      queryTerms: ["测试"],
    });

    const deps = {
      hybridSearchService: {
        search: searchMock,
      },
    } as unknown as IpcDeps;

    registerMemorySearchHandlers(deps);
    const registered = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === "memory:search");
    expect(registered).toBeDefined();

    const res = await registered![1]({} as never, { query: "测试查询", limit: 10, offset: 0, filters: {} });
    expect(res).toMatchObject({ total: 1, quality: "strong" });
    expect(searchMock).toHaveBeenCalledWith("测试查询", 10, 0, {});
  });
});
