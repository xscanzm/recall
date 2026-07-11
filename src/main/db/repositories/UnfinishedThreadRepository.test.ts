import { describe, expect, it, vi } from "vitest";
import { UnfinishedThreadRepository } from "./UnfinishedThreadRepository";

describe("UnfinishedThreadRepository", () => {
  it("filters by date and status together", () => {
    const all = vi.fn().mockReturnValue([]);
    const prepare = vi.fn().mockReturnValue({ all });
    const repo = new UnfinishedThreadRepository({ prepare } as never);

    expect(repo.findByDateKeyAndStatus("2026-07-10", "open")).toEqual([]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("date_key = ? AND status = ?"));
    expect(all).toHaveBeenCalledWith("2026-07-10", "open");
  });
});
