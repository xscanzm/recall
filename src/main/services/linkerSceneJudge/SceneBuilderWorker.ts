// src/main/services/linkerSceneJudge/SceneBuilderWorker.ts
// SceneBuilder 职责模块（从 LinkerSceneJudgeWorker.ts 拆分，代码原样迁移）：
// - 数据查询：fetchFactsInTimeWindow / fetchActiveProjects / fetchRelatedTasks
// - writeScenes：写入 scenes 表（含 normalizeIsoToZ 时间归一化 + resolveProjectIdHint 项目解析）
//
// resolveProjectIdHint 以模块级函数导出：SceneBuilderWorker.writeScenes 与
// LinkerObjectWriter.inferProjectIdFromFacts 共用（原 LinkerSceneJudgeWorker 中
// resolveProjectId 为同一实例方法，两个调用点共用）。

import type { Fact, Scene } from "../../models/types";
import type { LinkerSceneJudgeOutput } from "../../models/schemas";
import type { SceneRepository } from "../../db/repositories/SceneRepository";
import type { MemoryObjectRepository } from "../../db/repositories/MemoryObjectRepository";
import type { FactRepository } from "../../db/repositories/FactRepository";
import { normalizeIsoToZ } from "../../utils/isoTime";
import type { SceneBuilderWorkerDeps } from "./types";

/**
 * 通过 projectHint 解析 projectId
 * - 精确匹配优先，模糊匹配（包含）次之
 * - 找不到返回 null
 */
export function resolveProjectIdHint(
  memoryObjectRepo: MemoryObjectRepository,
  projectHint?: string
): string | null {
  if (!projectHint) return null;
  try {
    const projects = memoryObjectRepo.listProjects({
      status: "active",
      limit: 50,
      includeNonPromoted: false,
    });
    const exactIdentity = memoryObjectRepo.findProjectByExactIdentity(projectHint);
    const exactMatch = exactIdentity?.admissionStatus === "promoted" && !exactIdentity.archivedAt
      ? exactIdentity
      : projects.find((p) => p.name === projectHint);
    if (exactMatch) return exactMatch.id;
    return null;
  } catch {
    return null;
  }
}

/**
 * SceneBuilderWorker：场景聚合器（LinkerSceneJudgeWorker 的 SceneBuilder 部分）
 *
 * 由公共入口 LinkerSceneJudgeWorker 组合使用（shouldTriggerSceneBuilder=true 时才会调用）。
 */
export class SceneBuilderWorker {
  private readonly factRepo: FactRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;

  constructor(deps: SceneBuilderWorkerDeps) {
    this.factRepo = deps.factRepo;
    this.sceneRepo = deps.sceneRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
  }

  /**
   * 查询时间窗口内的 facts（按 created_at 升序，便于模型理解时间线）
   * - 排除已删除
   */
  fetchFactsInTimeWindow(from: string, to: string, limit: number): Fact[] {
    try {
      const allFacts = this.factRepo.list({ limit: Math.max(limit * 2, 100) });
      return allFacts
        .filter((f) => f.createdAt >= from && f.createdAt <= to)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  /**
   * 查询 active projects（SceneBuilder 用，返回完整 Project）
   */
  fetchActiveProjects() {
    try {
      return this.memoryObjectRepo.listProjects({ status: "active", limit: 10 });
    } catch {
      return [];
    }
  }

  /**
   * 查询相关 tasks（status=open/in_progress/likely_done）
   * - 不查 done（已完成不需要在 scene 中聚合）
   */
  fetchRelatedTasks() {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({
        status: "open",
        limit: 20,
      });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 20,
      });
      const likelyDoneTasks = this.memoryObjectRepo.listTasks({
        status: "likely_done",
        limit: 20,
      });
      return [...openTasks, ...inProgressTasks, ...likelyDoneTasks];
    } catch {
      return [];
    }
  }

  /**
   * 写入 scenes 表
   * - 每个 scene 写入 scenes 表
   * - 入库前必须过 normalizeIsoToZ（处理 startAt/endAt）
   * - 若 projectHint 匹配已有 project，设置 projectId
   * - 单条写入失败不阻断其他
   */
  writeScenes(output: LinkerSceneJudgeOutput["scenes"]): Scene[] {
    const scenes: Scene[] = [];
    for (const sceneInput of output) {
      try {
        const projectId = resolveProjectIdHint(this.memoryObjectRepo, sceneInput.projectHint);

        // 入库前 normalize：把任何 ISO 字符串统一成 UTC Z 后缀
        // 修复：LLM 可能输出无时区 / +08:00 / Z 三种格式混用，导致渲染端错位
        const scene = this.sceneRepo.create({
          title: sceneInput.title,
          summary: sceneInput.summary,
          startAt: normalizeIsoToZ(sceneInput.startAt),
          endAt: normalizeIsoToZ(sceneInput.endAt),
          projectId,
          confidence: sceneInput.confidence,
          factIds: sceneInput.factIds,
          observationIds: [],
          entityNames: sceneInput.entityNames,
          taskIds: sceneInput.taskIds,
          decisionIds: sceneInput.decisionIds,
        });
        scenes.push(scene);
      } catch {
        // 单条写入失败不阻断其他
      }
    }
    return scenes;
  }
}
