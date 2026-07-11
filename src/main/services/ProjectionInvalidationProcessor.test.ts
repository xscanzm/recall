import { describe, expect, it, vi } from "vitest";
import type { ProjectionInvalidation } from "../db/repositories/CorrectionLifecycleRepository";
import { ProjectionInvalidationProcessor } from "./ProjectionInvalidationProcessor";

function item(projectionType: ProjectionInvalidation["projectionType"], targetType: "fact" | "scene" = "fact"): ProjectionInvalidation {
  return {
    id: `inv-${projectionType}`,
    projectionType,
    targetType,
    targetId: targetType === "fact" ? "fact-1" : "scene-1",
    reason: "correction:content_wrong",
    status: "processing",
    createdAt: "2026-07-10T00:00:00.000Z",
    processedAt: null,
    lastError: null,
  };
}

function setup(items: ProjectionInvalidation[]) {
  let claimed = false;
  const scene = {
    id: "scene-1", startAt: "2026-07-10T23:00:00", endAt: "2026-07-11T01:00:00",
    factIds: ["fact-1"], deletedAt: null,
  };
  const deps = {
    correctionLifecycleRepo: {
      claimPending: vi.fn(() => claimed ? [] : (claimed = true, items)),
      markCompleted: vi.fn(), markFailed: vi.fn(), listRevisions: vi.fn(() => []),
    },
    factRepo: { getById: vi.fn(() => ({ id: "fact-1", createdAt: "2026-07-10T12:00:00", sourceEpisodeIds: [] })) },
    sceneRepo: { listByFactId: vi.fn(() => [scene]), listByIds: vi.fn(() => []), getById: vi.fn(() => scene) },
    timelineBlockRepo: {},
    reportRepo: {
      findReportsReferencingFact: vi.fn(() => [{ id: "report-fact" }]),
      findReportsReferencingScene: vi.fn(() => [{ id: "report-scene" }]),
      markStaleMany: vi.fn(),
    },
    timelineBuilderWorker: {
      reorganizeDay: vi.fn(async (_date: string): Promise<{ ok: boolean; errorMessage?: string }> => ({ ok: true })),
    },
    sceneRelationProjector: { projectScene: vi.fn() },
  };
  return { deps, processor: new ProjectionInvalidationProcessor(deps as never) };
}

describe("ProjectionInvalidationProcessor", () => {
  it("reorganizes every local date without deleting blocks first", async () => {
    const { deps, processor } = setup([item("timeline")]);
    await processor.processPending();

    expect(deps.timelineBuilderWorker.reorganizeDay.mock.calls.map(([date]) => date)).toEqual(["2026-07-10", "2026-07-11"]);
    expect(deps.correctionLifecycleRepo.markCompleted).toHaveBeenCalledWith("inv-timeline");
  });

  it("marks direct fact and affected scene reports stale without duplicates", async () => {
    const { deps, processor } = setup([item("report")]);
    await processor.processPending();

    expect(deps.reportRepo.markStaleMany).toHaveBeenCalledWith(
      ["report-fact", "report-scene"], "correction:content_wrong"
    );
  });

  it("projects affected active scenes and completes synchronous search", async () => {
    const { deps, processor } = setup([item("l3"), item("search")]);
    await processor.processPending();

    expect(deps.sceneRelationProjector.projectScene).toHaveBeenCalledTimes(1);
    expect(deps.correctionLifecycleRepo.markCompleted).toHaveBeenCalledTimes(2);
  });

  it("marks a failed timeline rebuild failed and continues", async () => {
    const { deps, processor } = setup([item("timeline"), item("search")]);
    deps.timelineBuilderWorker.reorganizeDay.mockResolvedValue({ ok: false, errorMessage: "model unavailable" });
    await processor.processPending();

    expect(deps.correctionLifecycleRepo.markFailed).toHaveBeenCalledWith("inv-timeline", "model unavailable");
    expect(deps.correctionLifecycleRepo.markCompleted).toHaveBeenCalledWith("inv-search");
  });
});
