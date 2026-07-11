import { app as electronApp, ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated, ipcFail } from "../validated";

export function registerDataLifecycleHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "capture:forgetRecent", async (_event, input) => {
    if (!deps.dataLifecycleService) ipcFail("not_ready", "DataLifecycleService 未初始化");
    return input.duration === "all" ? deps.dataLifecycleService.clearScreenshots() : deps.dataLifecycleService.forgetRecent(input.duration);
  });
  handleValidated(ipcMain, "screenshot:clear", async () => {
    if (!deps.dataLifecycleService) ipcFail("not_ready", "DataLifecycleService 未初始化");
    return deps.dataLifecycleService.clearScreenshots();
  });
  handleValidated(ipcMain, "data:clearAll", async () => {
    if (!deps.dataLifecycleService) ipcFail("not_ready", "DataLifecycleService 未初始化");
    try { return await deps.dataLifecycleService.clearAll(); }
    catch (error) { return { ok: false, code: "clear_failed", message: message(error) }; }
  });
  handleValidated(ipcMain, "data:getCacheSize", async () => {
    if (!deps.screenshotCache) return { ok: true, bytes: 0, fileCount: 0 };
    try { return { ok: true, ...await deps.screenshotCache.getCacheSize() }; }
    catch { return { ok: true, bytes: 0, fileCount: 0 }; }
  });
  handleValidated(ipcMain, "data:export", (_event, input) => {
    try {
      if (!deps.db) ipcFail("not_ready", "数据库未初始化");
      const includeScreenshots = input?.includeScreenshots ?? false;
      const read = deps.db.transaction(() => {
        const observations = collect((limit, offset) => deps.observationRepo?.listByCapturedAt({ limit, offset }) ?? []);
        const collections = {
          observations: observations.map((item) => includeScreenshots ? item : { ...item, screenshotPaths: [], screenshotRetention: "expired" }),
          facts: collect((limit, offset) => deps.factRepo?.list({ includeDeleted: false, limit, offset }) ?? []),
          scenes: collect((limit, offset) => deps.sceneRepo?.listByStartAt({ includeDeleted: false, limit, offset }) ?? []),
          tasks: collect((limit, offset) => deps.memoryObjectRepo?.listTasks({ includeDeleted: false, limit, offset }) ?? []),
          decisions: collect((limit, offset) => deps.memoryObjectRepo?.listDecisions({ includeDeleted: false, limit, offset }) ?? []),
          people: collect((limit, offset) => deps.memoryObjectRepo?.listPeople({ includeDeleted: false, limit, offset }) ?? []),
          projects: collect((limit, offset) => deps.memoryObjectRepo?.listProjects({ includeArchived: false, limit, offset }) ?? []),
          reports: collect((limit, offset) => deps.reportRepo?.list({ limit, offset }) ?? []),
          proactiveItems: collect((limit, offset) => deps.proactiveItemRepo?.list({ limit, offset }) ?? []),
          timelineBlocks: collect((limit, offset) => deps.timelineBlockRepo?.list({ limit, offset }) ?? []),
          unfinishedThreads: collect((limit, offset) => deps.unfinishedThreadRepo?.list({ limit, offset }) ?? []),
          reportSelections: collect((limit, offset) => deps.reportSelectionRepo?.list({ limit, offset }) ?? []),
          objectMerges: collect((limit, offset) => deps.objectMergeRepo?.listRecent({ limit, offset }) ?? []),
          memoryEdges: collect((limit, offset) => deps.memoryEdgeRepo?.list({ limit, offset }) ?? []),
        };
        const schemaVersion = (deps.db!.prepare("SELECT version FROM _migrations ORDER BY version DESC LIMIT 1").get() as { version?: string } | undefined)?.version ?? "unknown";
        return { collections, schemaVersion };
      })();
      return { ok: true, export: { meta: { schemaVersion: read.schemaVersion, appVersion: electronApp.getVersion(), exportedAt: new Date().toISOString(), includeScreenshots, screenshotSemantics: includeScreenshots ? "references" as const : "excluded" as const, counts: Object.fromEntries(Object.entries(read.collections).map(([key, value]) => [key, value.length])) }, ...read.collections } };
    } catch (error) { return { ok: false, code: "export_failed", message: message(error) }; }
  });
}

function collect<T>(page: (limit: number, offset: number) => T[]): T[] { const all: T[] = []; for (let offset = 0;; offset += 500) { const batch = page(500, offset); all.push(...batch); if (batch.length < 500) return all; } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
