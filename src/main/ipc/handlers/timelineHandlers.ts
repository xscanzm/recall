import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import type { PersonalReview, WorkReport } from "../../../shared/types";
import { PersonalReviewGenerateInputSchema } from "../../models/schemas";
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
  registerPersonalReviewHandlers(deps);
  registerUnfinishedThreadHandlers(deps);
}

export function registerWorkReportHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "workReport:generate", async (_event, input) => {
    if (!deps.workReportWriterWorker) ipcFail("not_ready", "WorkReportWriterWorker 未初始化");
    try {
      const result = await deps.workReportWriterWorker.writeWorkReport(
        input.dateKey,
        input.selectedBlockIds,
        input.style,
        input.recipientHint,
        input.generationRequirement
      );
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
          reportType: "work_daily_report",
          plainText: typeof parsed.plainText === "string" ? parsed.plainText : "",
          sections: {
            completed: strings(sections.completed), projectProgress: strings(sections.projectProgress),
            risks: strings(sections.risks), tomorrowPlan: strings(sections.tomorrowPlan),
          },
          sourceTimelineBlockIds: strings(parsed.sourceTimelineBlockIds), sourceFactIds: strings(parsed.sourceFactIds),
          sourceSceneIds: report.sourceSceneIds,
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

function registerPersonalReviewHandlers(deps: IpcDeps): void {
  ipcMain.handle("personalReview:generate", async (_event, input: unknown) => {
    const parsed = PersonalReviewGenerateInputSchema.safeParse(input);
    if (!parsed.success) {
      fail(
        "schema_invalid",
        `personalReview:generate 参数校验失败: ${parsed.error.message}`,
      );
    }
    if (!deps.personalReviewWriterWorker) {
      fail("not_ready", "PersonalReviewWriterWorker 未初始化");
    }
    try {
      const result = await deps.personalReviewWriterWorker.writePersonalReview(
        parsed.data.dateKey,
        parsed.data.generationRequirement,
      );
      if (result.ok) {
        return { ok: true as const, data: result };
      }
      return {
        ok: false as const,
        error: result.errorMessage ?? "personal review 生成失败",
        code: result.errorCode,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  ipcMain.handle("personalReview:get", (_event, dateKey: string) => {
    if (!deps.reportRepo) {
      fail("not_ready", "ReportRepository 未初始化");
    }
    try {
      const report = deps.reportRepo.getByTypeAndDate("personal_daily_review", dateKey);
      if (!report) {
        return { ok: true as const, data: null };
      }
      try {
        const parsed = JSON.parse(report.contentJson) as Record<string, unknown>;
        const personalReview: PersonalReview = {
          id: typeof parsed.id === "string" ? parsed.id : report.id,
          dateKey: typeof parsed.dateKey === "string" ? parsed.dateKey : report.dateKey,
          title: typeof parsed.title === "string" ? parsed.title : report.title,
          overview: typeof parsed.overview === "string" ? parsed.overview : "",
          mainThreads: Array.isArray(parsed.mainThreads) ? (parsed.mainThreads as string[]) : [],
          meaningfulProgress: Array.isArray(parsed.meaningfulProgress)
            ? (parsed.meaningfulProgress as string[])
            : [],
          unfinished: Array.isArray(parsed.unfinished)
            ? (parsed.unfinished as PersonalReview["unfinished"])
            : [],
          worthRemembering: Array.isArray(parsed.worthRemembering)
            ? (parsed.worthRemembering as PersonalReview["worthRemembering"])
            : [],
          tomorrowStartHere: Array.isArray(parsed.tomorrowStartHere)
            ? (parsed.tomorrowStartHere as string[])
            : [],
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
        };
        return { ok: true as const, data: personalReview };
      } catch {
        return { ok: true as const, data: null };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });
}

function registerUnfinishedThreadHandlers(deps: IpcDeps): void {
  ipcMain.handle(
    "unfinishedThreads:list",
    (_event, params?: { dateKey?: string; status?: string }) => {
      if (!deps.unfinishedThreadRepo) {
        fail("not_ready", "UnfinishedThreadRepository 未初始化");
      }
      try {
        if (params?.dateKey && params.status) {
          return {
            ok: true as const,
            data: deps.unfinishedThreadRepo.findByDateKeyAndStatus(
              params.dateKey,
              params.status,
            ),
          };
        }
        if (params?.status) {
          return {
            ok: true as const,
            data: deps.unfinishedThreadRepo.findByStatus(params.status),
          };
        }
        if (params?.dateKey) {
          return {
            ok: true as const,
            data: deps.unfinishedThreadRepo.findByDateKey(params.dateKey),
          };
        }
        return {
          ok: true as const,
          data: deps.unfinishedThreadRepo.findByStatus("open"),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: message, code: "unknown_error" };
      }
    },
  );

  ipcMain.handle(
    "unfinishedThreads:updateStatus",
    (
      _event,
      params: { id: string; status: "open" | "done" | "snoozed" | "ignored" },
    ) => {
      if (!deps.unfinishedThreadRepo) {
        fail("not_ready", "UnfinishedThreadRepository 未初始化");
      }
      if (
        !params ||
        typeof params.id !== "string" ||
        !["open", "done", "snoozed", "ignored"].includes(params.status)
      ) {
        fail("schema_invalid", "unfinishedThreads:updateStatus 参数校验失败");
      }
      try {
        const updated = deps.unfinishedThreadRepo.updateStatus(params.id, params.status);
        if (!updated) {
          return {
            ok: false as const,
            error: `未找到待收尾 ${params.id}`,
            code: "not_found",
          };
        }
        return { ok: true as const, data: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: message, code: "unknown_error" };
      }
    },
  );
}

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function failure(error: unknown) { return { ok: false as const, error: error instanceof Error ? error.message : String(error), code: "unknown_error" }; }

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}
