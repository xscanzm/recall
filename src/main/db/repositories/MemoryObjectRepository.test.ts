import { describe, expect, it, vi } from "vitest";
import { MemoryObjectRepository } from "./MemoryObjectRepository";

describe("MemoryObjectRepository minimal project lookup", () => {
  it("chunks large ID sets below SQLite's host-parameter limit and preserves order", () => {
    const all = vi.fn((...ids: string[]) => ids.map((id) => ({ id, name: `Project ${id}` })));
    const prepare = vi.fn(() => ({ all }));
    const repository = new MemoryObjectRepository({ prepare } as never);
    const ids = [...Array.from({ length: 1001 }, (_, index) => `project-${index}`), "project-0"];

    const projects = repository.listProjectsByIdsMinimal(ids);

    expect(prepare).toHaveBeenCalledTimes(3);
    expect(all.mock.calls.map((call) => call.length)).toEqual([500, 500, 1]);
    expect(projects).toHaveLength(1001);
    expect(projects[0].id).toBe("project-0");
    expect(projects.at(-1)?.id).toBe("project-1000");
  });
});
