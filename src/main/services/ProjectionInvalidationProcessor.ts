import type { CorrectionLifecycleRepository, ProjectionInvalidation } from "../db/repositories/CorrectionLifecycleRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { Fact, Scene } from "../models/types";
import { formatLocalDateKey } from "../utils/dateKey";
import type { SceneRelationProjector } from "./SceneRelationProjector";
import type { TimelineBuilderWorker } from "./TimelineBuilderWorker";

export class ProjectionInvalidationProcessor {
  private running: Promise<void> | null = null;

  constructor(private readonly deps: {
    correctionLifecycleRepo: CorrectionLifecycleRepository;
    factRepo: FactRepository;
    sceneRepo: SceneRepository;
    timelineBlockRepo: TimelineBlockRepository;
    reportRepo: ReportRepository;
    timelineBuilderWorker: TimelineBuilderWorker;
    sceneRelationProjector: SceneRelationProjector;
  }) {}

  processPending(limit = 100): Promise<void> {
    if (this.running) return this.running;
    this.running = this.drain(limit).finally(() => { this.running = null; });
    return this.running;
  }

  private async drain(limit: number): Promise<void> {
    while (true) {
      const items = this.deps.correctionLifecycleRepo.claimPending(limit);
      if (items.length === 0) return;
      for (const item of items) {
        try {
          await this.processItem(item);
          this.deps.correctionLifecycleRepo.markCompleted(item.id);
        } catch (error) {
          this.deps.correctionLifecycleRepo.markFailed(item.id, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  private async processItem(item: ProjectionInvalidation): Promise<void> {
    const affected = this.resolveAffected(item);
    if (item.projectionType === "timeline") {
      for (const date of affected.dates) {
        const result = await this.deps.timelineBuilderWorker.reorganizeDay(date);
        if (!result.ok) throw new Error(result.errorMessage ?? result.errorCode ?? `timeline rebuild failed for ${date}`);
      }
    } else if (item.projectionType === "report") {
      const reports = item.targetType === "fact"
        ? [
            ...this.deps.reportRepo.findReportsReferencingFact(item.targetId),
            ...affected.scenes.flatMap((scene) => this.deps.reportRepo.findReportsReferencingScene(scene.id)),
          ]
        : item.targetType === "scene"
          ? this.deps.reportRepo.findReportsReferencingScene(item.targetId)
          : [];
      this.deps.reportRepo.markStaleMany([...new Set(reports.map((report) => report.id))], item.reason);
    } else if (item.projectionType === "l3") {
      for (const scene of affected.scenes) {
        if (!scene.deletedAt) this.deps.sceneRelationProjector.projectScene(scene);
      }
    }
    // Search requires no work here: SQLite FTS triggers update it synchronously.
  }

  private resolveAffected(item: ProjectionInvalidation): { dates: string[]; scenes: Scene[] } {
    let fact: Fact | null = null;
    let scenes: Scene[] = [];
    if (item.targetType === "fact") {
      fact = this.deps.factRepo.getById(item.targetId) ?? this.revisionValue<Fact>(item, "before");
      scenes = uniqueScenes([
        ...this.deps.sceneRepo.listByFactId(item.targetId),
        ...this.deps.sceneRepo.listByIds(fact?.sourceEpisodeIds ?? []),
      ]);
    } else if (item.targetType === "scene") {
      const scene = this.deps.sceneRepo.getById(item.targetId) ?? this.revisionValue<Scene>(item, "before");
      if (scene) scenes = [scene];
    }

    const dates = new Set<string>();
    if (fact?.createdAt) dates.add(formatLocalDateKey(new Date(fact.createdAt)));
    for (const scene of scenes) addDateRange(dates, scene.startAt, scene.endAt);
    return { dates: [...dates].sort(), scenes };
  }

  private revisionValue<T>(item: ProjectionInvalidation, key: "before" | "after"): T | null {
    const revision = this.deps.correctionLifecycleRepo.listRevisions(item.targetType, item.targetId)[0];
    return (revision?.[key] as T | null | undefined) ?? null;
  }
}

function uniqueScenes(scenes: Scene[]): Scene[] {
  return [...new Map(scenes.map((scene) => [scene.id, scene])).values()];
}

function addDateRange(dates: Set<string>, startAt: string, endAt: string): void {
  const current = new Date(startAt);
  const end = new Date(endAt);
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(end.getTime())) return;
  current.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  while (current <= end) {
    dates.add(formatLocalDateKey(current));
    current.setDate(current.getDate() + 1);
  }
}
