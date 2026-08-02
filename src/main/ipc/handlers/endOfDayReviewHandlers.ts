import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import { handleValidated } from "../validated";

/**
 * endOfDayReview:* 与 reports:notification:*（均由 EndOfDayReviewService 维护弹窗/通知状态）
 */
export function registerEndOfDayReviewHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "endOfDayReview:get", () =>
    deps.endOfDayReviewService?.getCurrentReview() ?? null
  );
  handleValidated(ipcMain, "endOfDayReview:viewToday", () => {
    deps.endOfDayReviewService?.viewToday();
    return { ok: true };
  });
  handleValidated(ipcMain, "endOfDayReview:snooze", () => {
    deps.endOfDayReviewService?.snooze(30);
    return { ok: true };
  });
  handleValidated(ipcMain, "endOfDayReview:dismiss", () => {
    deps.endOfDayReviewService?.dismiss();
    return { ok: true };
  });
  handleValidated(ipcMain, "endOfDayReview:expired", () => {
    deps.endOfDayReviewService?.markExpired();
    return { ok: true };
  });

  // 报告生成通知卡片（与 endOfDayReview 共用同一服务状态）
  handleValidated(ipcMain, "reports:notification:get", () =>
    deps.endOfDayReviewService?.getCurrentReportNotification() ?? null
  );
  handleValidated(ipcMain, "reports:notification:dismiss", () => {
    deps.endOfDayReviewService?.dismissReportNotification();
    return { ok: true };
  });
  handleValidated(ipcMain, "reports:notification:open", () => {
    deps.endOfDayReviewService?.openReportNotification();
    return { ok: true };
  });
}
