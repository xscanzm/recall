import type { BatchCaptureBundle } from "../models/types";
import type { CaptureInboxRepository } from "../db/repositories/CaptureInboxRepository";
import type {
  TimelineGenerationWindow,
  TimelineGenerationWindowRepository,
  TimelineWindowCloseReason,
} from "../db/repositories/TimelineGenerationWindowRepository";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { CaptureBatcher } from "./CaptureBatcher";
import type { BatchProcessor, BatchSettlementStatus } from "./BatchProcessor";
import type { CaptureService } from "./CaptureService";
import type { TimelineBuilderWorker } from "./TimelineBuilderWorker";
import { formatLocalDateKey, localDateKeyUtcRange } from "../utils/dateKey";

export const TIMELINE_COLLECTION_MS = 10 * 60 * 1_000;
export const TIMELINE_MIN_SPAN_MS = 5 * 60 * 1_000;
export const TIMELINE_SEAL_GRACE_MS = 5_000;

export interface TimelineWindowCoordinatorDeps {
  windowRepo: TimelineGenerationWindowRepository;
  observationRepo: ObservationRepository;
  captureInboxRepo: CaptureInboxRepository;
  timelineBuilderWorker: TimelineBuilderWorker;
  captureBatcher: Pick<CaptureBatcher, "flush">;
  batchProcessor: Pick<BatchProcessor, "drainThroughCapturedAt">;
  captureService?: Pick<CaptureService, "drain">;
  timelineBlockRepo?: Pick<TimelineBlockRepository, "deleteUnprotectedByDateKey">;
  now?: () => Date;
  pollIntervalMs?: number;
}

export class TimelineWindowCoordinator {
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly preparedDates = new Set<string>();
  private readonly preparedSealingWindows = new Set<string>();

  constructor(private readonly deps: TimelineWindowCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollIntervalMs = deps.pollIntervalMs ?? TIMELINE_SEAL_GRACE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.deps.windowRepo.resetInterruptedGenerating();
    void this.advance();
    this.timer = setInterval(() => void this.advance(), this.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  advance(at: Date = this.now()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doAdvance(at, true).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async onBatchSettled(status: BatchSettlementStatus, _bundle: BatchCaptureBundle): Promise<void> {
    if (status === "retry_pending") return;
    // sealWindow 正在等待 batch 时，完成回调会从同一条调用链回到这里。
    // 再等待 this.running 会形成 advance -> batch -> onBatchSettled -> advance 的环形等待。
    if (this.running) return;
    await this.advance();
  }

  finalizeTail(
    reason: Exclude<TimelineWindowCloseReason, "duration" | "rebuild">,
    options: { dateKey?: string; at?: Date; generate?: boolean } = {}
  ): Promise<void> {
    if (this.running) {
      return this.running.then(() => this.finalizeTail(reason, options));
    }
    const at = options.at ?? this.now();
    this.running = this.doFinalizeTail(reason, options.dateKey, at, options.generate ?? true)
      .finally(() => { this.running = null; });
    return this.running;
  }

  async preflightReport(dateKey: string): Promise<void> {
    await this.finalizeTail("report", { dateKey, generate: true });
    await this.advance(this.now());
    const incomplete = this.deps.windowRepo.listPendingGeneration()
      .find((window) => window.dateKey === dateKey);
    if (incomplete) {
      throw new Error(incomplete.lastError ?? `timeline_window_${incomplete.status}`);
    }
  }

  async persistTailForShutdown(): Promise<void> {
    this.stop();
    await this.finalizeTail("shutdown", { generate: false });
  }

  async rebuildWindow(windowId: string): Promise<void> {
    const window = this.deps.windowRepo.getById(windowId);
    if (!window || !window.timelineBlockId) return;
    this.deps.windowRepo.update(window.id, {
      status: "ready",
      closeReason: "rebuild",
      lastError: null,
    });
    await this.generateWindow(this.deps.windowRepo.getById(window.id)!);
  }

  async rebuildDate(dateKey: string): Promise<void> {
    for (const window of this.deps.windowRepo.listByDateKey(dateKey)) {
      if (!window.timelineBlockId) continue;
      await this.rebuildWindow(window.id);
    }
  }

  private async doAdvance(at: Date, allowModel: boolean): Promise<void> {
    if (this.stopped && allowModel) return;

    const pending = this.deps.windowRepo.listPendingGeneration()[0];
    if (pending) {
      if (allowModel) await this.generateWindow(pending);
      return;
    }
    await this.recoverPartialWindows(allowModel);

    for (let index = 0; index < 48; index++) {
      let active = this.deps.windowRepo.getActive();
      if (active && active.dateKey !== formatLocalDateKey(at)) {
        const dayEnd = new Date(localDateKeyUtcRange(active.dateKey).end);
        const rolloverEnd = new Date(Math.min(Date.parse(active.collectionEnd), dayEnd.getTime()));
        // 已经跨天的窗口不会再有新的采集落进来，等 unsettled 归零没有意义：
        // 强制封窗，把没结算的部分标成 partial，后续补齐再由 recoverPartialWindows 重建。
        await this.closeAndSeal(active, "day_rollover", rolloverEnd, allowModel, { force: true });
        const rolled = this.deps.windowRepo.getById(active.id);
        if (!rolled || rolled.status === "failed") return;
        // 兜底：万一封窗后状态没变，说明这一轮推进不了，直接退出，
        // 不要在同一个窗口上把 48 次循环耗光（那会让今天的窗口永远开不出来）。
        if (rolled.status === "sealing" || rolled.status === "collecting") return;
        continue;
      }
      if (!active) {
        active = this.openNextWindow(formatLocalDateKey(at), at);
        if (!active) return;
      }
      if (active.status === "collecting") {
        if (at.getTime() < Date.parse(active.collectionEnd) + TIMELINE_SEAL_GRACE_MS) return;
        active = this.deps.windowRepo.update(active.id, {
          status: "sealing",
          closeReason: "duration",
        });
      }
      await this.sealWindow(active, allowModel);
      const settled = this.deps.windowRepo.getById(active.id);
      if (!settled || settled.status === "sealing" || settled.status === "failed" || settled.status === "ready") return;
    }
  }

  private async doFinalizeTail(
    reason: Exclude<TimelineWindowCloseReason, "duration" | "rebuild">,
    requestedDateKey: string | undefined,
    at: Date,
    allowModel: boolean
  ): Promise<void> {
    const dateKey = requestedDateKey ?? formatLocalDateKey(at);
    let active = this.deps.windowRepo.getActive(requestedDateKey);
    if (!active) active = this.openNextWindow(dateKey, at);
    if (!active) {
      if (allowModel) {
        const pending = this.deps.windowRepo.listPendingGeneration()
          .find((window) => !requestedDateKey || window.dateKey === requestedDateKey);
        if (pending) await this.generateWindow(pending);
      }
      return;
    }
    const naturalEnd = Date.parse(active.collectionEnd);
    const requestedEnd = Math.max(Date.parse(active.collectionStart) + 1, at.getTime());
    const closeAt = new Date(Math.min(naturalEnd, requestedEnd));
    await this.closeAndSeal(active, reason, closeAt, allowModel);
  }

  private async closeAndSeal(
    window: TimelineGenerationWindow,
    reason: TimelineWindowCloseReason,
    closeAt: Date,
    allowModel: boolean,
    options: { force?: boolean } = {}
  ): Promise<void> {
    const updated = this.deps.windowRepo.update(window.id, {
      collectionEnd: closeAt.toISOString(),
      status: "sealing",
      closeReason: reason,
    });
    await this.sealWindow(updated, allowModel, options);
  }

  private openNextWindow(dateKey: string, at: Date): TimelineGenerationWindow | null {
    this.prepareToday(dateKey);
    const day = localDateKeyUtcRange(dateKey);
    const from = this.deps.windowRepo.getLastCollectionEnd(dateKey) ?? day.start;
    const to = new Date(Math.min(at.getTime() + 1, Date.parse(day.end))).toISOString();
    if (to <= from) return null;
    const first = this.deps.observationRepo.listByCapturedAt({
      from,
      to,
      limit: 1,
      order: "asc",
    })[0];
    if (!first) return null;
    const naturalEnd = Math.min(
      Date.parse(first.capturedAt) + TIMELINE_COLLECTION_MS,
      Date.parse(day.end)
    );
    return this.deps.windowRepo.create({
      dateKey,
      collectionStart: first.capturedAt,
      collectionEnd: new Date(naturalEnd).toISOString(),
    });
  }

  private async sealWindow(
    window: TimelineGenerationWindow,
    allowModel: boolean,
    options: { force?: boolean } = {}
  ): Promise<void> {
    try {
      // sealing 状态每 5 秒轮询一次。只在该窗口首次封窗时排空 producer，
      // 否则每轮都会把尚未攒满 6 帧的 L0 队列强制 flush 成单帧 batch。
      if (!this.preparedSealingWindows.has(window.id)) {
        await this.deps.captureService?.drain();
        await this.deps.captureBatcher.flush();
        this.preparedSealingWindows.add(window.id);
      }
      await this.deps.batchProcessor.drainThroughCapturedAt(
        window.collectionStart,
        window.collectionEnd
      );
      const watermark = this.deps.captureInboxRepo.getWindowWatermark(
        window.collectionStart,
        window.collectionEnd
      );
      if (watermark.unsettledCount > 0 && !options.force) return;

      const observations = this.deps.observationRepo.listByCapturedAt({
        from: window.collectionStart,
        to: window.collectionEnd,
        limit: Number.MAX_SAFE_INTEGER,
        order: "asc",
      });
      const actualStart = observations[0]?.capturedAt ?? null;
      const actualEnd = observations[observations.length - 1]?.capturedAt ?? null;
      const sourceCompleteness =
        watermark.failedCount > 0 || watermark.unsettledCount > 0 ? "partial" : "complete";
      const span = actualStart && actualEnd ? Date.parse(actualEnd) - Date.parse(actualStart) : 0;
      if (!actualStart || !actualEnd || span < TIMELINE_MIN_SPAN_MS) {
        this.preparedSealingWindows.delete(window.id);
        this.deps.windowRepo.update(window.id, {
          actualStart,
          actualEnd,
          sourceObservationCount: observations.length,
          sourceCompleteness,
          status: "skipped",
          sealedAt: this.now().toISOString(),
          lastError: span < TIMELINE_MIN_SPAN_MS ? "actual_span_below_five_minutes" : "empty_window",
        });
        return;
      }

      const ready = this.deps.windowRepo.update(window.id, {
        actualStart,
        actualEnd,
        sourceObservationCount: observations.length,
        sourceCompleteness,
        status: "ready",
        sealedAt: this.now().toISOString(),
        lastError: null,
      });
      this.preparedSealingWindows.delete(window.id);
      if (allowModel) await this.generateWindow(ready);
    } catch (error) {
      this.preparedSealingWindows.delete(window.id);
      this.deps.windowRepo.update(window.id, {
        status: "failed",
        lastError: errorMessage(error),
        incrementRetry: true,
      });
    }
  }

  private async generateWindow(window: TimelineGenerationWindow): Promise<void> {
    const generating = this.deps.windowRepo.update(window.id, {
      status: "generating",
      lastError: null,
    });
    const result = await this.deps.timelineBuilderWorker.buildWindow({
      dateKey: generating.dateKey,
      collectionStart: generating.collectionStart,
      collectionEnd: generating.collectionEnd,
      sourceCompleteness: generating.sourceCompleteness,
      existingTimelineBlockId: generating.timelineBlockId,
    });
    if (!result.ok || !result.block) {
      this.deps.windowRepo.update(generating.id, {
        status: "failed",
        lastError: result.errorMessage ?? result.errorCode ?? "timeline_generation_failed",
        incrementRetry: true,
      });
      return;
    }
    this.deps.windowRepo.update(generating.id, {
      status: "succeeded",
      timelineBlockId: result.block.id,
      lastError: null,
    });
  }

  private async recoverPartialWindows(allowModel: boolean): Promise<void> {
    if (!allowModel) return;
    for (const window of this.deps.windowRepo.listSucceededPartial()) {
      const watermark = this.deps.captureInboxRepo.getWindowWatermark(
        window.collectionStart,
        window.collectionEnd
      );
      if (watermark.unsettledCount > 0 || watermark.failedCount > 0) continue;
      const ready = this.deps.windowRepo.update(window.id, {
        status: "ready",
        sourceCompleteness: "complete",
        closeReason: "rebuild",
      });
      await this.generateWindow(ready);
    }
  }

  private prepareToday(dateKey: string): void {
    if (this.preparedDates.has(dateKey)) return;
    this.preparedDates.add(dateKey);
    if (dateKey !== formatLocalDateKey(this.now())) return;
    if (this.deps.windowRepo.listByDateKey(dateKey).length === 0) {
      this.deps.timelineBlockRepo?.deleteUnprotectedByDateKey(dateKey);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
