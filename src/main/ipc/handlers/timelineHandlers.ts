import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import type { WorkReport } from "../../../shared/types";
import { handleValidated, ipcFail } from "../validated";

export function registerTimelineHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "timeline:build", async (_event, dateKey) => {
    if (!deps.timelineBuilderWorker) ipcFail("not_ready", "TimelineBuilderWorker 未初始化");
    try {
      const result = await deps.timelineBuilderWorker.buildTimeline(dateKey);
      return result.ok ? { ok: true, data: result } : { ok: false, error: result.errorMessage ?? "timeline build 失败", code: result.errorCode };
    } catch (error) { return failure(error); }
  });
  handleValidated(ipcMain, "timeline:reorganizeDay", async (_event, dateKey) => {
    if (!deps.timelineBuilderWorker) ipcFail("not_ready", "TimelineBuilderWorker 未初始化");
    try {
      const result = await deps.timelineBuilderWorker.reorganizeDay(dateKey);
      return result.ok ? { ok: true, data: result } : { ok: false, error: result.errorMessage ?? "timeline reorganize 失败", code: result.errorCode };
    } catch (error) { return failure(error); }
  });
  handleValidated(ipcMain, "timeline:get", (_event, dateKey) => {
    if (!deps.timelineBlockRepo) ipcFail("not_ready", "TimelineBlockRepository 未初始化");
    try { return { ok: true, data: deps.timelineBlockRepo.findByDateKey(dateKey) }; }
    catch (error) { return failure(error); }
  });
}

export function registerWorkReportHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "workReport:generate", async (_event, input) => {
    if (!deps.workReportWriterWorker) ipcFail("not_ready", "WorkReportWriterWorker 未初始化");
    try {
      const result = await deps.workReportWriterWorker.writeWorkReport(input.dateKey, input.selectedBlockIds, input.style, input.recipientHint);
      return result.ok ? { ok: true, data: result } : { ok: false, error: result.errorMessage ?? "work report 生成失败", code: result.errorCode };
    } catch (error) { return failure(error); }
  });
  handleValidated(ipcMain, "workReport:get", (_event, dateKey) => {
    if (!deps.reportRepo) ipcFail("not_ready", "ReportRepository 未初始化");
    try {
      const report = deps.reportRepo.getByTypeAndDate("work_daily_report", dateKey);
      if (!report) return { ok: true, data: null };
      try {
        const parsed = JSON.parse(report.contentJson) as Record<string, unknown>;
        const sections = (parsed.sections ?? {}) as Record<string, unknown>;
        const data: WorkReport = {
          id: typeof parsed.id === "string" ? parsed.id : report.id,
          dateKey: typeof parsed.dateKey === "string" ? parsed.dateKey : report.dateKey,
          title: typeof parsed.title === "string" ? parsed.title : report.title,
          plainText: typeof parsed.plainText === "string" ? parsed.plainText : "",
          sections: {
            completed: strings(sections.completed), projectProgress: strings(sections.projectProgress),
            risks: strings(sections.risks), tomorrowPlan: strings(sections.tomorrowPlan),
          },
          sourceTimelineBlockIds: strings(parsed.sourceTimelineBlockIds), sourceFactIds: strings(parsed.sourceFactIds),
          omittedForPrivacy: typeof parsed.omittedForPrivacy === "number" ? parsed.omittedForPrivacy : 0,
          warnings: strings(parsed.warnings), createdAt: report.createdAt, updatedAt: report.updatedAt,
        };
        return { ok: true, data };
      } catch { return { ok: true, data: null }; }
    } catch (error) { return failure(error); }
  });
  handleValidated(ipcMain, "workReport:saveSelection", (_event, input) => {
    if (!deps.reportSelectionRepo) ipcFail("not_ready", "ReportSelectionRepository 未初始化");
    try {
      deps.reportSelectionRepo.upsert(input.dateKey, "work_daily_report", input.selectedBlockIds, input.excludedBlockIds);
      return { ok: true, data: null };
    } catch (error) { return failure(error); }
  });
}

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function failure(error: unknown) { return { ok: false as const, error: error instanceof Error ? error.message : String(error), code: "unknown_error" }; }
