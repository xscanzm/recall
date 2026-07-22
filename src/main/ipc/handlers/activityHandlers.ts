import { ipcMain } from "electron";
import type { Fact } from "../../models/types";
import type { IpcDeps } from "../handlers";
import { handleValidated, ipcFail } from "../validated";
import { localDateKeyUtcRange } from "../../utils/dateKey";
import { buildTodayActivityOverview } from "../../services/TodayActivityStats";

export function registerActivityHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "activity:getDayOverview", (_event, dateKey) => {
    if (!deps.observationRepo || !deps.sceneRepo || !deps.factRepo || !deps.memoryObjectRepo) {
      ipcFail("not_ready", "每日活动概览数据源未初始化");
    }
    try {
      return {
        ok: true,
        data: loadDayActivityOverview({
          observationRepo: deps.observationRepo,
          sceneRepo: deps.sceneRepo,
          factRepo: deps.factRepo,
          memoryObjectRepo: deps.memoryObjectRepo,
          settingsService: deps.settingsService,
        }, dateKey),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

interface ActivityDataDependencies {
  observationRepo: NonNullable<IpcDeps["observationRepo"]>;
  sceneRepo: NonNullable<IpcDeps["sceneRepo"]>;
  factRepo: NonNullable<IpcDeps["factRepo"]>;
  memoryObjectRepo: NonNullable<IpcDeps["memoryObjectRepo"]>;
  settingsService: IpcDeps["settingsService"];
}

export function loadDayActivityOverview(
  deps: ActivityDataDependencies,
  dateKey: string
) {
  const range = localDateKeyUtcRange(dateKey);
  const startMs = Date.parse(range.start);
  const coverageEnd = new Date(Math.max(
    startMs,
    Math.min(Date.parse(range.end), Date.now())
  ));
  const observations = deps.observationRepo.listTimeRangeMinimal(
    range.start,
    coverageEnd.toISOString()
  );
  const episodes = deps.sceneRepo.listByStartAtMinimal({
    from: range.start,
    to: coverageEnd.toISOString(),
    order: "asc",
  });
  const episodeIds = episodes.map((episode) => episode.id);
  const observationIds = observations.map((observation) => observation.id);
  const facts = uniqueFacts([
    ...deps.factRepo.listByIds(episodes.flatMap((episode) => episode.factIds)),
    ...deps.factRepo.listBySourceEpisodeIds(episodeIds),
    ...deps.factRepo.listBySourceObservationIds(observationIds),
  ]);
  const referencedProjectIds = [
    ...new Set([
      ...episodes.map((episode) => episode.projectId).filter((id): id is string => !!id),
      ...facts.map((fact) => fact.projectId).filter((id): id is string => !!id),
    ]),
  ];
  const projects = deps.memoryObjectRepo.listProjectsByIdsMinimal(referencedProjectIds);

  return buildTodayActivityOverview(observations, episodes, facts, projects, {
    coverageEnd,
    maxGapSeconds: deps.settingsService.getAll().observation.idleThresholdSeconds,
  });
}

function uniqueFacts(facts: Fact[]): Fact[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()];
}
