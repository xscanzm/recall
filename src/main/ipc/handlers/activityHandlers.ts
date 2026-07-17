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
      const range = localDateKeyUtcRange(dateKey);
      const startMs = Date.parse(range.start);
      const coverageEnd = new Date(Math.max(
        startMs,
        Math.min(Date.parse(range.end), Date.now())
      ));
      const observations = deps.observationRepo.listByTimeRange(
        range.start,
        coverageEnd.toISOString()
      );
      const episodes = deps.sceneRepo.listByStartAt({
        from: range.start,
        to: coverageEnd.toISOString(),
        limit: 1000,
        order: "asc",
      });
      const episodeIds = episodes.map((episode) => episode.id);
      const facts = uniqueFacts([
        ...deps.factRepo.listByIds(episodes.flatMap((episode) => episode.factIds)),
        ...deps.factRepo.listBySourceEpisodeIds(episodeIds),
      ]);
      const projects = deps.memoryObjectRepo.listProjects({
        includeArchived: true,
        limit: 1000,
      });
      return {
        ok: true,
        data: buildTodayActivityOverview(observations, episodes, facts, projects, {
          coverageEnd,
          maxGapSeconds: deps.settingsService.getAll().observation.idleThresholdSeconds,
        }),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

function uniqueFacts(facts: Fact[]): Fact[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()];
}
