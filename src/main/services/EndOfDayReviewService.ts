import { BrowserWindow, screen } from "electron";
import * as path from "node:path";
import type { EndOfDayReview, ReportGeneratedEvent } from "../../shared/types";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { UnfinishedThreadRepository } from "../db/repositories/UnfinishedThreadRepository";
import type { SettingsService } from "./SettingsService";
import { formatLocalDateKey } from "../utils/dateKey";
import { installNavigationGuards } from "./navigationGuard";

interface DailyState {
  dateKey: string;
  shown: number;
  dismissed: boolean;
  viewed: boolean;
  snoozedUntil: number | null;
  firedSlots: string[];
}

interface EndOfDayReviewServiceDeps {
  settingsService: SettingsService;
  timelineBlockRepo: TimelineBlockRepository;
  unfinishedThreadRepo: UnfinishedThreadRepository;
  getMainWindow: () => BrowserWindow | null;
  openToday: () => void;
  openReports?: () => void;
  isDev: () => boolean;
  devServerUrl?: string;
}

export class EndOfDayReviewService {
  private timer: NodeJS.Timeout | null = null;
  private popup: BrowserWindow | null = null;
  private locked = false;
  private state: DailyState = this.newState(formatLocalDateKey(new Date()));
  private currentReview: EndOfDayReview | null = null;
  private currentReportNotification: ReportGeneratedEvent | null = null;

  constructor(private deps: EndOfDayReviewServiceDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 60_000);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closePopup();
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked) this.closePopup();
  }

  getCurrentReview(): EndOfDayReview | null {
    return this.currentReview;
  }

  getCurrentReportNotification(): ReportGeneratedEvent | null {
    return this.currentReportNotification;
  }

  showReportNotification(report: ReportGeneratedEvent): void {
    if (this.locked) return;
    this.currentReportNotification = report;
    this.currentReview = null;
    this.closePopup();
    this.showPopup("report-generated");
  }

  dismissReportNotification(): void {
    this.currentReportNotification = null;
    this.closePopup();
  }

  openReportNotification(): void {
    this.currentReportNotification = null;
    this.closePopup();
    this.deps.openReports?.();
  }

  dismiss(): void {
    this.state.dismissed = true;
    this.closePopup();
  }

  snooze(minutes = 30): void {
    if (this.state.shown >= 2) {
      this.dismiss();
      return;
    }
    this.state.snoozedUntil = Date.now() + minutes * 60_000;
    this.closePopup();
  }

  viewToday(): void {
    this.state.viewed = true;
    this.closePopup();
    this.deps.openToday();
  }

  markExpired(): void {
    this.closePopup();
  }

  private tick(now = new Date()): void {
    const dateKey = formatLocalDateKey(now);
    if (this.state.dateKey !== dateKey) this.state = this.newState(dateKey);

    const settings = this.deps.settingsService.getAll().endOfDayReview;
    if (!settings.enabled || this.locked || this.state.dismissed || this.state.viewed || this.popup) return;
    if (this.state.shown >= 2) return;

    const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dueSlot = [settings.firstTime, settings.secondTime].find(
      (time) => time === current && !this.state.firedSlots.includes(time)
    );
    const snoozeDue = this.state.snoozedUntil !== null && now.getTime() >= this.state.snoozedUntil;
    if (!dueSlot && !snoozeDue) return;

    if (dueSlot) this.state.firedSlots.push(dueSlot);
    this.state.snoozedUntil = null;
    this.show(dateKey);
  }

  private show(dateKey: string): void {
    const review = this.buildReview(dateKey);
    if (review.empty) return;
    this.currentReview = review;
    this.currentReportNotification = null;
    this.state.shown += 1;

    this.showPopup("end-of-day-review");
  }

  private showPopup(windowName: "end-of-day-review" | "report-generated"): void {

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = 410;
    const height = 520;
    const margin = 18;
    const { workArea } = display;
    const win = new BrowserWindow({
      width,
      height,
      x: workArea.x + workArea.width - width - margin,
      y: workArea.y + workArea.height - height - margin,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: "#F7F6F2",
      webPreferences: {
        preload: path.join(__dirname, "..", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    // 弹窗渲染的是模型生成的日报正文，同样按不可信内容处理。
    installNavigationGuards(win.webContents, () => ({
      // __dirname = dist/main/services，renderer 在 dist/renderer
      rendererRoot: path.join(__dirname, "..", "..", "renderer"),
      devServerUrl: this.deps.isDev() ? this.deps.devServerUrl : undefined,
    }));

    this.popup = win;
    win.on("closed", () => {
      if (this.popup === win) this.popup = null;
    });
    win.once("ready-to-show", () => win.showInactive());

    if (this.deps.isDev() && this.deps.devServerUrl) {
      void win.loadURL(`${this.deps.devServerUrl}?window=${windowName}`);
    } else {
      void win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"), {
        query: { window: windowName },
      });
    }
  }

  private buildReview(dateKey: string): EndOfDayReview {
    const completed = this.deps.timelineBlockRepo.findByDateKey(dateKey)
      .filter((block) => block.privateRisk !== "high")
      .flatMap((block) => {
        const lines = block.highlights.length > 0 ? block.highlights : [block.summary || block.title];
        return lines.filter(Boolean).map((text) => ({
          id: block.id,
          text,
          sourceType: "timeline_block" as const,
        }));
      })
      .slice(0, 3);

    const attention = this.deps.unfinishedThreadRepo.findByDateKey(dateKey)
      .filter((thread) => thread.status === "open" && thread.confidence >= 0.5)
      .slice(0, 3)
      .map((thread) => ({
        id: thread.id,
        text: thread.title || thread.reason,
        sourceType: "unfinished_thread" as const,
      }));

    return { dateKey, completed, attention, empty: completed.length === 0 && attention.length === 0 };
  }

  private closePopup(): void {
    const win = this.popup;
    this.popup = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  private newState(dateKey: string): DailyState {
    return { dateKey, shown: 0, dismissed: false, viewed: false, snoozedUntil: null, firedSlots: [] };
  }
}
