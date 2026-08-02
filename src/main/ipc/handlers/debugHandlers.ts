import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated } from "../validated";

/**
 * 调试模式专用：3 个 handler 均强制校验 settingsService.isDebugMode()
 * 关闭时返回 error，防止通过 IPC 绕过 UI 开关
 */
export function registerDebugHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "debug:listJobs", (_event, input) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    if (!deps.modelJobRepo) {
      return { ok: false as const, error: "ModelJobRepository 未初始化", code: "not_ready" };
    }
    try {
      const jobs = deps.modelJobRepo.listByTimeRange(
        input.startAt,
        input.endAt,
        input.limit ?? 200
      );
      return { ok: true as const, data: jobs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  handleValidated(ipcMain, "debug:getJobDetails", (_event, input) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    if (!deps.modelJobRepo) {
      return { ok: false as const, error: "ModelJobRepository 未初始化", code: "not_ready" };
    }
    try {
      const job = deps.modelJobRepo.getById(input.jobId);
      return { ok: true as const, data: job };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  handleValidated(ipcMain, "debug:getRelatedRecords", (_event, input) => {
    if (!deps.settingsService.isDebugMode()) {
      return { ok: false as const, error: "debug mode disabled", code: "debug_disabled" };
    }
    const { createdAt, windowSeconds = 30 } = input;
    const start = new Date(Date.parse(createdAt) - windowSeconds * 1000).toISOString();
    const end = new Date(Date.parse(createdAt) + windowSeconds * 1000).toISOString();
    try {
      const observations = deps.observationRepo?.listByTimeRange(start, end, 2000) ?? [];
      const facts = deps.factRepo?.listByTimeRange(start, end, 2000) ?? [];
      const scenes = deps.sceneRepo?.listByTimeRange(start, end) ?? [];
      const proactiveItems = deps.proactiveItemRepo?.listByTimeRange(start, end) ?? [];
      return { ok: true as const, data: { observations, facts, scenes, proactiveItems } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });
}
