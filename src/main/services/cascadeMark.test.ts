import { describe, expect, it, vi } from "vitest";
import { applyCorrection, cascadeMarkAfterFactSceneDelete } from "./cascadeMark";

describe("cascadeMarkAfterFactSceneDelete", () => {
  it("removes multi-source people links and rejects stale edges", () => {
    const removeFactFromSourceLinks = vi.fn();
    const updateStatusByNode = vi.fn();
    const db = {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() => sql.includes("FROM people")
          ? [{ id: "person-1", source_fact_ids_json: '["fact-1","fact-2"]' }]
          : []),
      })),
    };
    cascadeMarkAfterFactSceneDelete({
      db: db as never,
      memoryObjectRepo: {
        findOrphansByFactId: vi.fn(() => []),
        removeFactFromSourceLinks,
      } as never,
      memoryEdgeRepo: { updateStatusByNode } as never,
    }, [{ id: "fact-1" } as never], []);

    expect(removeFactFromSourceLinks).toHaveBeenCalledWith("person", "person-1", "fact-1");
    expect(updateStatusByNode).toHaveBeenCalledWith("fact", "fact-1", "superseded", "source_deleted");
  });

  it("soft-deletes a person whose only supporting fact was removed", () => {
    const softDeletePerson = vi.fn();
    const updateStatusByNode = vi.fn();
    cascadeMarkAfterFactSceneDelete({
      memoryObjectRepo: {
        findOrphansByFactId: vi.fn(() => [{ type: "person", id: "person-1", sourceFactIds: ["fact-1"] }]),
        softDeletePerson,
      } as never,
      memoryEdgeRepo: { updateStatusByNode } as never,
    }, [{ id: "fact-1" } as never], []);

    expect(softDeletePerson).toHaveBeenCalledWith("person-1");
    expect(updateStatusByNode).toHaveBeenCalledWith("person", "person-1", "superseded", "source_deleted");
  });

  it("retracts deleted facts and enqueues all affected projections", () => {
    const update = vi.fn();
    const enqueue = vi.fn();
    cascadeMarkAfterFactSceneDelete({
      factRepo: { update } as never,
      correctionLifecycleRepo: { enqueue } as never,
    }, [{ id: "fact-1" } as never], []);

    expect(update).toHaveBeenCalledWith("fact-1", { claimStatus: "retracted" });
    expect(enqueue).toHaveBeenCalledWith(
      "fact", "fact-1", ["timeline", "report", "search", "l3"], "source_deleted"
    );
  });
});

describe("applyCorrection", () => {
  it("marks corrected fact content and enqueues projection invalidations", () => {
    const update = vi.fn();
    const enqueue = vi.fn();
    applyCorrection({
      factRepo: { update } as never,
      correctionLifecycleRepo: { enqueue } as never,
    }, "fact", "fact-1", "content_wrong", { content: "corrected" });

    expect(update).toHaveBeenCalledWith("fact-1", { content: "corrected", claimStatus: "corrected" });
    expect(enqueue).toHaveBeenCalledWith(
      "fact", "fact-1", ["timeline", "report", "search", "l3"], "correction:content_wrong"
    );
  });
});
