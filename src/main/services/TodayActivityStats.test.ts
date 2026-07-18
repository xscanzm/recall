import { describe, expect, it } from "vitest";
import {
  buildTodayActivityOverview,
  calculateTodayActivityStats,
} from "./TodayActivityStats";

const options = {
  coverageEnd: new Date("2026-07-17T09:11:00+08:00"),
  maxGapSeconds: 180,
};

function episode(overrides: Record<string, unknown> = {}) {
  return {
    id: "episode-1",
    title: "修复 Recall",
    summary: "修复今日页活动数据",
    startAt: "2026-07-17T09:00:00+08:00",
    endAt: "2026-07-17T09:02:00+08:00",
    projectId: "project-1",
    factIds: ["fact-1"],
    observationIds: ["obs-1", "obs-2"],
    activityCategory: "coding" as const,
    activityConfidence: 0.9,
    ...overrides,
  };
}

describe("Today activity overview", () => {
  it("counts L0 coverage while taking categories from Episodes", () => {
    const stats = calculateTodayActivityStats(
      [
        { id: "obs-1", capturedAt: "2026-07-17T09:00:00+08:00" },
        { id: "obs-2", capturedAt: "2026-07-17T09:01:00+08:00" },
        { id: "obs-3", capturedAt: "2026-07-17T09:02:00+08:00" },
        { id: "obs-4", capturedAt: "2026-07-17T09:10:00+08:00" },
      ],
      [
        episode(),
        episode({
          id: "episode-2",
          observationIds: ["obs-4"],
          activityCategory: "admin",
        }),
      ],
      options
    );

    expect(stats).toEqual({
      totalObservedMinutes: 6,
      categorizedMinutes: { coding: 2, admin: 1 },
      pendingMinutes: 3,
      sampleCount: 4,
    });
  });

  it("keeps unclassified Episodes in pending coverage", () => {
    const stats = calculateTodayActivityStats(
      [{ id: "obs-1", capturedAt: "2026-07-17T09:00:00+08:00" }],
      [episode({ activityCategory: "unknown" })],
      { ...options, coverageEnd: new Date("2026-07-17T09:01:00+08:00") }
    );

    expect(stats.categorizedMinutes).toEqual({});
    expect(stats.pendingMinutes).toBe(1);
  });

  it("marks observations assigned to conflicting Episode categories as mixed", () => {
    const stats = calculateTodayActivityStats(
      [{ id: "obs-1", capturedAt: "2026-07-17T09:00:00+08:00" }],
      [
        episode({ observationIds: ["obs-1"] }),
        episode({ id: "episode-2", observationIds: ["obs-1"], activityCategory: "communication" }),
      ],
      { ...options, coverageEnd: new Date("2026-07-17T09:01:00+08:00") }
    );

    expect(stats.categorizedMinutes).toEqual({ mixed: 1 });
  });

  it("builds rhythm bounds and topic enrichment without timeline blocks", () => {
    const overview = buildTodayActivityOverview(
      [
        { id: "obs-1", capturedAt: "2026-07-17T09:00:00+08:00" },
        { id: "obs-2", capturedAt: "2026-07-17T09:01:00+08:00" },
      ],
      [episode()],
      [{
        id: "fact-1",
        content: "完成 Episode 活动分类",
        projectId: "project-1",
        projectHint: "旧项目提示",
        privateRisk: "low",
        sourceObservationIds: ["obs-1"],
        sourceEpisodeIds: ["episode-1"],
      }],
      [{ id: "project-1", name: "回声 Recall" }],
      { ...options, coverageEnd: new Date("2026-07-17T09:02:00+08:00") }
    );

    expect(overview.episodes[0]).toMatchObject({
      id: "episode-1",
      category: "coding",
      endAt: "2026-07-17T01:02:00.000Z",
      projectNames: ["回声 Recall"],
      topicTexts: ["完成 Episode 活动分类"],
    });
    expect(overview.observedStartAt).toBe("2026-07-17T01:00:00.000Z");
    expect(overview.observedEndAt).toBe("2026-07-17T01:02:00.000Z");
    expect(overview.windows).toHaveLength(1);
  });

  it("merges adjacent same-context Episodes while preserving long gaps", () => {
    const overview = buildTodayActivityOverview(
      [
        { id: "obs-1", capturedAt: "2026-07-17T09:00:00+08:00" },
        { id: "obs-2", capturedAt: "2026-07-17T09:02:00+08:00" },
        { id: "obs-3", capturedAt: "2026-07-17T09:06:00+08:00" },
        { id: "obs-4", capturedAt: "2026-07-17T09:30:00+08:00" },
      ],
      [
        episode(),
        episode({ id: "episode-2", observationIds: ["obs-3"], factIds: [] }),
        episode({ id: "episode-3", observationIds: ["obs-4"], factIds: [] }),
      ],
      [],
      [{ id: "project-1", name: "回声 Recall" }],
      { ...options, coverageEnd: new Date("2026-07-17T09:31:00+08:00") }
    );

    expect(overview.windows).toHaveLength(2);
    expect(overview.windows[0]).toMatchObject({
      sourceEpisodeIds: ["episode-1", "episode-2"],
      startAt: "2026-07-17T01:00:00.000Z",
      endAt: "2026-07-17T01:09:00.000Z",
    });
    expect(overview.windows[1]).toMatchObject({
      sourceEpisodeIds: ["episode-3"],
      startAt: "2026-07-17T01:30:00.000Z",
      endAt: "2026-07-17T01:31:00.000Z",
    });
  });

  it("returns an empty result without observations", () => {
    expect(calculateTodayActivityStats([], [], options)).toEqual({
      totalObservedMinutes: 0,
      categorizedMinutes: {},
      pendingMinutes: 0,
      sampleCount: 0,
    });
    const overview = buildTodayActivityOverview([], [], [], [], options);
    expect(overview.observedStartAt).toBeNull();
    expect(overview.observedEndAt).toBeNull();
    expect(overview.windows).toEqual([]);
  });
});
