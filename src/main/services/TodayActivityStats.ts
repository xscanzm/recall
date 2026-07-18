import type {
  TodayActivityEpisode,
  TodayActivityOverview,
  TodayActivityStats,
  TodayActivityWindow,
  TimelineBlockCategory,
} from "../../shared/types";

interface ActivityObservation {
  id: string;
  capturedAt: string;
}

interface ActivityEpisodeInput {
  id: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  projectId: string | null;
  factIds: string[];
  observationIds: string[];
  activityCategory: TimelineBlockCategory;
  activityConfidence: number;
}

interface ActivityFactInput {
  id: string;
  content: string;
  projectId: string | null;
  projectHint: string | null;
  privateRisk?: "low" | "medium" | "high" | null;
  sourceObservationIds: string[];
  sourceEpisodeIds: string[];
}

interface ActivityProjectInput {
  id: string;
  name: string;
}

interface ActivityOverviewOptions {
  coverageEnd: Date;
  maxGapSeconds: number;
}

interface ObservationInterval {
  id: string;
  startMs: number;
  endMs: number;
  minutes: number;
}

const ACTIVITY_WINDOW_MAX_GAP_MS = 5 * 60 * 1000;

export function buildTodayActivityOverview(
  observations: ActivityObservation[],
  episodes: ActivityEpisodeInput[],
  facts: ActivityFactInput[],
  projects: ActivityProjectInput[],
  options: ActivityOverviewOptions
): TodayActivityOverview {
  const intervals = buildObservationIntervals(observations, options);
  const stats = calculateStats(intervals, episodes);
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const projectNamesById = new Map(projects.map((project) => [project.id, project.name]));
  const activityEpisodes = episodes
    .map((episode) => buildEpisodeOverview(
      episode,
      intervals,
      facts,
      factsById,
      projectNamesById
    ))
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
  const observedStartAt = intervals.length > 0
    ? new Date(intervals[0].startMs).toISOString()
    : null;
  const observedEndAt = intervals.length > 0
    ? new Date(Math.max(...intervals.map((interval) => interval.endMs))).toISOString()
    : null;

  return {
    stats,
    episodes: activityEpisodes,
    windows: mergeActivityWindows(activityEpisodes),
    observedStartAt,
    observedEndAt,
  };
}

export function calculateTodayActivityStats(
  observations: ActivityObservation[],
  episodes: ActivityEpisodeInput[],
  options: ActivityOverviewOptions
): TodayActivityStats {
  return calculateStats(buildObservationIntervals(observations, options), episodes);
}

function buildObservationIntervals(
  observations: ActivityObservation[],
  options: ActivityOverviewOptions
): ObservationInterval[] {
  const sorted = observations
    .map((observation) => ({
      ...observation,
      capturedAtMs: Date.parse(observation.capturedAt),
    }))
    .filter((observation) => Number.isFinite(observation.capturedAtMs))
    .sort((left, right) => left.capturedAtMs - right.capturedAtMs);
  const coverageEndMs = options.coverageEnd.getTime();
  const maxGapMs = Math.max(1, options.maxGapSeconds) * 1000;

  return sorted.flatMap((observation, index) => {
    const nextCapturedAtMs = sorted[index + 1]?.capturedAtMs ?? coverageEndMs;
    const intervalMs = Math.min(maxGapMs, nextCapturedAtMs - observation.capturedAtMs);
    if (intervalMs <= 0) return [];
    return [{
      id: observation.id,
      startMs: observation.capturedAtMs,
      endMs: observation.capturedAtMs + intervalMs,
      minutes: intervalMs / 60_000,
    }];
  });
}

function calculateStats(
  intervals: ObservationInterval[],
  episodes: ActivityEpisodeInput[]
): TodayActivityStats {
  const categoriesByObservationId = new Map<string, Set<TimelineBlockCategory>>();
  for (const episode of episodes) {
    if (episode.activityCategory === "unknown") continue;
    for (const observationId of episode.observationIds) {
      const categories = categoriesByObservationId.get(observationId) ?? new Set();
      categories.add(episode.activityCategory);
      categoriesByObservationId.set(observationId, categories);
    }
  }

  const categorizedMinutes: Partial<Record<TimelineBlockCategory, number>> = {};
  let pendingMinutes = 0;
  for (const interval of intervals) {
    const categories = [...(categoriesByObservationId.get(interval.id) ?? [])];
    if (categories.length === 0) {
      pendingMinutes += interval.minutes;
      continue;
    }
    const category = categories.length === 1 ? categories[0] : "mixed";
    categorizedMinutes[category] = (categorizedMinutes[category] ?? 0) + interval.minutes;
  }

  const categorizedTotal = Object.values(categorizedMinutes).reduce(
    (sum, minutes) => sum + (minutes ?? 0),
    0
  );
  return {
    totalObservedMinutes: roundOneDecimal(categorizedTotal + pendingMinutes),
    categorizedMinutes: Object.fromEntries(
      Object.entries(categorizedMinutes).map(([category, minutes]) => [
        category,
        roundOneDecimal(minutes ?? 0),
      ])
    ),
    pendingMinutes: roundOneDecimal(pendingMinutes),
    sampleCount: intervals.length,
  };
}

function buildEpisodeOverview(
  episode: ActivityEpisodeInput,
  intervals: ObservationInterval[],
  facts: ActivityFactInput[],
  factsById: Map<string, ActivityFactInput>,
  projectNamesById: Map<string, string>
): TodayActivityEpisode {
  const observationIds = new Set(episode.observationIds);
  const episodeIntervals = intervals.filter((interval) => observationIds.has(interval.id));
  const startAt = episodeIntervals.length > 0
    ? new Date(Math.min(...episodeIntervals.map((interval) => interval.startMs))).toISOString()
    : episode.startAt;
  const endAt = episodeIntervals.length > 0
    ? new Date(Math.max(...episodeIntervals.map((interval) => interval.endMs))).toISOString()
    : episode.endAt;
  const relatedFacts = uniqueById([
    ...episode.factIds.flatMap((id) => factsById.get(id) ?? []),
    ...facts.filter((fact) =>
      fact.sourceEpisodeIds.includes(episode.id)
      || fact.sourceObservationIds.some((id) => observationIds.has(id))
    ),
  ]);
  const projectNames = new Set<string>();
  const projectHints = new Set<string>();
  const projectIds = new Set<string>();
  if (episode.projectId) projectIds.add(episode.projectId);
  for (const fact of relatedFacts) {
    if (fact.projectId) projectIds.add(fact.projectId);
    if (fact.projectHint?.trim()) projectHints.add(fact.projectHint.trim());
  }
  for (const projectId of projectIds) {
    const name = projectNamesById.get(projectId);
    if (name) projectNames.add(name);
  }
  if (projectNames.size === 0) {
    for (const hint of projectHints) projectNames.add(hint);
  }

  return {
    id: episode.id,
    startAt,
    endAt,
    title: episode.title,
    summary: episode.summary,
    category: episode.activityCategory,
    categoryConfidence: episode.activityConfidence,
    sourceObservationIds: episode.observationIds,
    projectNames: [...projectNames],
    topicTexts: relatedFacts
      .filter((fact) => fact.privateRisk !== "high")
      .map((fact) => fact.content)
      .filter((content, index, values) => values.indexOf(content) === index),
  };
}

function mergeActivityWindows(episodes: TodayActivityEpisode[]): TodayActivityWindow[] {
  const windows: TodayActivityWindow[] = [];
  for (const episode of episodes) {
    const previous = windows[windows.length - 1];
    if (!previous || !canMergeWindow(previous, episode)) {
      windows.push(createActivityWindow(episode));
      continue;
    }

    const sourceEpisodeIds = [...previous.sourceEpisodeIds, episode.id];
    previous.endAt = maxIso(previous.endAt, episode.endAt);
    previous.summary = mergeText(previous.summary, episode.summary);
    previous.categoryConfidence = averageConfidence(
      previous.categoryConfidence,
      episode.categoryConfidence,
      previous.sourceEpisodeIds.length,
      1
    );
    previous.sourceEpisodeIds = sourceEpisodeIds;
    previous.sourceObservationIds = uniqueStrings([
      ...previous.sourceObservationIds,
      ...episode.sourceObservationIds,
    ]);
    previous.projectNames = uniqueStrings([
      ...previous.projectNames,
      ...episode.projectNames,
    ]);
    previous.topicTexts = uniqueStrings([
      ...previous.topicTexts,
      ...episode.topicTexts,
    ]);
  }
  return windows;
}

function createActivityWindow(episode: TodayActivityEpisode): TodayActivityWindow {
  return {
    id: `activity-window:${episode.id}`,
    startAt: episode.startAt,
    endAt: episode.endAt,
    title: episode.title,
    summary: episode.summary,
    category: episode.category,
    categoryConfidence: episode.categoryConfidence,
    sourceEpisodeIds: [episode.id],
    sourceObservationIds: [...episode.sourceObservationIds],
    projectNames: [...episode.projectNames],
    topicTexts: [...episode.topicTexts],
  };
}

function canMergeWindow(
  previous: TodayActivityWindow,
  current: TodayActivityEpisode
): boolean {
  if (previous.category !== current.category) return false;
  const previousEnd = Date.parse(previous.endAt);
  const currentStart = Date.parse(current.startAt);
  if (!Number.isFinite(previousEnd) || !Number.isFinite(currentStart)) return false;
  if (currentStart - previousEnd > ACTIVITY_WINDOW_MAX_GAP_MS) return false;

  if (previous.projectNames.length > 0 || current.projectNames.length > 0) {
    return previous.projectNames.some((name) => current.projectNames.includes(name));
  }
  return true;
}

function mergeText(left: string, right: string): string {
  if (!right || left === right) return left;
  if (!left) return right;
  return `${left}；${right}`.slice(0, 1000);
}

function averageConfidence(
  previous: number,
  current: number,
  previousWeight: number,
  currentWeight: number
): number {
  const totalWeight = previousWeight + currentWeight;
  if (totalWeight <= 0) return 0;
  return Math.round(((previous * previousWeight + current * currentWeight) / totalWeight) * 100) / 100;
}

function maxIso(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim()))];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
