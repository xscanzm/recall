// src/main/services/EpisodeBuilder.ts
// L1 Episode Builder（规则版）
//
// 目标：
// - 从一批已落库的 L0 observations 中切出 1~N 个工作片段（Episode）
// - 第一版不调用模型，不依赖 facts，不尝试更新长期对象
// - 复用现有 scenes 表作为 Episode 落库面，后续再决定是否更名/迁移
// - 为每个 Episode 建立 scene -> observation 的 contains 边

import type { CaptureBundle, CreateSceneInput, Observation, Scene } from "../models/types";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { MemoryEdgeRepository } from "../db/repositories/MemoryEdgeRepository";

export interface EpisodeCandidateItem {
  observation: Observation;
  bundle: CaptureBundle;
}

interface EpisodeGroup {
  items: EpisodeCandidateItem[];
}

export class EpisodeBuilder {
  private readonly sceneRepo: SceneRepository;
  private readonly edgeRepo: MemoryEdgeRepository | null;

  constructor(deps: {
    sceneRepo: SceneRepository;
    edgeRepo?: MemoryEdgeRepository;
  }) {
    this.sceneRepo = deps.sceneRepo;
    this.edgeRepo = deps.edgeRepo ?? null;
  }

  buildFromBatch(input: {
    items: EpisodeCandidateItem[];
  }): Scene[] {
    const items = input.items.filter((item) => !!item.observation && !!item.bundle);
    if (items.length === 0) return [];

    const groups = this.groupItems(items);
    const scenes: Scene[] = [];

    for (const group of groups) {
      const scene = this.sceneRepo.create(this.toSceneInput(group));
      scenes.push(scene);
      this.writeEdges(scene, group);
    }

    return scenes;
  }

  private groupItems(items: EpisodeCandidateItem[]): EpisodeGroup[] {
    const groups: EpisodeGroup[] = [];
    let current: EpisodeGroup | null = null;

    for (const item of items) {
      if (!current) {
        current = { items: [item] };
        groups.push(current);
        continue;
      }

      const prev = current.items[current.items.length - 1];
      if (this.shouldSplit(prev, item)) {
        current = { items: [item] };
        groups.push(current);
      } else {
        current.items.push(item);
      }
    }

    return groups;
  }

  private shouldSplit(prev: EpisodeCandidateItem, current: EpisodeCandidateItem): boolean {
    const prevObs = prev.observation;
    const curObs = current.observation;
    const curBundle = current.bundle;

    const gapMs =
      Date.parse(curObs.capturedAt) - Date.parse(prevObs.capturedAt);
    if (Number.isFinite(gapMs) && gapMs > 3 * 60 * 1000) {
      return true;
    }

    if (curBundle.captureReason === "scene_boundary" || curBundle.captureReason === "project_switch") {
      return true;
    }

    if (prevObs.appName !== curObs.appName) {
      return true;
    }

    const prevDomain = (prevObs.urlOrDomain ?? "").trim().toLowerCase();
    const curDomain = (curObs.urlOrDomain ?? "").trim().toLowerCase();
    if (prevDomain && curDomain && prevDomain !== curDomain) {
      return true;
    }

    const prevTitle = normalizeWindowTitle(prevObs.windowTitle);
    const curTitle = normalizeWindowTitle(curObs.windowTitle);
    if (prevTitle && curTitle && prevTitle !== curTitle) {
      return true;
    }

    return false;
  }

  private toSceneInput(group: EpisodeGroup): CreateSceneInput {
    const first = group.items[0].observation;
    const last = group.items[group.items.length - 1].observation;
    const title = deriveEpisodeTitle(first);
    const summary = deriveEpisodeSummary(group.items.map((i) => i.observation));
    const entityNames = Array.from(
      new Set(
        group.items.flatMap((i) => extractEntityNames(i.observation))
      )
    );
    const confidence =
      group.items.reduce((sum, i) => sum + (i.observation.confidence ?? 0), 0) /
      Math.max(group.items.length, 1);

    return {
      title,
      summary,
      startAt: first.capturedAt,
      endAt: last.capturedAt,
      projectId: null,
      confidence: Number.isFinite(confidence) ? confidence : 0.6,
      activityCategory: "unknown",
      activityConfidence: 0,
      factIds: [],
      observationIds: group.items.map((i) => i.observation.id),
      entityNames,
      taskIds: [],
      decisionIds: [],
      derivationKey: `episode:v1:${group.items.map((item) => item.observation.id).join(",")}`,
      derivationVersion: 1,
    };
  }

  private writeEdges(scene: Scene, group: EpisodeGroup): void {
    if (!this.edgeRepo) return;
    for (const item of group.items) {
      try {
        this.edgeRepo.create({
          fromType: "scene",
          fromId: scene.id,
          toType: "observation",
          toId: item.observation.id,
          relationType: "contains",
          confidence: 1,
          createdBy: "system",
          evidenceIds: [item.observation.id],
          status: "active",
          reason: "batch_episode_builder",
        });
      } catch {
        // 单条 edge 失败不阻断 episode 持久化
      }
    }
  }
}

function deriveEpisodeTitle(obs: Observation): string {
  const app = (obs.appName || "活动").trim();
  const win = trimWindowTitle(obs.windowTitle);
  if (win && win.toLowerCase() !== app.toLowerCase()) {
    return `${app}：${win}`;
  }
  return app;
}

function deriveEpisodeSummary(observations: Observation[]): string {
  const candidates = observations
    .map((o) => (o.userFacingSummary ?? o.sceneSummary ?? "").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));
  if (unique.length === 0) {
    return "这一段时间围绕同一上下文持续活动。";
  }
  if (unique.length === 1) {
    return unique[0];
  }
  if (unique.length === 2) {
    return `${unique[0]} ${unique[1]}`;
  }
  return `${unique[0]} 其间上下文持续延续，并出现了相关细节变化。`;
}

function extractEntityNames(obs: Observation): string[] {
  if (!Array.isArray(obs.detectedEntities)) return [];
  const names: string[] = [];
  for (const item of obs.detectedEntities) {
    if (!item || typeof item !== "object") continue;
    const name = (item as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) {
      names.push(name.trim());
    }
  }
  return names;
}

function normalizeWindowTitle(value: string): string {
  return trimWindowTitle(value).toLowerCase();
}

function trimWindowTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 48);
}
