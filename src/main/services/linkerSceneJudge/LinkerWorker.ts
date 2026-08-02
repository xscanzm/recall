// src/main/services/linkerSceneJudge/LinkerWorker.ts
// Linker 职责模块（从 LinkerSceneJudgeWorker.ts 拆分，代码原样迁移）：
// - 候选对象检索：fetchCandidateProjects/Tasks/People/Decisions/RecentScenes/UserFeedbackSummary
// - 关联输出处理：processLinks（更新 target 对象 source_fact_ids_json + 写 fact-object edge）
// - 合并建议输出处理：processMergeSuggestions（写入 proactive_items 表作为 merge_suggestion）
// - 已知别名 prompt 注入：buildKnownAliasesBlock
// - 摘要构造：toFactSummary / toSceneSummary（模块级纯函数，供公共入口使用）
//
// 行为与原 LinkerSceneJudgeWorker 中对应方法完全一致（含 try/catch 不阻断语义）。

import type { Fact, Scene, ProactiveItem, DebugEvent } from "../../models/types";
import type { LinkerSceneJudgeOutput } from "../../models/schemas";
import type { MemoryObjectRepository } from "../../db/repositories/MemoryObjectRepository";
import type { SceneRepository } from "../../db/repositories/SceneRepository";
import type { ProactiveItemRepository } from "../../db/repositories/ProactiveItemRepository";
import type { FactRepository } from "../../db/repositories/FactRepository";
import type { MemoryEdgeRepository } from "../../db/repositories/MemoryEdgeRepository";
import type { SettingsService } from "../SettingsService";
import type { MemoryObjectAdmissionService } from "../MemoryObjectAdmissionService";
import { logger } from "../Logger";
import type {
  CandidateProjectSummary,
  CandidateTaskSummary,
  CandidatePersonSummary,
  CandidateDecisionSummary,
  LinkerWorkerDeps,
} from "./types";

/**
 * LinkerWorker：记忆关联员（LinkerSceneJudgeWorker 的 Linker 部分）
 *
 * 不持有模型网关/任务队列，仅做候选检索与输出落库；公共入口 LinkerSceneJudgeWorker
 * 负责模型调用编排并组合本模块。
 */
export class LinkerWorker {
  private readonly factRepo: FactRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly edgeRepo: MemoryEdgeRepository | null;
  private readonly settingsService: SettingsService | null;
  private readonly admissionService: MemoryObjectAdmissionService;

  constructor(deps: LinkerWorkerDeps) {
    this.factRepo = deps.factRepo;
    this.sceneRepo = deps.sceneRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.edgeRepo = deps.edgeRepo;
    this.settingsService = deps.settingsService;
    this.admissionService = deps.admissionService;
  }

  // ----------------------------------------------------------------
  // Linker 复用方法：候选对象检索
  // ----------------------------------------------------------------

  /**
   * 候选 projects：status=active 的最近 10 个（按 last_active_at 降序）
   */
  fetchCandidateProjects(): CandidateProjectSummary[] {
    try {
      const projects = this.memoryObjectRepo.listProjects({
        status: "active",
        limit: 10,
        includeNonPromoted: true,
      });
      return projects
        .slice()
        .sort((a, b) => {
          const aTime = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
          const bTime = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
          return bTime - aTime;
        })
        .map((p) => ({
          id: p.id,
          name: p.name,
          summary: p.summary,
          status: p.status,
          lastActiveAt: p.lastActiveAt,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 候选 tasks：status=open/in_progress 的最近 20 个（按 updated_at 降序）
   */
  fetchCandidateTasks(): CandidateTaskSummary[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({
        status: "open",
        limit: 20,
      });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 20,
      });
      const allTasks = [...openTasks, ...inProgressTasks];
      return allTasks
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 20)
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          projectId: t.projectId,
          summary: t.summary,
        }));
    } catch {
      return [];
    }
  }

  /**
   * 候选 people：最近 10 个
   */
  fetchCandidatePeople(): CandidatePersonSummary[] {
    try {
      const people = this.memoryObjectRepo.listPeople({ limit: 10, includeNonPromoted: true });
      return people.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        organization: p.organization,
        summary: p.summary,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 候选 decisions：最近 5 个
   */
  fetchCandidateDecisions(): CandidateDecisionSummary[] {
    try {
      const decisions = this.memoryObjectRepo.listDecisions({ limit: 5 });
      return decisions.map((d) => ({
        id: d.id,
        title: d.title,
        decision: d.decision,
        projectId: d.projectId,
        decidedAt: d.decidedAt,
      }));
    } catch {
      return [];
    }
  }

  /**
   * 最近 scenes：5 个（按 start_at 降序）— Linker 上下文用
   */
  fetchRecentScenes(): Scene[] {
    try {
      return this.sceneRepo.listByStartAt({ limit: 5 });
    } catch {
      return [];
    }
  }

  /**
   * 查询 user feedback summary
   */
  fetchUserFeedbackSummary(): string {
    if (!this.settingsService) return "";
    try {
      const feedbackTypes = [
        "not_important",
        "content_wrong",
        "wrong_project",
        "task_done",
        "not_a_task",
        "do_not_record",
        "sensitive_delete",
      ];
      const summaries: string[] = [];
      for (const fbType of feedbackTypes) {
        const feedbacks = this.settingsService.listUserFeedbackByType(fbType);
        if (feedbacks.length > 0) {
          summaries.push(`${fbType}: ${feedbacks.length} 条`);
        }
      }
      return summaries.length > 0
        ? `用户反馈汇总：${summaries.join("；")}`
        : "";
    } catch {
      return "";
    }
  }

  // ----------------------------------------------------------------
  // Linker 复用方法：关联输出处理
  // ----------------------------------------------------------------

  /**
   * 处理 linkedFacts：关联 fact 到现有对象
   * - 更新 target 对象的 source_fact_ids_json（追加新 factId）
   * - 若是 belongs_to project：更新 fact.project_id
   */
  processLinks(
    links: LinkerSceneJudgeOutput["linkedFacts"]
  ): LinkerSceneJudgeOutput["linkedFacts"] {
    const processed: LinkerSceneJudgeOutput["linkedFacts"] = [];
    for (const link of links) {
      try {
        const updated = this.appendFactIdToTarget(
          link.targetType,
          link.targetId,
          link.sourceFactId
        );
        if (!updated) continue;

        const inferredProjectId = this.resolveProjectIdForLink(
          link.targetType,
          link.targetId
        );
        if (inferredProjectId) {
          try {
            this.factRepo.update(link.sourceFactId, {
              projectId: inferredProjectId,
            });
          } catch {
            // 单条 fact 更新失败不阻断
          }
        }

        this.persistFactLinkEdge(link);
        if (link.targetType === "project" || link.targetType === "person") {
          this.admissionService.reassessObject(link.targetType, link.targetId);
        }

        processed.push(link);
      } catch {
        // 单条 link 处理失败不阻断其他 link
      }
    }
    return processed;
  }

  /**
   * 把 factId 追加到 target 对象的 sourceFactIds
   * 返回是否成功
   */
  private appendFactIdToTarget(
    targetType: LinkerSceneJudgeOutput["linkedFacts"][number]["targetType"],
    targetId: string,
    factId: string
  ): boolean {
    try {
      switch (targetType) {
        case "project": {
          const obj = this.memoryObjectRepo.getProjectByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateProject(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
            lastActiveAt: new Date().toISOString(),
          });
          return true;
        }
        case "task": {
          const obj = this.memoryObjectRepo.getTaskByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateTask(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "person": {
          const obj = this.memoryObjectRepo.getPersonByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updatePerson(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "decision": {
          const obj = this.memoryObjectRepo.getDecisionByIdActive(targetId);
          if (!obj) return false;
          if (obj.sourceFactIds.includes(factId)) return true;
          this.memoryObjectRepo.updateDecision(targetId, {
            sourceFactIds: [...obj.sourceFactIds, factId],
          });
          return true;
        }
        case "scene": {
          const obj = this.sceneRepo.getByIdActive(targetId);
          if (!obj) return false;
          if (obj.factIds.includes(factId)) return true;
          this.sceneRepo.update(targetId, {
            factIds: [...obj.factIds, factId],
          });
          return true;
        }
        case "knowledge":
          // knowledge 类型在 MVP 不单独建表，仅作为 link 目标记录
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  private resolveProjectIdForLink(
    targetType: LinkerSceneJudgeOutput["linkedFacts"][number]["targetType"],
    targetId: string
  ): string | null {
    try {
      switch (targetType) {
        case "project":
          return targetId;
        case "task":
          return this.memoryObjectRepo.getTaskByIdActive(targetId)?.projectId ?? null;
        case "decision":
          return this.memoryObjectRepo.getDecisionByIdActive(targetId)?.projectId ?? null;
        case "scene":
          return this.sceneRepo.getByIdActive(targetId)?.projectId ?? null;
        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  private persistFactLinkEdge(
    link: LinkerSceneJudgeOutput["linkedFacts"][number]
  ): void {
    if (!this.edgeRepo) return;
    try {
      const existing = this.edgeRepo
        .listFrom("fact", link.sourceFactId, { status: "active", limit: 200 })
        .some(
          (edge) =>
            edge.toType === link.targetType &&
            edge.toId === link.targetId &&
            edge.relationType === link.relationship
        );
      if (existing) return;
      this.edgeRepo.create({
        fromType: "fact",
        fromId: link.sourceFactId,
        toType: link.targetType,
        toId: link.targetId,
        relationType: link.relationship,
        confidence: link.confidence,
        createdBy: "model",
        evidenceIds: [link.sourceFactId],
        status: "active",
        reason: link.reason,
      });
    } catch {
      // edge 写入失败不阻断
    }
  }

  /**
   * 处理 mergedObjects：写入 proactive_items 表作为 merge_suggestion
   * - requires_user_confirmation=true
   * - status="new"
   * - surface="in_app"（默认）
   * - type="merge_suggestion"（独立类型，便于筛选）
   * - payload_json 存 {objectType, fromId, toId, fromName, toName, reason, confidence}
   * - 去重：同 (objectType, fromId, toId) 已存在 status='new' 则跳过
   */
  processMergeSuggestions(
    mergeSuggestions: LinkerSceneJudgeOutput["mergedObjects"],
    debugEvents?: DebugEvent[]
  ): LinkerSceneJudgeOutput["mergedObjects"] {
    const processed: LinkerSceneJudgeOutput["mergedObjects"] = [];
    for (const suggestion of mergeSuggestions) {
      // MVP 阶段不支持 knowledge 对象合并（无对应存储表），过滤掉该类型建议
      if (suggestion.objectType === "knowledge") {
        if (debugEvents) {
          debugEvents.push({ layer: "L3", action: "skip", reason: "knowledge_merge_not_supported", targetType: "knowledge" });
        }
        logger.info({
          jobType: "linker_scene_judge",
          message: `[LinkerSceneJudgeWorker] 跳过 knowledge 对象合并建议（MVP 不支持）: ${suggestion.fromId} -> ${suggestion.toId}`,
        });
        continue;
      }
      try {
        if (
          this.proactiveItemRepo.hasExistingMergeSuggestion(
            suggestion.objectType,
            suggestion.fromId,
            suggestion.toId
          )
        ) {
          if (debugEvents) {
            debugEvents.push({ layer: "L3", action: "dedup", reason: "merge_suggestion_already_exists", targetType: suggestion.objectType });
          }
          logger.debug({
            jobType: "linker_scene_judge",
            message: `[LinkerSceneJudgeWorker] 合并建议已存在，跳过: ${suggestion.objectType} ${suggestion.fromId} -> ${suggestion.toId}`,
          });
          continue;
        }

        const { fromName, toName } = this.resolveMergeSuggestionNames(
          suggestion.objectType,
          suggestion.fromId,
          suggestion.toId
        );

        const objectTypeLabel = this.getObjectTypeLabel(suggestion.objectType);
        const title = `建议合并${objectTypeLabel}：${fromName} → ${toName}`;
        const body = `Linker 发现「${fromName}」与「${toName}」是同${
          objectTypeLabel
        }，建议合并到「${toName}」。原因：${suggestion.reason}`;

        const payloadJson = JSON.stringify({
          objectType: suggestion.objectType,
          fromId: suggestion.fromId,
          toId: suggestion.toId,
          fromName,
          toName,
          reason: suggestion.reason,
          confidence: suggestion.confidence,
        });

        const item: Omit<ProactiveItem, "id" | "createdAt" | "updatedAt"> = {
          type: "merge_suggestion",
          title,
          body,
          reason: suggestion.reason,
          priority: suggestion.confidence,
          surface: "in_app",
          requiresUserConfirmation: true,
          status: "new",
          sourceFactIds: [],
          sourceSceneIds: [],
          payloadJson,
        };
        this.proactiveItemRepo.create(item);
        processed.push(suggestion);
      } catch {
        // 单条失败不阻断
      }
    }
    return processed;
  }

  /**
   * 根据 objectType 查 from/to 真实名字（用于合并建议展示）
   * - 若对象已归档/删除，名字为 "未知"
   */
  private resolveMergeSuggestionNames(
    objectType: string,
    fromId: string,
    toId: string
  ): { fromName: string; toName: string } {
    const unknown = { fromName: "未知", toName: "未知" };
    try {
      switch (objectType) {
        case "project": {
          const from = this.memoryObjectRepo.getProjectByIdActive(fromId);
          const to = this.memoryObjectRepo.getProjectByIdActive(toId);
          return {
            fromName: from?.name ?? "未知项目",
            toName: to?.name ?? "未知项目",
          };
        }
        case "person": {
          const from = this.memoryObjectRepo.getPersonByIdActive(fromId);
          const to = this.memoryObjectRepo.getPersonByIdActive(toId);
          return {
            fromName: from?.name ?? "未知人物",
            toName: to?.name ?? "未知人物",
          };
        }
        case "task": {
          const from = this.memoryObjectRepo.getTaskByIdActive(fromId);
          const to = this.memoryObjectRepo.getTaskByIdActive(toId);
          return {
            fromName: from?.title ?? "未知任务",
            toName: to?.title ?? "未知任务",
          };
        }
        case "decision": {
          const from = this.memoryObjectRepo.getDecisionByIdActive(fromId);
          const to = this.memoryObjectRepo.getDecisionByIdActive(toId);
          return {
            fromName: from?.title ?? "未知决策",
            toName: to?.title ?? "未知决策",
          };
        }
        default:
          return unknown;
      }
    } catch {
      return unknown;
    }
  }

  /**
   * objectType → 中文标签
   */
  private getObjectTypeLabel(objectType: string): string {
    switch (objectType) {
      case "project":
        return "项目";
      case "person":
        return "人物";
      case "task":
        return "任务";
      case "decision":
        return "决策";
      default:
        return objectType;
    }
  }

  // ----------------------------------------------------------------
  // Linker 复用方法：已知别名 prompt 注入
  // ----------------------------------------------------------------

  /**
   * 构造"已知别名"块（Markdown 格式），用于注入 prompt
   * - 格式：人物（标准名 -> 别名）/ 项目（标准名 -> 别名）
   * - 若没有别名则写 "（无）"
   */
  buildKnownAliasesBlock(): string {
    try {
      const projectAliases = this.memoryObjectRepo.listProjectAliases();
      const peopleAliases = this.memoryObjectRepo.listPersonAliases();

      const lines: string[] = [];
      lines.push("人物（标准名 -> 别名）：");
      const peopleWithAliases = peopleAliases.filter((p) => p.aliases.length > 0);
      if (peopleWithAliases.length === 0) {
        lines.push("  （无）");
      } else {
        for (const p of peopleWithAliases) {
          lines.push(`  - ${p.name} (alias: ${JSON.stringify(p.aliases)})`);
        }
      }
      lines.push("");
      lines.push("项目（标准名 -> 别名）：");
      const projectsWithAliases = projectAliases.filter((p) => p.aliases.length > 0);
      if (projectsWithAliases.length === 0) {
        lines.push("  （无）");
      } else {
        for (const p of projectsWithAliases) {
          lines.push(`  - ${p.name} (alias: ${JSON.stringify(p.aliases)})`);
        }
      }
      return lines.join("\n");
    } catch (e) {
      // 失败时返回空字符串（不阻塞 Worker）
      console.warn("[LinkerSceneJudgeWorker] buildKnownAliasesBlock 失败:", e);
      return "（无法加载已知别名）";
    }
  }
}

// ----------------------------------------------------------------
// 摘要构造（模块级纯函数，供公共入口 LinkerSceneJudgeWorker 使用）
// ----------------------------------------------------------------

/**
 * Fact 摘要（用于 linkerInput.newFacts / sceneFacts）
 * - 保留关键字段，透传 peopleHints 以便 Linker 识别新人名
 */
export function toFactSummary(fact: Fact): unknown {
  return {
    id: fact.id,
    type: fact.type,
    content: fact.content,
    status: fact.status,
    projectId: fact.projectId,
    projectHint: fact.projectHint,
    peopleHints: fact.peopleHints ?? null,
    importance: fact.importance,
    confidence: fact.confidence,
    inferred: fact.inferred,
    tags: fact.tags,
    createdAt: fact.createdAt,
  };
}

/**
 * Scene 摘要（用于 linkerInput.recentScenes）
 */
export function toSceneSummary(scene: Scene): unknown {
  return {
    id: scene.id,
    title: scene.title,
    summary: scene.summary,
    startAt: scene.startAt,
    endAt: scene.endAt,
    projectId: scene.projectId,
    factIds: scene.factIds,
    entityNames: scene.entityNames,
  };
}
