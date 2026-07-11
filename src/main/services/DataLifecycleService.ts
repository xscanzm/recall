import type { DB } from "../db/Database";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { ScreenshotCache } from "./ScreenshotCache";
import type { CaptureService } from "./CaptureService";
import type { CaptureBatcher } from "./CaptureBatcher";
import type { BatchProcessor } from "./BatchProcessor";
import type { Fact, Scene } from "../models/types";
import { localDayUtcRange } from "../utils/dateKey";

export type ForgetDuration = "15m" | "30m" | "1h" | "today";
export interface FileCleanupStatus {
  status: "complete" | "partial" | "failed";
  attempted: number;
  deleted: number;
  failed: number;
}

interface Dependencies {
  db: DB;
  observationRepo: ObservationRepository;
  factRepo: FactRepository;
  sceneRepo: SceneRepository;
  screenshotCache: ScreenshotCache;
  captureService: CaptureService;
  captureBatcher: CaptureBatcher;
  batchProcessor: BatchProcessor;
  isObserving: () => boolean;
  pauseSources: () => void;
  resumeSources: () => void;
  cascade: (facts: Fact[], scenes: Scene[]) => void;
}

const CLEAR_TABLES = [
  "observations", "facts", "scenes", "projects", "tasks", "people", "decisions",
  "memory_edges", "proactive_items", "reports", "timeline_blocks", "report_selections",
  "unfinished_threads", "object_merges", "user_feedback", "model_jobs", "capture_batches", "capture_inbox",
] as const;

export class DataLifecycleService {
  private active = false;

  constructor(private readonly deps: Dependencies) {}

  async forgetRecent(duration: ForgetDuration) {
    return this.exclusive(async () => {
      const range = duration === "today"
        ? localDayUtcRange()
        : { start: new Date(Date.now() - minutes(duration) * 60_000).toISOString(), end: new Date().toISOString() };
      const observations = this.deps.observationRepo.listByCapturedAt({ from: range.start, to: range.end, limit: 100_000 });
      const ids = observations.map((item) => item.id);
      const paths = observations.flatMap((item) => item.screenshotPaths);
      let deletedObservations = 0;
      this.deps.db.transaction(() => {
        const facts = this.deps.factRepo.softDeleteBySourceObservationIds(ids);
        const scenes = this.deps.sceneRepo.softDeleteByObservationIds(ids);
        this.deps.cascade(facts, scenes);
        this.deleteCaptureLedger(range.start, range.end);
        deletedObservations = this.deps.observationRepo.deleteByCapturedAt(range.start, range.end);
      })();
      const fileCleanup = await this.cleanupFiles(paths);
      return { ok: true as const, deletedObservations, deletedScreenshots: fileCleanup.deleted, fileCleanup };
    });
  }

  private deleteCaptureLedger(start: string, end: string): void {
    const matchingBatches = `
      SELECT batch_id FROM capture_batches
      WHERE EXISTS (
        SELECT 1 FROM json_each(capture_batches.bundle_json, '$.frames') AS frame
        WHERE json_extract(frame.value, '$.capturedAt') >= ?
          AND json_extract(frame.value, '$.capturedAt') <= ?
      )`;
    this.deps.db.prepare(
      `DELETE FROM capture_inbox
       WHERE (json_extract(bundle_json, '$.capturedAt') >= ? AND json_extract(bundle_json, '$.capturedAt') <= ?)
          OR batch_id IN (${matchingBatches})`
    ).run(start, end, start, end);
    this.deps.db.prepare(`DELETE FROM capture_batches WHERE batch_id IN (${matchingBatches})`)
      .run(start, end);
  }

  async clearAll() {
    return this.exclusive(async () => {
      const observations = this.deps.observationRepo.listByCapturedAt({ limit: 100_000 });
      const paths = observations.flatMap((item) => item.screenshotPaths);
      this.deps.db.transaction(() => {
        for (const table of CLEAR_TABLES) this.deps.db.prepare(`DELETE FROM ${table}`).run();
      })();
      const fileCleanup = await this.cleanupFiles(paths, true);
      return { ok: true as const, deletedObservations: observations.length, deletedScreenshots: fileCleanup.deleted, fileCleanup };
    });
  }

  async clearScreenshots() {
    return this.exclusive(async () => {
      const observations = this.deps.observationRepo.listByCapturedAt({ limit: 100_000 });
      const paths = observations.flatMap((item) => item.screenshotPaths);
      this.deps.db.transaction(() => {
        for (const item of observations) this.deps.observationRepo.updateScreenshotRetention(item.id, "deleted");
      })();
      const fileCleanup = await this.cleanupFiles(paths, true);
      return { ok: true as const, deletedScreenshots: fileCleanup.deleted, fileCleanup };
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error("另一项数据清理操作正在进行，请稍后重试");
    this.active = true;
    let wasObserving = false;
    let paused = false;
    try {
      wasObserving = this.deps.isObserving();
      this.deps.pauseSources();
      paused = true;
      await this.deps.captureService.drain();
      await this.deps.captureBatcher.suspendAndFlush();
      await this.deps.batchProcessor.drain();
      return await operation();
    } finally {
      if (paused) {
        this.deps.captureBatcher.resumeAccepting();
        if (wasObserving) this.deps.resumeSources();
      }
      this.active = false;
    }
  }

  private async cleanupFiles(paths: string[], includeOrphans = false): Promise<FileCleanupStatus> {
    const unique = [...new Set(paths)];
    try {
      const result = includeOrphans
        ? await this.deps.screenshotCache.clearAll()
        : await this.deps.screenshotCache.deleteFiles(unique);
      const failed = result.failed;
      return { status: failed === 0 ? "complete" : result.deletedScreenshots ? "partial" : "failed", attempted: result.attempted, deleted: result.deletedScreenshots, failed };
    } catch {
      return { status: "failed", attempted: unique.length, deleted: 0, failed: unique.length };
    }
  }
}

function minutes(duration: Exclude<ForgetDuration, "today">): number {
  return duration === "15m" ? 15 : duration === "30m" ? 30 : 60;
}
