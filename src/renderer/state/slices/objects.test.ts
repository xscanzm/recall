// src/renderer/state/slices/objects.test.ts
// todo 13：项目详情加载乱序竞态守卫——慢的旧响应（成功或失败）后到不得覆盖新项目。
// 走真实 zustand store（mock IPC），通过 useAppStore 观察状态。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail, ProjectItem } from "../types";

const memoryMock = vi.hoisted(() => ({
  getProjectDetail: vi.fn(),
}));

vi.mock("../ipc", () => ({
  getIpc: () => ({ memory: memoryMock }),
}));

import { useAppStore } from "../store";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function projectDetail(id: string): ProjectDetail {
  return {
    project: { id, name: `项目 ${id}` } as ProjectItem,
    facts: [],
    scenes: [],
    tasks: [],
    decisions: [],
    people: [],
    recentReports: [],
  };
}

describe("loadProjectDetail 乱序守卫", () => {
  beforeEach(() => {
    useAppStore.setState({
      projectDetail: null,
      projectDetailLoading: false,
      projectDetailError: null,
    });
    memoryMock.getProjectDetail.mockReset();
  });

  it("慢的旧项目详情响应后到不覆盖新项目", async () => {
    const a = deferred<ProjectDetail>();
    const b = deferred<ProjectDetail>();
    vi.mocked(memoryMock.getProjectDetail)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = useAppStore.getState().loadProjectDetail("proj-A");
    const p2 = useAppStore.getState().loadProjectDetail("proj-B");
    // 后打开的项目先返回
    b.resolve(projectDetail("proj-B"));
    await p2;
    // 先打开的旧项目后返回 → 必须被丢弃
    a.resolve(projectDetail("proj-A"));
    await p1;

    const state = useAppStore.getState();
    expect(state.projectDetail?.project.id).toBe("proj-B");
    expect(state.projectDetailLoading).toBe(false);
    expect(state.projectDetailError).toBeNull();
  });

  it("慢的旧请求失败后到不写入错误", async () => {
    const a = deferred<ProjectDetail>();
    const b = deferred<ProjectDetail>();
    vi.mocked(memoryMock.getProjectDetail)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    const p1 = useAppStore.getState().loadProjectDetail("proj-A");
    const p2 = useAppStore.getState().loadProjectDetail("proj-B");
    b.resolve(projectDetail("proj-B"));
    await p2;
    a.reject(new Error("stale failure"));
    await p1;

    const state = useAppStore.getState();
    expect(state.projectDetail?.project.id).toBe("proj-B");
    expect(state.projectDetailError).toBeNull();
    expect(state.projectDetailLoading).toBe(false);
  });

  it("最新请求失败仍写入错误", async () => {
    const a = deferred<ProjectDetail>();
    vi.mocked(memoryMock.getProjectDetail).mockReturnValueOnce(a.promise);

    const p1 = useAppStore.getState().loadProjectDetail("proj-A");
    a.reject(new Error("real failure"));
    await p1;

    const state = useAppStore.getState();
    expect(state.projectDetailError).toBe("real failure");
    expect(state.projectDetailLoading).toBe(false);
  });
});
