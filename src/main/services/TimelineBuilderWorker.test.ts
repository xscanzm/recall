import { beforeEach, describe, expect, it, vi } from "vitest";
import { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import type { Fact, Observation, Scene, TimelineBuilderOutput } from "../models/types";
import { localDateKeyUtcRange } from "../utils/dateKey";

const observation = (id: string, capturedAt: string) => ({
  id, capturedAt, appName: "Editor", windowTitle: "Recall", sceneSummary: id,
} as Observation);

const block = (sources: Partial<TimelineBuilderOutput["blocks"][number]> = {}) => ({
  startAt: "2099-01-01T00:00:00.000Z", endAt: "2099-01-01T01:00:00.000Z",
  title: "Work", summary: "Summary", category: "coding" as const,
  projectIds: [], projectNames: [], highlights: [], generatedTasks: [], generatedDecisions: [],
  reportable: true, privateRisk: "low" as const, privateRiskReason: "",
  sourceSceneIds: [], sourceFactIds: [], sourceObservationIds: [], confidence: 1, ...sources,
});

describe("TimelineBuilderWorker", () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date("2026-07-11T12:00:00.000Z")));

  function makeWorker(output: TimelineBuilderOutput | null, opts: {
    observations?: Observation[]; facts?: Fact[]; scenes?: Scene[]; checkpoint?: string | null;
    existing?: unknown[]; failed?: boolean; observationError?: Error;
  } = {}) {
    const replaceWindowAndCheckpoint = vi.fn((input) => input.blocks.map((value: object, index: number) => ({ ...value, id: `saved-${index}` })));
    const callMultimodal = vi.fn(async (_input: unknown, _schema: unknown) => ({
      ok: true,
      data: output,
      modelJobId: "job",
      attempts: 1,
    }));
    const enqueueMultimodalJob = vi.fn(async (input) => opts.failed
      ? { ok: false, errorCode: "failed", errorMessage: "failed" }
      : input.executor());
    const worker = new TimelineBuilderWorker({
      modelGateway: { callMultimodal } as never, modelJobQueue: { enqueueMultimodalJob } as never,
      observationRepo: { listByCapturedAt: vi.fn((query) => {
        if (opts.observationError) throw opts.observationError;
        const matches = [...(opts.observations ?? [])]
          .filter((value) => (!query.from || value.capturedAt >= query.from) && (!query.to || value.capturedAt < query.to))
          .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
        if (query.order === "desc") matches.reverse();
        return matches.slice(0, query.limit);
      }) } as never,
      factRepo: { listByCreatedAt: vi.fn(() => opts.facts ?? []) } as never,
      sceneRepo: { listByStartAt: vi.fn(() => [...(opts.scenes ?? [])]) } as never,
      timelineBlockRepo: { findOverlapping: vi.fn(() => opts.existing ?? []), replaceWindowAndCheckpoint } as never,
      timelineBuildCheckpointRepo: { get: vi.fn(() => opts.checkpoint ?? null) } as never,
      settingsService: { listMultimodalModelConfigs: vi.fn(() => [{ id: "model", enabled: true }]) } as never,
    });
    return { worker, callMultimodal, enqueueMultimodalJob, replaceWindowAndCheckpoint };
  }

  it("uses a 10 minute maturity boundary and includes the preceding 30 minute mutable tail", async () => {
    const obs = observation("o1", "2026-07-11T11:45:00.000Z");
    const setup = makeWorker({ dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "", blocks: [block({ sourceObservationIds: ["o1"] })] }, {
      observations: [obs], checkpoint: "2026-07-11T11:40:00.000Z",
    });
    await setup.worker.buildTimeline("2026-07-11");
    expect(setup.replaceWindowAndCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      windowStart: "2026-07-11T11:10:00.000Z", windowEnd: "2026-07-11T11:50:00.000Z",
      processedThrough: "2026-07-11T11:50:00.000Z",
    }));
  });

  it("ignores model ids and times and resolves direct, scene, fact, and episode sources", async () => {
    const observations = [observation("o1", "2026-07-11T08:30:00.000Z"), observation("o2", "2026-07-11T08:10:00.000Z"), observation("o3", "2026-07-11T08:50:00.000Z")];
    const scenes = [{ id: "s1", observationIds: ["o2"], startAt: "x", endAt: "x" }, { id: "episode1", observationIds: ["o3"], startAt: "x", endAt: "x" }] as Scene[];
    const facts = [{ id: "f1", createdAt: "2026-07-11T09:00:00.000Z", sourceObservationIds: ["o1"], sourceEpisodeIds: ["episode1"] }] as Fact[];
    const output = { dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "", blocks: [block({ id: "model-id", sourceObservationIds: ["o1", "invented"], sourceSceneIds: ["s1"], sourceFactIds: ["f1"] })] };
    const setup = makeWorker(output, { observations, facts, scenes, checkpoint: "2026-07-11T08:00:00.000Z" });
    const result = await setup.worker.buildTimeline("2026-07-11");
    expect(result.blocks[0]).toMatchObject({ id: "saved-0", startAt: "2026-07-11T08:10:00.000Z", endAt: "2026-07-11T08:50:00.000Z", sourceObservationIds: ["o1", "o2", "o3"] });
  });

  it.each(["empty", "invalid", "failed"])("does not advance checkpoint for %s model output", async (kind) => {
    const obs = observation("o1", "2026-07-11T08:30:00.000Z");
    const output = kind === "empty" ? { dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "", blocks: [] }
      : { dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "", blocks: [block({ sourceObservationIds: ["invented"] })] };
    const setup = makeWorker(output, {
      observations: [obs],
      failed: kind === "failed",
      checkpoint: "2026-07-11T08:00:00.000Z",
    });
    const result = await setup.worker.buildTimeline("2026-07-11");
    expect(result.ok).toBe(false);
    expect(setup.replaceWindowAndCheckpoint).not.toHaveBeenCalled();
  });

  it("does not treat repository failures as empty windows", async () => {
    const setup = makeWorker(null, { observationError: new Error("database locked") });
    const result = await setup.worker.buildTimeline("2026-07-11");
    expect(result).toMatchObject({ ok: false, errorCode: "timeline_data_error" });
    expect(setup.enqueueMultimodalJob).not.toHaveBeenCalled();
    expect(setup.replaceWindowAndCheckpoint).not.toHaveBeenCalled();
  });

  it("keeps bounded tail context and still advances through dense new observations", async () => {
    const tail = Array.from({ length: 80 }, (_, index) =>
      observation(`tail-${index}`, new Date(Date.parse("2026-07-11T11:10:00.000Z") + index * 10_000).toISOString())
    );
    const forward = Array.from({ length: 100 }, (_, index) =>
      observation(`new-${index}`, new Date(Date.parse("2026-07-11T11:40:00.000Z") + index * 1_000).toISOString())
    );
    const output = {
      dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "",
      blocks: [block({ sourceObservationIds: ["new-0"] })],
    };
    const setup = makeWorker(output, {
      observations: [...tail, ...forward],
      checkpoint: "2026-07-11T11:40:00.000Z",
    });
    const result = await setup.worker.buildTimeline("2026-07-11");
    expect(result.ok).toBe(true);
    const persistedThrough = setup.replaceWindowAndCheckpoint.mock.calls[0][0].processedThrough;
    expect(Date.parse(persistedThrough)).toBeGreaterThan(Date.parse("2026-07-11T11:40:00.000Z"));
  });

  it("uses the 500k context budget and allows up to 65,536 output tokens", async () => {
    const obs = observation("o1", "2026-07-11T11:45:00.000Z");
    const output = {
      dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "",
      blocks: [block({ sourceObservationIds: ["o1"] })],
    };
    const setup = makeWorker(output, {
      observations: [obs],
      checkpoint: "2026-07-11T11:40:00.000Z",
    });

    await setup.worker.buildTimeline("2026-07-11");

    expect(setup.callMultimodal).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 65_536 }),
      expect.anything()
    );
    const modelInput = setup.callMultimodal.mock.calls[0]?.[0] as { jobInputJson: string };
    const jobInput = JSON.parse(modelInput.jobInputJson);
    expect(jobInput).toMatchObject({
      contextTokens: 500_000,
      maxOutputTokens: 65_536,
    });
    expect(jobInput.inputTokensEstimate).toBeLessThanOrEqual(420_000);
  });

  it("rejects a single source item beyond the 420k estimated input budget", async () => {
    const obs = observation("o1", "2026-07-11T11:45:00.000Z");
    obs.sceneSummary = "中".repeat(220_000);
    const setup = makeWorker(null, {
      observations: [obs],
      checkpoint: "2026-07-11T11:40:00.000Z",
    });

    const result = await setup.worker.buildTimeline("2026-07-11");

    expect(result).toMatchObject({ ok: false, errorCode: "timeline_input_too_large" });
    expect(setup.callMultimodal).not.toHaveBeenCalled();
    expect(setup.replaceWindowAndCheckpoint).not.toHaveBeenCalled();
  });

  it("advances without a model call when the window has no source data", async () => {
    const existing = [{ id: "old", sourceObservationIds: ["o-old"] }];
    const setup = makeWorker(null, { checkpoint: "2026-07-11T11:00:00.000Z", existing });
    const result = await setup.worker.buildTimeline("2026-07-11");
    expect(result.ok).toBe(true);
    expect(setup.enqueueMultimodalJob).not.toHaveBeenCalled();
    expect(setup.replaceWindowAndCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ blocks: existing, processedThrough: "2026-07-11T11:50:00.000Z" }));
  });

  it("force-finalizes through now while full-day reorganization starts at local midnight", async () => {
    const obs = observation("o1", "2026-07-11T11:59:00.000Z");
    const output = { dateKey: "2026-07-11", dayStartSummary: "", dayMainThread: "", blocks: [block({ sourceObservationIds: ["o1"] })] };
    const forced = makeWorker(output, { observations: [obs], checkpoint: "2026-07-11T11:50:00.000Z" });
    await forced.worker.buildTimeline("2026-07-11", "forceFinalizeTail");
    expect(forced.replaceWindowAndCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ windowEnd: "2026-07-11T12:00:00.000Z" }));
    const reorganized = makeWorker(output, { observations: [obs], checkpoint: "2026-07-11T11:50:00.000Z" });
    await reorganized.worker.reorganizeDay("2026-07-11");
    expect(reorganized.replaceWindowAndCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      windowStart: localDateKeyUtcRange("2026-07-11").start,
    }));
  });
});
