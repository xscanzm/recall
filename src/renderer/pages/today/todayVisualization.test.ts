import { describe, expect, it } from "vitest";
import type { TodayActivityEpisode } from "../../../shared/types";
import {
  buildAttentionSegmentsFromStats,
  buildRhythmRoutePath,
  buildRhythmSegments,
  buildTodayWords,
  clockMinutesToRoutePercent,
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

  it("uses clock positions and excludes future content for today", () => {
    const now = new Date("2026-07-17T10:00:00+08:00");
    const segments = buildRhythmSegments([
      episode({ endAt: "2026-07-17T11:00:00+08:00" }),
      episode({
        id: "episode-2",
        startAt: "2026-07-17T10:30:00+08:00",
        endAt: "2026-07-17T11:00:00+08:00",
        category: "communication",
      }),
    ], now);

    expect(segments).toHaveLength(1);
    expect(segments[0].startPercent).toBeCloseTo(15);
    expect(segments[0].widthPercent).toBeCloseTo(7);
    expect(segments[0].endLabel).toBe("10:00");
  });

  it("expands 08:00 to 20:00 across most of the route", () => {
    expect(clockMinutesToRoutePercent(0)).toBe(0);
    expect(clockMinutesToRoutePercent(8 * 60)).toBe(8);
    expect(clockMinutesToRoutePercent(10 * 60)).toBe(22);
    expect(clockMinutesToRoutePercent(14 * 60)).toBe(50);
    expect(clockMinutesToRoutePercent(18 * 60)).toBe(78);
    expect(clockMinutesToRoutePercent(20 * 60)).toBe(92);
    expect(clockMinutesToRoutePercent(24 * 60)).toBe(100);
  });

  it("builds one local path for each timeline item", () => {
    const path = buildRhythmRoutePath(15, 22);
    expect(path.match(/M/g)).toHaveLength(1);
    expect(path).not.toContain("NaN");
  });

  it("keeps short items visible without extending past now", () => {
    const now = new Date("2026-07-17T10:00:00+08:00");
    const [segment] = buildRhythmSegments([
      episode({
        startAt: "2026-07-17T09:59:50+08:00",
        endAt: "2026-07-17T10:00:00+08:00",
      }),
    ], now);

    expect(segment.widthPercent).toBeGreaterThan(0.28);
    expect(segment.startPercent + segment.widthPercent).toBeLessThanOrEqual(22);
  });

  it("packs nearby short items without hiding either one", () => {
    const now = new Date("2026-07-17T11:00:00+08:00");
    const segments = buildRhythmSegments([
      episode({
        id: "short-1",
        startAt: "2026-07-17T09:59:50+08:00",
        endAt: "2026-07-17T10:00:00+08:00",
      }),
      episode({
        id: "short-2",
        startAt: "2026-07-17T10:00:05+08:00",
        endAt: "2026-07-17T10:00:15+08:00",
        category: "design",
      }),
    ], now);

    expect(segments).toHaveLength(2);
    expect(segments[0].startPercent + segments[0].widthPercent).toBeLessThan(
      segments[1].startPercent
    );
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
