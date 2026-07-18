import { describe, expect, it } from "vitest";
import type { TodayActivityEpisode, TodayActivityWindow } from "../../../shared/types";
import {
  buildAttentionSegmentsFromStats,
  buildRhythmRoutePath,
  buildRhythmSegments,
  buildRhythmTimeMarkers,
  buildTodayWords,
  formatVisualizationDuration,
} from "./todayVisualization";

function episode(overrides: Partial<TodayActivityEpisode> = {}): TodayActivityEpisode {
  return {
    id: "episode-1",
    startAt: "2026-07-17T09:00:00+08:00",
    endAt: "2026-07-17T10:00:00+08:00",
    title: "修复 Recall 时间轴渲染问题",
    summary: "",
    category: "coding",
    categoryConfidence: 0.9,
    sourceObservationIds: ["obs-1"],
    projectNames: ["回声 Recall"],
    topicTexts: ["完成词云交互设计"],
    ...overrides,
  };
}

function activityWindow(overrides: Partial<TodayActivityWindow> = {}): TodayActivityWindow {
  return {
    id: "activity-window:episode-1",
    startAt: "2026-07-17T09:00:00+08:00",
    endAt: "2026-07-17T10:00:00+08:00",
    title: "修复 Recall 时间轴渲染问题",
    summary: "",
    category: "coding",
    categoryConfidence: 0.9,
    sourceEpisodeIds: ["episode-1"],
    sourceObservationIds: ["obs-1"],
    projectNames: ["回声 Recall"],
    topicTexts: ["完成词云交互设计"],
    ...overrides,
  };
}

describe("today visualization data", () => {
  it("renders attention from L0 coverage categorized by Episodes", () => {
    const segments = buildAttentionSegmentsFromStats({
      totalObservedMinutes: 90,
      categorizedMinutes: { coding: 60, communication: 30 },
      pendingMinutes: 0,
      sampleCount: 90,
    });

    expect(segments[0]).toMatchObject({ category: "coding", minutes: 60 });
    expect(segments[1]).toMatchObject({ category: "communication", minutes: 30 });
    expect(Math.round(segments[0].percentage)).toBe(67);
  });

  it("uses observed coverage and keeps pending time explicit", () => {
    const segments = buildAttentionSegmentsFromStats({
      totalObservedMinutes: 120,
      categorizedMinutes: { coding: 30, communication: 10 },
      pendingMinutes: 80,
      sampleCount: 200,
    });

    expect(segments[0]).toMatchObject({
      key: "pending",
      label: "待整理",
      minutes: 80,
      filterable: false,
    });
    expect(segments.find((segment) => segment.category === "coding")?.percentage).toBe(25);
  });

  it("maps windows linearly to the observed domain and excludes future content", () => {
    const now = new Date("2026-07-17T10:00:00+08:00");
    const segments = buildRhythmSegments([
      activityWindow({ endAt: "2026-07-17T11:00:00+08:00" }),
      activityWindow({
        id: "activity-window:episode-2",
        startAt: "2026-07-17T10:30:00+08:00",
        endAt: "2026-07-17T11:00:00+08:00",
        category: "communication",
      }),
    ], {
      startAt: "2026-07-17T09:00:00+08:00",
      endAt: "2026-07-17T11:00:00+08:00",
    }, now);

    expect(segments).toHaveLength(1);
    expect(segments[0].startPercent).toBeCloseTo(0);
    expect(segments[0].widthPercent).toBeCloseTo(100);
    expect(segments[0].endLabel).toBe("10:00");
  });

  it("keeps the real relative distance between activity windows", () => {
    const segments = buildRhythmSegments([
      activityWindow({ endAt: "2026-07-17T09:05:00+08:00" }),
      activityWindow({
        id: "activity-window:episode-2",
        startAt: "2026-07-17T10:00:00+08:00",
        endAt: "2026-07-17T10:05:00+08:00",
      }),
    ], {
      startAt: "2026-07-17T09:00:00+08:00",
      endAt: "2026-07-17T11:00:00+08:00",
    }, new Date("2026-07-18T12:00:00+08:00"));

    expect(segments[0].startPercent).toBeCloseTo(0);
    expect(segments[0].widthPercent).toBeCloseTo(4.1667);
    expect(segments[1].startPercent).toBeCloseTo(50);
  });

  it("keeps content windows across horizontal and curved route sections", () => {
    const segments = buildRhythmSegments([
      activityWindow({
        id: "activity-window:long-horizontal",
        startAt: "2026-07-17T09:05:00+08:00",
        endAt: "2026-07-17T09:15:00+08:00",
      }),
      activityWindow({
        id: "activity-window:short-horizontal",
        startAt: "2026-07-17T09:20:00+08:00",
        endAt: "2026-07-17T09:22:00+08:00",
      }),
      activityWindow({
        id: "activity-window:curved",
        startAt: "2026-07-17T09:35:00+08:00",
        endAt: "2026-07-17T09:45:00+08:00",
      }),
    ], {
      startAt: "2026-07-17T09:00:00+08:00",
      endAt: "2026-07-17T11:00:00+08:00",
    }, new Date("2026-07-18T12:00:00+08:00"));

    expect(segments.map((segment) => segment.id)).toEqual([
      "activity-window:long-horizontal",
      "activity-window:short-horizontal",
      "activity-window:curved",
    ]);
    expect(segments.every((segment) => segment.widthPercent > 0)).toBe(true);
  });

  it("creates dynamic time markers from the observed domain", () => {
    const markers = buildRhythmTimeMarkers({
      startAt: "2026-07-17T09:12:00+08:00",
      endAt: "2026-07-17T11:40:00+08:00",
    });

    expect(markers[0].label).toBe("09:12");
    expect(markers.at(-1)?.label).toBe("11:40");
    expect(markers.some((marker) => marker.label === "10:00")).toBe(true);
  });

  it("builds one local path for each timeline item", () => {
    const path = buildRhythmRoutePath(15, 22);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).not.toContain("NaN");
  });

  it("keeps short items as colored segments without extending past now", () => {
    const now = new Date("2026-07-17T10:00:00+08:00");
    const [segment] = buildRhythmSegments([
      activityWindow({
        startAt: "2026-07-17T09:59:50+08:00",
        endAt: "2026-07-17T10:00:00+08:00",
      }),
    ], {
      startAt: "2026-07-17T09:00:00+08:00",
      endAt: "2026-07-17T10:00:00+08:00",
    }, now);

    expect(segment.widthPercent).toBeCloseTo(0.2778);
    expect(segment.startPercent).toBeCloseTo(99.7222);
    expect(segment.endLabel).toBe("10:00");
  });

  it("does not pack windows away from their actual positions", () => {
    const now = new Date("2026-07-17T11:00:00+08:00");
    const segments = buildRhythmSegments([
      activityWindow({
        id: "activity-window:short-1",
        startAt: "2026-07-17T09:59:50+08:00",
        endAt: "2026-07-17T10:00:00+08:00",
      }),
      activityWindow({
        id: "activity-window:short-2",
        startAt: "2026-07-17T10:00:05+08:00",
        endAt: "2026-07-17T10:00:15+08:00",
        category: "design",
      }),
    ], {
      startAt: "2026-07-17T09:00:00+08:00",
      endAt: "2026-07-17T11:00:00+08:00",
    }, now);

    expect(segments).toHaveLength(2);
    expect(segments[0].startPercent).toBeCloseTo(49.8611);
    expect(segments[1].startPercent).toBeCloseTo(50.0694);
  });

  it("prioritizes project names and produces varied cloud styling", () => {
    const words = buildTodayWords([
      episode({ topicTexts: ["完成词云交互设计", "L0 与 Edges 属于内部术语"] }),
    ], 12);

    expect(words[0].text).toBe("回声 Recall");
    expect(new Set(words.map((word) => word.sizeLevel)).size).toBeGreaterThan(1);
    expect(words.every((word) => word.offset >= -6 && word.offset <= 6)).toBe(true);
    expect(words.map((word) => word.text)).not.toEqual(expect.arrayContaining(["L0", "Edges"]));
  });

  it("formats compact durations", () => {
    expect(formatVisualizationDuration(45)).toBe("45 分钟");
    expect(formatVisualizationDuration(120)).toBe("2 小时");
    expect(formatVisualizationDuration(135)).toBe("2h 15m");
  });
});
