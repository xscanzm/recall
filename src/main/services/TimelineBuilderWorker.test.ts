import { describe, expect, it, vi } from "vitest";
import { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import type { Fact, Observation, Scene, TimelineBuilderOutput } from "../models/types";

const observation = (id: string, capturedAt: string) => ({
  id,
  capturedAt,
  appName: "Editor",
  windowTitle: "Recall",
  sceneSummary: id,
} as Observation);

const card = (patch: Partial<TimelineBuilderOutput> = {}): TimelineBuilderOutput => ({
  title: "整理窗口调度",
  summary: "完成时间轴窗口调度方案的实现。",
  category: "coding",
  projectNames: ["Recall"],
  highlights: [],
  generatedTasks: [],
  generatedDecisions: [],
  reportable: true,
  privateRisk: "low",
  privateRiskReason: "",
  confidence: 0.9,
  ...patch,
});

function makeHarness(input: {
  output?: TimelineBuilderOutput;
  observations?: Observation[];
  facts?: Fact[];
  scenes?: Scene[];
  failed?: boolean;
}) {
  const observations = input.observations ?? [];
  const facts = input.facts ?? [];
  const scenes = input.scenes ?? [];
  const callByConfigId = vi.fn(async () => ({
    ok: true,
    data: input.output ?? card(),
    modelJobId: "job-1",
    attempts: 1,
  }));
  const enqueueMultimodalJob = vi.fn(async (job) => input.failed
    ? { ok: false, errorCode: "provider_failed", errorMessage: "failed" }
    : job.executor());
  const replaceWindowAndCheckpoint = vi.fn((request) => request.blocks.map((block: object) => ({
    ...block,
    id: (block as { id?: string }).id || "timeline-1",
  })));
  const worker = new TimelineBuilderWorker({
    modelGateway: {
      resolveConfigId: vi.fn(async () => "model-1"),
      callByConfigId,
    } as never,
    modelJobQueue: { enqueueMultimodalJob } as never,
    observationRepo: {
      listByCapturedAt: vi.fn((query) => observations
        .filter((value) => value.capturedAt >= query.from && value.capturedAt < query.to)
        .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt))),
    } as never,
    factRepo: {
      listBySourceObservationIds: vi.fn(() => facts),
      listBySourceEpisodeIds: vi.fn(() => facts),
    } as never,
    sceneRepo: { listByObservationIds: vi.fn(() => scenes) } as never,
    timelineBlockRepo: { replaceWindowAndCheckpoint } as never,
  });
  return { worker, callByConfigId, enqueueMultimodalJob, replaceWindowAndCheckpoint };
}

describe("TimelineBuilderWorker explicit window", () => {
  it("persists exactly one card with backend-owned time and every valid source", async () => {
    const observations = [
      observation("o1", "2026-07-23T01:03:00.000Z"),
      observation("o2", "2026-07-23T01:06:00.000Z"),
      observation("o3", "2026-07-23T01:11:00.000Z"),
    ];
    const scenes = [{
      id: "episode-1",
      observationIds: ["o1", "o2", "o3"],
      projectId: "project-1",
      startAt: observations[0].capturedAt,
      endAt: observations[2].capturedAt,
      factIds: [],
      entityNames: [],
    }] as unknown as Scene[];
    const facts = [{
      id: "fact-1",
      projectId: "project-1",
      createdAt: "2026-07-23T01:15:00.000Z",
      sourceObservationIds: ["o2"],
      sourceEpisodeIds: ["episode-1"],
    }] as Fact[];
    const harness = makeHarness({ observations, scenes, facts });

    const result = await harness.worker.buildWindow({
      dateKey: "2026-07-23",
      collectionStart: "2026-07-23T01:03:00.000Z",
      collectionEnd: "2026-07-23T01:13:00.000Z",
      sourceCompleteness: "complete",
    });

    expect(result.ok).toBe(true);
    expect(result.block).toMatchObject({
      id: "timeline-1",
      startAt: "2026-07-23T01:03:00.000Z",
      endAt: "2026-07-23T01:11:00.000Z",
      sourceObservationIds: ["o1", "o2", "o3"],
      sourceSceneIds: ["episode-1"],
      sourceFactIds: ["fact-1"],
      projectIds: ["project-1"],
      sourceCompleteness: "complete",
    });
    expect(harness.replaceWindowAndCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("uses date and collection bounds as the model dedupe key", async () => {
    const harness = makeHarness({ observations: [
      observation("o1", "2026-07-23T01:03:00.000Z"),
      observation("o2", "2026-07-23T01:08:00.000Z"),
    ] });
    await harness.worker.buildWindow({
      dateKey: "2026-07-23",
      collectionStart: "2026-07-23T01:03:00.000Z",
      collectionEnd: "2026-07-23T01:13:00.000Z",
      sourceCompleteness: "partial",
      existingTimelineBlockId: "timeline-existing",
    });
    expect(harness.enqueueMultimodalJob).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: "timeline_builder:2026-07-23:2026-07-23T01:03:00.000Z:2026-07-23T01:13:00.000Z",
    }));
    expect(harness.replaceWindowAndCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      blocks: [expect.objectContaining({ id: "timeline-existing", sourceCompleteness: "partial" })],
    }));
  });

  it("does not persist or consume the window when the model fails", async () => {
    const harness = makeHarness({
      observations: [observation("o1", "2026-07-23T01:03:00.000Z")],
      failed: true,
    });
    const result = await harness.worker.buildWindow({
      dateKey: "2026-07-23",
      collectionStart: "2026-07-23T01:03:00.000Z",
      collectionEnd: "2026-07-23T01:13:00.000Z",
      sourceCompleteness: "complete",
    });
    expect(result).toMatchObject({ ok: false, errorCode: "provider_failed" });
    expect(harness.replaceWindowAndCheckpoint).not.toHaveBeenCalled();
  });
});
