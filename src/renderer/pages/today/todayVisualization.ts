import type {
  TimelineBlockCategory,
  TodayActivityEpisode,
  TodayActivityOverview,
  TodayActivityStats,
  TodayActivityWindow,
} from "../../../shared/types";
import { categoryLabel, dateKeyFromDate, formatTime } from "./helpers";

export const CATEGORY_COLORS: Record<TimelineBlockCategory, string> = {
  focus_work: "#2F8F83",
  communication: "#D9912B",
  research: "#557DA8",
  writing: "#8B6D9C",
  coding: "#397A6D",
  design: "#C06F58",
  meeting: "#B08A45",
  admin: "#7A817E",
  break: "#A9B3AE",
  mixed: "#788F89",
  unknown: "#8FA29B",
};

export interface AttentionSegment {
  key: string;
  category: TimelineBlockCategory;
  label: string;
  minutes: number;
  percentage: number;
  color: string;
  filterable: boolean;
}

export interface RhythmSegment {
  id: string;
  title: string;
  category: TimelineBlockCategory;
  startPercent: number;
  widthPercent: number;
  startLabel: string;
  endLabel: string;
  timeLabel: string;
  color: string;
}

export interface RhythmAxisDomain {
  startAt: string;
  endAt: string;
}

export interface RhythmTimeMarker {
  label: string;
  percent: number;
  point: RhythmRoutePoint;
  guide: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  };
}

export interface TodayWord {
  text: string;
  weight: number;
  sizeLevel: 0 | 1 | 2 | 3 | 4;
  tone: 0 | 1 | 2 | 3;
  offset: number;
  rotation: number;
}

export interface RhythmRoutePoint {
  x: number;
  y: number;
}

const STOP_WORDS = new Set([
  "今天",
  "今日",
  "工作",
  "完成",
  "进行",
  "相关",
  "内容",
  "问题",
  "一个",
  "这个",
  "以及",
  "通过",
  "开始",
  "继续",
  "使用",
  "处理",
  "查看",
  "页面",
  "功能",
  "用户",
  "时间",
  "the",
  "and",
  "for",
  "with",
  "from",
  "l0",
  "l1",
  "l2",
  "l3",
  "l4",
  "fact",
  "facts",
  "scene",
  "scenes",
  "edge",
  "edges",
  "model",
  "job",
]);

export function getEpisodeDurationMinutes(episode: TodayActivityEpisode): number {
  const start = new Date(episode.startAt).getTime();
  const end = new Date(episode.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(1, Math.round((end - start) / 60_000));
}

export function buildAttentionSegmentsFromStats(stats: TodayActivityStats): AttentionSegment[] {
  const segments: AttentionSegment[] = Object.entries(stats.categorizedMinutes)
    .filter((entry): entry is [TimelineBlockCategory, number] =>
      entry[1] !== undefined && entry[1] > 0
    )
    .map(([category, minutes]) => ({
      key: category,
      category,
      label: categoryLabel(category),
      minutes,
      percentage: stats.totalObservedMinutes > 0
        ? (minutes / stats.totalObservedMinutes) * 100
        : 0,
      color: CATEGORY_COLORS[category],
      filterable: true,
    }));

  if (stats.pendingMinutes > 0) {
    segments.push({
      key: "pending",
      category: "unknown",
      label: "待整理",
      minutes: stats.pendingMinutes,
      percentage: stats.totalObservedMinutes > 0
        ? (stats.pendingMinutes / stats.totalObservedMinutes) * 100
        : 0,
      color: "#B7B0A5",
      filterable: false,
    });
  }

  return segments.sort((left, right) => right.minutes - left.minutes);
}

export function getActivityAxisDomain(overview: TodayActivityOverview): RhythmAxisDomain | null {
  if (!overview.observedStartAt || !overview.observedEndAt) return null;
  const startMs = Date.parse(overview.observedStartAt);
  const endMs = Date.parse(overview.observedEndAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { startAt: overview.observedStartAt, endAt: overview.observedEndAt };
}

export function buildRhythmSegments(
  windows: TodayActivityWindow[],
  domain: RhythmAxisDomain,
  now = new Date()
): RhythmSegment[] {
  const domainStartMs = Date.parse(domain.startAt);
  const domainEndMs = Date.parse(domain.endAt);
  if (!Number.isFinite(domainStartMs) || !Number.isFinite(domainEndMs) || domainEndMs <= domainStartMs) {
    return [];
  }

  const isCurrentDay = dateKeyFromDate(new Date(domainStartMs)) === dateKeyFromDate(now);
  const visibleEndMs = isCurrentDay
    ? Math.min(domainEndMs, now.getTime())
    : domainEndMs;
  if (visibleEndMs <= domainStartMs) return [];

  return windows
    .map((window) => {
      const rawStartMs = Date.parse(window.startAt);
      const rawEndMs = Date.parse(window.endAt);
      if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) return null;
      const startMs = Math.max(domainStartMs, rawStartMs);
      const endMs = Math.min(visibleEndMs, rawEndMs);
      if (endMs <= startMs) return null;

      const startPercent = timeToRoutePercent(startMs, domainStartMs, visibleEndMs);
      const endPercent = timeToRoutePercent(endMs, domainStartMs, visibleEndMs);
      const widthPercent = Math.max(0, endPercent - startPercent);
      const startLabel = formatTime(new Date(startMs).toISOString());
      const endLabel = formatTime(new Date(endMs).toISOString());
      return {
        id: window.id,
        title: window.title,
        category: window.category,
        startPercent,
        widthPercent,
        startLabel,
        endLabel,
        timeLabel: `${startLabel} - ${endLabel}`,
        color: CATEGORY_COLORS[window.category],
      } satisfies RhythmSegment;
    })
    .filter((segment): segment is RhythmSegment => segment !== null)
    .sort((left, right) => left.startPercent - right.startPercent);
}

export function buildTodayWords(episodes: TodayActivityEpisode[], limit = 18): TodayWord[] {
  const weights = new Map<string, number>();

  for (const episode of episodes) {
    const durationBoost = Math.min(getEpisodeDurationMinutes(episode) / 30, 6);

    for (const projectName of episode.projectNames) {
      addWeight(weights, projectName, 10 + durationBoost);
    }

    for (const word of segmentWords(episode.title)) {
      addWeight(weights, word, 4 + durationBoost * 0.35);
    }

    for (const topicText of episode.topicTexts) {
      for (const word of segmentWords(topicText)) {
        addWeight(weights, word, 3);
      }
    }
  }

  const ranked = Array.from(weights.entries())
    .map(([text, weight]) => ({ text, weight }))
    .sort((left, right) => right.weight - left.weight || left.text.localeCompare(right.text, "zh-CN"))
    .slice(0, limit);

  return ranked.map((word, index) => {
    const hash = hashText(word.text);
    const rankRatio = ranked.length <= 1 ? 0 : index / (ranked.length - 1);
    const sizeLevel = Math.max(0, 4 - Math.floor(rankRatio * 5)) as TodayWord["sizeLevel"];
    return {
      ...word,
      sizeLevel,
      tone: (hash % 4) as TodayWord["tone"],
      offset: (hash % 13) - 6,
      rotation: ((Math.floor(hash / 13) % 5) - 2) * 0.8,
    };
  });
}

export function formatVisualizationDuration(totalMinutes: number): string {
  totalMinutes = Math.max(0, Math.round(totalMinutes));
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} 小时` : `${hours}h ${minutes}m`;
}

export function timeToRoutePercent(
  timeMs: number,
  domainStartMs: number,
  domainEndMs: number
): number {
  if (domainEndMs <= domainStartMs) return 0;
  return Math.min(
    100,
    Math.max(0, ((timeMs - domainStartMs) / (domainEndMs - domainStartMs)) * 100)
  );
}

export function buildRhythmTimeMarkers(domain: RhythmAxisDomain): RhythmTimeMarker[] {
  const startMs = Date.parse(domain.startAt);
  const endMs = Date.parse(domain.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];

  const durationMinutes = (endMs - startMs) / 60_000;
  const stepMinutes = durationMinutes <= 45
    ? 5
    : durationMinutes <= 150
      ? 15
      : durationMinutes <= 360
        ? 30
        : durationMinutes <= 720
          ? 60
          : 120;
  const stepMs = stepMinutes * 60_000;
  const markerTimes = [startMs];
  for (let timeMs = Math.ceil(startMs / stepMs) * stepMs; timeMs < endMs; timeMs += stepMs) {
    if (timeMs > startMs) markerTimes.push(timeMs);
  }
  markerTimes.push(endMs);

  return [...new Set(markerTimes)].map((timeMs) => {
    const percent = timeToRoutePercent(timeMs, startMs, endMs);
    const point = getRhythmRoutePoint(percent);
    const before = getRhythmRoutePoint(Math.max(0, percent - 0.2));
    const after = getRhythmRoutePoint(Math.min(100, percent + 0.2));
    const tangentX = after.x - before.x;
    const tangentY = after.y - before.y;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const normalX = -tangentY / tangentLength;
    const normalY = tangentX / tangentLength;
    return {
      label: formatTime(new Date(timeMs).toISOString()),
      percent,
      point,
      guide: {
        x1: point.x - normalX * 5,
        y1: point.y - normalY * 7,
        x2: point.x + normalX * 5,
        y2: point.y + normalY * 7,
      },
    };
  });
}

export function getRhythmRoutePoint(rawPercent: number): RhythmRoutePoint {
  const percent = Math.min(Math.max(rawPercent, 0), 100);

  if (percent <= 25) {
    const ratio = percent / 25;
    return { x: 2 + 86 * ratio, y: 14 };
  }
  if (percent <= 40) {
    const ratio = (percent - 25) / 15;
    const angle = -Math.PI / 2 + Math.PI * ratio;
    return { x: 88 + 10 * Math.cos(angle), y: 31 + 17 * Math.sin(angle) };
  }
  if (percent <= 60) {
    const ratio = (percent - 40) / 20;
    return { x: 88 - 76 * ratio, y: 48 };
  }
  if (percent <= 75) {
    const ratio = (percent - 60) / 15;
    const angle = -Math.PI / 2 - Math.PI * ratio;
    return { x: 12 + 10 * Math.cos(angle), y: 66 + 18 * Math.sin(angle) };
  }

  const ratio = (percent - 75) / 25;
  return { x: 12 + 86 * ratio, y: 84 };
}

export function buildRhythmRoutePath(startPercent: number, endPercent: number): string {
  const start = Math.min(Math.max(startPercent, 0), 100);
  const end = Math.min(Math.max(endPercent, start), 100);
  const sampleCount = Math.max(1, Math.ceil((end - start) / 0.3));
  const points = Array.from({ length: sampleCount + 1 }, (_, index) => {
    const percent = start + ((end - start) * index) / sampleCount;
    return getRhythmRoutePoint(percent);
  });

  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(3)} ${point.y.toFixed(3)}`)
    .join(" ");
}

function segmentWords(text: string): string[] {
  const cleanText = text.trim();
  if (!cleanText) return [];

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
    return Array.from(segmenter.segment(cleanText))
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
      .filter(isUsefulWord);
  }

  return cleanText
    .split(/[\s,，。.!！?？:：;；、/\\|()（）\[\]【】_-]+/)
    .filter(isUsefulWord);
}

function isUsefulWord(rawWord: string): boolean {
  const word = rawWord.trim();
  if (word.length < 2 || word.length > 14) return false;
  if (/^\d+$/.test(word)) return false;
  return !STOP_WORDS.has(word.toLowerCase());
}

function addWeight(weights: Map<string, number>, rawText: string, weight: number): void {
  const text = rawText.trim();
  if (!isUsefulWord(text)) return;
  weights.set(text, (weights.get(text) ?? 0) + weight);
}

function hashText(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash;
}
