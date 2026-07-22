import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { loadDayActivityOverview } from "./activityHandlers";

describe("activity day overview loading", () => {
  it("loads more than 1500 scenes without a query limit and includes observation-linked facts", () => {
    const observations = Array.from({ length: 1501 }, (_, index) => ({
      id: `obs-${index}`,
      capturedAt: new Date(Date.UTC(2026, 6, 17, 1, 0, index)).toISOString(),
    }));
    const episodes = observations.map((observation, index) => ({
      id: `episode-${index}`,
      title: `Episode ${index}`,
      summary: "summary",
      startAt: observation.capturedAt,
      endAt: new Date(Date.parse(observation.capturedAt) + 1000).toISOString(),
      projectId: null,
      activityCategory: "coding" as const,
      activityConfidence: 0.9,
      factIds: [],
      observationIds: [observation.id],
    }));
    const listByStartAtMinimal = vi.fn(() => episodes);
    const listBySourceObservationIds = vi.fn(() => [{
      id: "fact-observation-only",
      content: "Observation-only fact",
      projectId: null,
      projectHint: null,
      privateRisk: "low" as const,
      sourceObservationIds: ["obs-1500"],
      sourceEpisodeIds: [],
    }]);

    const overview = loadDayActivityOverview({
      observationRepo: { listTimeRangeMinimal: vi.fn(() => observations) } as never,
      sceneRepo: { listByStartAtMinimal } as never,
      factRepo: {
        listByIds: vi.fn(() => []),
        listBySourceEpisodeIds: vi.fn(() => []),
        listBySourceObservationIds,
      } as never,
      memoryObjectRepo: { listProjectsByIdsMinimal: vi.fn(() => []) } as never,
      settingsService: {
        getAll: vi.fn(() => ({ observation: { idleThresholdSeconds: 180 } })),
      } as never,
    }, "2026-07-17");

    expect(listByStartAtMinimal).toHaveBeenCalledWith(expect.not.objectContaining({ limit: expect.anything() }));
    expect(listBySourceObservationIds).toHaveBeenCalledWith(observations.map((item) => item.id));
    expect(overview.episodes).toHaveLength(1501);
    expect(overview.episodes.at(-1)?.topicTexts).toEqual(["Observation-only fact"]);
  });
});
