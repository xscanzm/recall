// src/renderer/state/searchDataActions.test.ts
// todo 13：搜索乱序竞态守卫——慢的旧响应（成功或失败）后到不得覆盖新结果。
// 用 mock IPC + 手动控制的 deferred promise 模拟"后发起先返回、先发起后返回"。
import { describe, expect, it, vi } from "vitest";
import type { SearchResultItem } from "./store";

const memoryMock = vi.hoisted(() => ({
  search: vi.fn(),
  expandSearch: vi.fn(),
}));

vi.mock("./ipc", () => ({
  getIpc: () => ({ memory: memoryMock }),
}));

import { expandSearchAction, searchMemoryAction } from "./searchDataActions";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type SearchResponse = {
  results: SearchResultItem[];
  total: number;
  quality: "strong" | "weak" | "none";
  queryTerms: string[];
};

type ExpandResponse = {
  ok: boolean;
  results?: SearchResultItem[];
  total?: number;
  quality?: "strong" | "weak" | "none";
  expandedTerms?: string[];
  message?: string;
};

const item = (id: string): SearchResultItem => ({
  id,
  type: "fact",
  title: `结果 ${id}`,
  createdAt: "2026-07-01T00:00:00Z",
  matchReasons: [],
  sourceCount: 0,
});

/** 简易 setState mock：把 partial（或 updater）合并进 state 记录。 */
function createSetMock() {
  const state: Record<string, unknown> = {};
  const set = (partial: unknown): void => {
    if (typeof partial === "function") {
      Object.assign(state, (partial as (s: unknown) => unknown)(state));
    } else {
      Object.assign(state, partial as Record<string, unknown>);
    }
  };
  return { state, set: set as unknown as Parameters<typeof searchMemoryAction>[0] };
}

describe("searchMemoryAction 乱序守卫", () => {
  it("慢的旧查询响应后到不覆盖新查询结果", async () => {
    const { state, set } = createSetMock();
    const a = deferred<SearchResponse>();
    const b = deferred<SearchResponse>();
    vi.mocked(memoryMock.search)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = searchMemoryAction(set, "alpha");
    const p2 = searchMemoryAction(set, "beta");
    // 后发起的查询先返回
    b.resolve({ results: [item("B")], total: 1, quality: "strong", queryTerms: ["beta"] });
    await p2;
    // 先发起的旧查询后返回 → 必须被丢弃
    a.resolve({ results: [item("A")], total: 1, quality: "weak", queryTerms: ["alpha"] });
    await p1;

    expect(state.searchResults).toEqual([item("B")]);
    expect(state.searchTotal).toBe(1);
    expect(state.searchQuery).toBe("beta");
    expect(state.searchLoading).toBe(false);
  });

  it("慢的旧查询失败后到不写入错误", async () => {
    const { state, set } = createSetMock();
    const a = deferred<SearchResponse>();
    const b = deferred<SearchResponse>();
    vi.mocked(memoryMock.search)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = searchMemoryAction(set, "alpha");
    const p2 = searchMemoryAction(set, "beta");
    b.resolve({ results: [item("B")], total: 1, quality: "strong", queryTerms: ["beta"] });
    await p2;
    a.reject(new Error("stale failure"));
    await p1;

    expect(state.searchError).toBeNull();
    expect(state.searchResults).toEqual([item("B")]);
    expect(state.searchLoading).toBe(false);
  });

  it("最新查询失败仍写入错误", async () => {
    const { state, set } = createSetMock();
    const a = deferred<SearchResponse>();
    vi.mocked(memoryMock.search).mockReturnValueOnce(a.promise);

    const p1 = searchMemoryAction(set, "alpha");
    a.reject(new Error("real failure"));
    await p1;

    expect(state.searchError).toBe("real failure");
    expect(state.searchLoading).toBe(false);
  });
});

describe("expandSearchAction 乱序守卫", () => {
  it("慢的旧 expand 响应后到不覆盖新 expand 结果", async () => {
    const { state, set } = createSetMock();
    const a = deferred<ExpandResponse>();
    const b = deferred<ExpandResponse>();
    vi.mocked(memoryMock.expandSearch)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = expandSearchAction(set, "alpha");
    const p2 = expandSearchAction(set, "beta");
    b.resolve({ ok: true, results: [item("B")], total: 1, quality: "strong", expandedTerms: ["b1"] });
    await p2;
    a.resolve({ ok: true, results: [item("A")], total: 1, quality: "weak", expandedTerms: ["a1"] });
    await p1;

    expect(state.searchResults).toEqual([item("B")]);
    expect(state.searchExpandedTerms).toEqual(["b1"]);
    expect(state.searchExpandLoading).toBe(false);
  });

  it("慢的旧 expand 失败响应后到不写入错误", async () => {
    const { state, set } = createSetMock();
    const a = deferred<ExpandResponse>();
    const b = deferred<ExpandResponse>();
    vi.mocked(memoryMock.expandSearch)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = expandSearchAction(set, "alpha");
    const p2 = expandSearchAction(set, "beta");
    b.resolve({ ok: true, results: [item("B")], total: 1, quality: "strong", expandedTerms: ["b1"] });
    await p2;
    a.resolve({ ok: false, message: "stale expand failure" });
    await p1;

    expect(state.searchExpandError).toBeNull();
    expect(state.searchResults).toEqual([item("B")]);
  });
});

describe("searchMemoryAction 与 expandSearchAction 跨动作乱序守卫", () => {
  it("慢的旧查询响应在 expand 之后返回时被丢弃", async () => {
    const { state, set } = createSetMock();
    const a = deferred<SearchResponse>();
    const b = deferred<ExpandResponse>();
    vi.mocked(memoryMock.search).mockReturnValueOnce(a.promise);
    vi.mocked(memoryMock.expandSearch).mockReturnValueOnce(b.promise);

    const p1 = searchMemoryAction(set, "alpha");
    const p2 = expandSearchAction(set, "alpha");
    b.resolve({ ok: true, results: [item("B")], total: 1, quality: "strong", expandedTerms: ["b1"] });
    await p2;
    a.resolve({ results: [item("A")], total: 1, quality: "weak", queryTerms: ["alpha"] });
    await p1;

    expect(state.searchResults).toEqual([item("B")]);
    expect(state.searchExpandLoading).toBe(false);
  });
});
