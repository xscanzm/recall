import { ipcMain } from "electron";
import { z } from "zod";
import type { IpcDeps } from "../handlers";
import type { Scene } from "../../models/types";
import type { TimelineBlock } from "../../../shared/types";
import {
  PrivacyRuleIdSchema,
  ReportGenerateInputSchema,
  ReportUpdateInputSchema,
} from "../../models/schemas";

function fail(code: string, message: string): never {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  throw error;
}

export function registerReportHandlers(deps: IpcDeps): void {
  ipcMain.handle("reports:list", (_event, input: unknown) => {
    const allowedTypes = [
      "daily",
      "weekly",
      "monthly",
      "retrospective",
      "personal_daily_review",
      "work_daily_report",
    ];
    const filter: {
      type?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: number;
    } = {};
    if (input && typeof input === "object") {
      const objectInput = input as Record<string, unknown>;
      if (typeof objectInput.type === "string" && allowedTypes.includes(objectInput.type)) {
        filter.type = objectInput.type;
      }
      if (typeof objectInput.dateFrom === "string") filter.dateFrom = objectInput.dateFrom;
      if (typeof objectInput.dateTo === "string") filter.dateTo = objectInput.dateTo;
      if (
        typeof objectInput.limit === "number" &&
        Number.isFinite(objectInput.limit) &&
        objectInput.limit > 0
      ) {
        filter.limit = Math.min(Math.floor(objectInput.limit), 200);
      }
    }
    try {
      return deps.reportRepo?.list(filter) ?? [];
    } catch {
      return [];
    }
  });

  ipcMain.handle("reports:get", (_event, input: unknown) => {
    const idParsed = PrivacyRuleIdSchema.safeParse(input);
    if (!idParsed.success) {
      fail("schema_invalid", `reports:get 参数校验失败: ${idParsed.error.message}`);
    }
    try {
      return deps.reportRepo?.getById(idParsed.data.id) ?? null;
    } catch {
      return null;
    }
  });

  ipcMain.handle("reports:getImage", async (_event, input: unknown) => {
    const parsed = z.object({ id: z.string().min(1).max(200) }).safeParse(input);
    if (!parsed.success) {
      return {
        ok: false as const,
        error: `reports:getImage 参数校验失败: ${parsed.error.message}`,
        code: "schema_invalid",
      };
    }
    if (!deps.infographicService) {
      return { ok: true as const, data: null };
    }
    try {
      return { ok: true as const, data: await deps.infographicService.getImage(parsed.data.id) };
    } catch {
      return { ok: true as const, data: null };
    }
  });

  ipcMain.handle("reports:getEvidenceByIds", (_event, input: unknown) => {
    const parsed = z
      .object({
        factIds: z.array(z.string().min(1)).max(200).optional().default([]),
        sceneIds: z.array(z.string().min(1)).max(200).optional().default([]),
        blockIds: z.array(z.string().min(1)).max(200).optional().default([]),
      })
      .safeParse(input);
    if (!parsed.success) {
      return {
        ok: false as const,
        error: `reports:getEvidenceByIds 参数校验失败: ${parsed.error.message}`,
        code: "schema_invalid",
      };
    }
    if (!deps.factRepo || !deps.sceneRepo || !deps.timelineBlockRepo) {
      return {
        ok: false as const,
        error: "报告证据查询依赖未初始化。",
        code: "not_ready",
      };
    }

    try {
      const factIds = dedupeIds(parsed.data.factIds);
      const sceneIds = dedupeIds(parsed.data.sceneIds);
      const blockIds = dedupeIds(parsed.data.blockIds);

      const facts = deps.factRepo.listByIds(factIds);
      const scenes = sceneIds
        .map((id) => deps.sceneRepo?.getByIdActive(id) ?? null)
        .filter((scene): scene is Scene => scene !== null);
      const timelineBlocks = blockIds
        .map((id) => deps.timelineBlockRepo?.findById(id) ?? null)
        .filter((block): block is TimelineBlock => block !== null);

      return {
        ok: true as const,
        data: { facts, scenes, timelineBlocks },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false as const, error: message, code: "unknown_error" };
    }
  });

  ipcMain.handle("reports:generate", async (_event, input: unknown) => {
    const parsed = ReportGenerateInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `reports:generate 参数校验失败: ${parsed.error.message}`);
    }
    const { type, dateKey, projectId, generationRequirement } = parsed.data;
    if (type === "retrospective") {
      return {
        ok: false,
        code: "not_implemented",
        message: "项目复盘报告暂未实现。",
      };
    }
    if (!deps.reportScheduler) {
      return {
        ok: false,
        code: "not_ready",
        message: "报告调度器未初始化。",
      };
    }
    try {
      let result;
      if (type === "daily") {
        result = await deps.reportScheduler.generateDailyReportNow(
          dateKey,
          generationRequirement,
        );
      } else if (type === "monthly") {
        result = await deps.reportScheduler.generateMonthlyReportNow(
          dateKey.slice(0, 7),
          generationRequirement,
        );
        if (result.ok && result.reportId && deps.reportRepo) {
          deps.reportRepo.update(result.reportId, {
            type: "monthly",
            projectId: projectId ?? null,
          });
        }
      } else {
        result = await deps.reportScheduler.generateWeeklyReportNow(dateKey, {
          generationRequirement,
        });
      }
      if (
        projectId &&
        result.ok &&
        result.reportId &&
        deps.reportRepo &&
        type !== "monthly"
      ) {
        deps.reportRepo.update(result.reportId, { projectId });
      }
      if (result.ok) {
        return { ok: true, reportId: result.reportId };
      }
      return {
        ok: false,
        code: result.errorCode ?? "unknown_error",
        message: result.errorMessage ?? "报告生成失败。",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, code: "unknown_error", message };
    }
  });

  ipcMain.handle("reports:update", (_event, input: unknown) => {
    const parsed = ReportUpdateInputSchema.safeParse(input);
    if (!parsed.success) {
      fail("schema_invalid", `reports:update 参数校验失败: ${parsed.error.message}`);
    }
    const { id, contentJson } = parsed.data;
    if (!deps.reportRepo) {
      fail("not_ready", "ReportRepository 未初始化");
    }
    try {
      JSON.parse(contentJson);
    } catch {
      fail("schema_invalid", "reports:update contentJson 不是合法 JSON");
    }
    const updated = deps.reportRepo.update(id, { contentJson });
    if (!updated) {
      fail("not_found", `未找到报告 ${id}`);
    }
    void deps.infographicService?.deleteImage(id);
    return { ok: true, report: updated };
  });

  ipcMain.handle("reports:delete", (_event, input: { id: string }) => {
    if (!deps.reportRepo) {
      fail("not_ready", "ReportRepository 未初始化");
    }
    if (!input || typeof input.id !== "string") {
      fail("schema_invalid", "reports:delete 参数校验失败: 缺少 id");
    }
    const deleted = deps.reportRepo.deleteById(input.id);
    void deps.infographicService?.deleteImage(input.id);
    return deleted;
  });
}

function dedupeIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
}
