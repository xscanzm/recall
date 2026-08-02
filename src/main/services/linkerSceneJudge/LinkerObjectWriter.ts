// src/main/services/linkerSceneJudge/LinkerObjectWriter.ts
// Linker 新对象创建与合并建议落库模块（从 LinkerSceneJudgeWorker.ts 拆分，代码原样迁移）：
// - processNewObjects：创建新 L3 MemoryObject（含硬性去重 fallback）
// - createNewMemoryObject / dedupCheck / backfillPersonRoleOrganization
// - checkAndWriteAutoMergeSuggestion：自动相似度检测 → merge_suggestion
// - linkFactIdsToExisting / finalizeObjectFactLinks / 各种 projectId 回填与 fact-object edge 写入
// - mergeUnique：模块级辅助函数
//
// 行为与原 LinkerSceneJudgeWorker 中对应方法完全一致（含 try/catch 不阻断语义）。
// 注：本模块是 Linker 职责的"对象写入"部分；候选检索 / 关联处理 / 别名注入 /
// 合并建议展示部分位于 LinkerWorker.ts（因单文件超过 700 行限制而拆为两个模块）。

import type { DebugEvent, MemoryRelationType, ProactiveItem } from "../../models/types";
import type { LinkerSceneJudgeOutput } from "../../models/schemas";
import type { MemoryObjectRepository } from "../../db/repositories/MemoryObjectRepository";
import type { ProactiveItemRepository } from "../../db/repositories/ProactiveItemRepository";
import type { FactRepository } from "../../db/repositories/FactRepository";
import type { MemoryEdgeRepository } from "../../db/repositories/MemoryEdgeRepository";
import type { MemoryObjectAdmissionService } from "../MemoryObjectAdmissionService";
import { logger } from "../Logger";
import { normalizeIdentity } from "../../../shared/identity";
import { resolveProjectIdHint } from "./SceneBuilderWorker";
import type { LinkableMemoryObjectType, LinkerObjectWriterDeps } from "./types";

/**
 * LinkerObjectWriter：Linker 新对象创建 / 去重 / 事实链接落库（LinkerSceneJudgeWorker 的一部分）
 *
 * 由公共入口 LinkerSceneJudgeWorker 组合使用。
 */
export class LinkerObjectWriter {
  private readonly factRepo: FactRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly proactiveItemRepo: ProactiveItemRepository;
  private readonly edgeRepo: MemoryEdgeRepository | null;
  private readonly admissionService: MemoryObjectAdmissionService;

  constructor(deps: LinkerObjectWriterDeps) {
    this.factRepo = deps.factRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.proactiveItemRepo = deps.proactiveItemRepo;
    this.edgeRepo = deps.edgeRepo;
    this.admissionService = deps.admissionService;
  }

  /**
   * 处理 newObjects：创建新 L3 MemoryObject
   */
  processNewObjects(
    newObjects: LinkerSceneJudgeOutput["newObjects"],
    _captureId: string | undefined,
    debugEvents?: DebugEvent[]
  ): LinkerSceneJudgeOutput["newObjects"] {
    const processed: LinkerSceneJudgeOutput["newObjects"] = [];
    for (const newObj of newObjects) {
      // MVP 阶段不支持 knowledge 对象创建（无对应存储表），过滤掉该类型建议
      if (newObj.objectType === "knowledge") {
        if (debugEvents) {
          debugEvents.push({ layer: "L3", action: "skip", reason: "knowledge_object_not_supported", targetType: "knowledge" });
        }
        logger.info({
          jobType: "linker_scene_judge",
          message: `[LinkerSceneJudgeWorker] 跳过 knowledge 对象创建建议（MVP 不支持）: ${newObj.title}`,
        });
        continue;
      }
      try {
        const created = this.createNewMemoryObject(newObj, debugEvents);
        if (created) {
          processed.push(newObj);
        }
      } catch {
        // 单条创建失败不阻断其他
      }
    }
    return processed;
  }

  /**
   * 创建新的 L3 MemoryObject
   *
   * 硬性去重 fallback（Checkpoint 7.4）：
   * - 创建前先调用对应去重查询；命中则改为把 sourceFactIds 追加到现有对象
   * - 去重仅是 fallback，不替代 prompt 的 newObjects 决策
   * - 去重查询失败时静默回退到创建新对象（不阻断流程）
   */
  private createNewMemoryObject(
    newObj: LinkerSceneJudgeOutput["newObjects"][number],
    debugEvents?: DebugEvent[]
  ): boolean {
    const sourceFactIds = newObj.sourceFactIds;
    const now = new Date().toISOString();

    switch (newObj.objectType) {
      case "project": {
        const admitted = this.admissionService.admitOrAccumulate({
          objectType: "project",
          title: newObj.title,
          summary: newObj.summary,
          sourceFactIds,
          confidence: newObj.confidence,
        });
        if (admitted.status === "rejected") return false;
        this.finalizeObjectFactLinks("project", admitted.object.id, sourceFactIds, newObj.confidence, "项目候选的事实来源关系");
        if (admitted.created) {
          this.checkAndWriteAutoMergeSuggestion("project", admitted.object.id, admitted.object.name, sourceFactIds);
        }
        return true;
      }
      case "task": {
        const existingId = this.dedupCheck("task", newObj.title);
        if (existingId) {
          if (debugEvents) {
            debugEvents.push({ layer: "L3", action: "dedup", reason: "dedup_hit: task", targetType: "task", itemId: existingId });
          }
          logger.info({
            jobType: "linker_scene_judge",
            message: `dedup hit: task ${existingId}`,
          });
          this.linkFactIdsToExisting("task", existingId, sourceFactIds);
          this.finalizeObjectFactLinks("task", existingId, sourceFactIds, newObj.confidence, "新对象去重命中后补齐事实来源关系");
          return true;
        }
        const inferredProjectId = this.inferProjectIdFromFacts(sourceFactIds);
        const created = this.memoryObjectRepo.createTask({
          title: newObj.title,
          status: "open",
          projectId: inferredProjectId,
          summary: newObj.summary,
          dueHint: null,
          priority: newObj.confidence,
          confidence: newObj.confidence,
          sourceFactIds,
        });
        this.finalizeObjectFactLinks("task", created.id, sourceFactIds, newObj.confidence, "新建任务对象的事实来源关系");
        return true;
      }
      case "person": {
        const admitted = this.admissionService.admitOrAccumulate({
          objectType: "person",
          title: newObj.title,
          summary: newObj.summary,
          sourceFactIds,
          confidence: newObj.confidence,
          role: newObj.role ?? null,
          organization: newObj.organization ?? null,
        });
        if (admitted.status === "rejected") return false;
        this.finalizeObjectFactLinks("person", admitted.object.id, sourceFactIds, newObj.confidence, "人物候选的事实来源关系");
        this.backfillPersonRoleOrganization(admitted.object.id, newObj);
        if (admitted.created) {
          this.checkAndWriteAutoMergeSuggestion("person", admitted.object.id, admitted.object.name, sourceFactIds);
        }
        return true;
      }
      case "decision": {
        const existingId = this.dedupCheck("decision", newObj.title);
        if (existingId) {
          if (debugEvents) {
            debugEvents.push({ layer: "L3", action: "dedup", reason: "dedup_hit: decision", targetType: "decision", itemId: existingId });
          }
          logger.info({
            jobType: "linker_scene_judge",
            message: `dedup hit: decision ${existingId}`,
          });
          this.linkFactIdsToExisting("decision", existingId, sourceFactIds);
          this.finalizeObjectFactLinks("decision", existingId, sourceFactIds, newObj.confidence, "新对象去重命中后补齐事实来源关系");
          return true;
        }
        const inferredProjectId = this.inferProjectIdFromFacts(sourceFactIds);
        const created = this.memoryObjectRepo.createDecision({
          title: newObj.title,
          decision: newObj.summary,
          projectId: inferredProjectId,
          rationale: null,
          confidence: newObj.confidence,
          sourceFactIds,
          decidedAt: now,
        });
        this.finalizeObjectFactLinks("decision", created.id, sourceFactIds, newObj.confidence, "新建决策对象的事实来源关系");
        return true;
      }
      case "knowledge":
        // knowledge 类型在 MVP 不单独建表
        return true;
      default:
        return false;
    }
  }

  /**
   * 硬性去重查询（fallback）
   *
   * 根据 objectType + title 查询现有对象，命中返回 id，否则返回 null。
   * 查询失败时返回 null（不阻断后续创建流程）。
   */
  private dedupCheck(
    objectType: "project" | "task" | "person" | "decision",
    title: string
  ): string | null {
    try {
      switch (objectType) {
        case "project": {
          const existing = this.memoryObjectRepo.findProjectByExactIdentity(title);
          return existing?.id ?? null;
        }
        case "task": {
          const existing = this.memoryObjectRepo.findOpenTaskByTitleAndProject(
            title,
            null
          );
          return existing?.id ?? null;
        }
        case "person": {
          const existing = this.memoryObjectRepo.findPersonByExactIdentity(title);
          return existing?.id ?? null;
        }
        case "decision": {
          const existing = this.memoryObjectRepo.findRecentDecisionByTitle(title, {
            withinDays: 7,
          });
          return existing?.id ?? null;
        }
      }
    } catch {
      // 去重查询失败不阻断创建流程
    }
    return null;
  }

  /**
   * dedup 命中时，若现有人物的 role/organization 为空且 LLM 本次输出了值，则补齐。
   * 约束：不覆盖用户/LLM 已填写的非空值（"只填空、不覆盖"）。
   */
  private backfillPersonRoleOrganization(
    personId: string,
    newObj: { role?: string | null; organization?: string | null }
  ): void {
    try {
      const existing = this.memoryObjectRepo.getPersonByIdActive(personId);
      if (!existing) return;
      const patch: { role?: string | null; organization?: string | null } = {};
      if (!existing.role && newObj.role) patch.role = newObj.role;
      if (!existing.organization && newObj.organization) patch.organization = newObj.organization;
      if (Object.keys(patch).length > 0) {
        this.memoryObjectRepo.updatePerson(personId, patch);
      }
    } catch (err) {
      logger.debug({
        jobType: "linker_scene_judge",
        message: `[LinkerSceneJudgeWorker] backfillPersonRoleOrganization 失败（不阻断）: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 自动相似度检测：创建新对象后，检测是否与现有对象相似。
   * 命中则写入 proactive_items 作为 merge_suggestion，等待用户确认。
   *
   * 相似度算法：名字 bigram Jaccard (权重 0.6) + sourceFactIds 重叠度 (权重 0.4)
   * 阈值 >= 0.5 才写建议。
   */
  private checkAndWriteAutoMergeSuggestion(
    objectType: "project" | "person",
    newId: string,
    newName: string,
    newFactIds: string[]
  ): void {
    try {
      // 获取候选对象（排除自身）
      let candidates: Array<{ id: string; name: string; sourceFactIds: string[] }>;
      if (objectType === "project") {
        const projects = this.memoryObjectRepo.listProjects({ includeArchived: false, limit: 50 });
        candidates = projects
          .filter((p) => p.id !== newId)
          .map((p) => ({ id: p.id, name: p.name, sourceFactIds: p.sourceFactIds }));
      } else {
        const people = this.memoryObjectRepo.listPeople({ limit: 50 });
        candidates = people
          .filter((p) => p.id !== newId)
          .map((p) => ({ id: p.id, name: p.name, sourceFactIds: p.sourceFactIds }));
      }

      let best: { id: string; name: string; similarity: number } | null = null;
      const newNameBigrams = this.computeBigrams(normalizeIdentity(newName));

      for (const candidate of candidates) {
        const candBigrams = this.computeBigrams(normalizeIdentity(candidate.name));
        const nameSim = this.jaccardSimilarity(newNameBigrams, candBigrams);
        const factSim = this.jaccardSimilarity(
          new Set(newFactIds),
          new Set(candidate.sourceFactIds)
        );
        const combined = 0.6 * nameSim + 0.4 * factSim;
        if (combined >= 0.5 && (!best || combined > best.similarity)) {
          best = { id: candidate.id, name: candidate.name, similarity: combined };
        }
      }

      if (!best) return;

      // 去重：已有合并建议则跳过
      const fromId = newId;
      const toId = best.id;
      if (this.proactiveItemRepo.hasExistingMergeSuggestion(objectType, fromId, toId)) return;
      if (this.proactiveItemRepo.hasExistingMergeSuggestion(objectType, toId, fromId)) return;

      const objectTypeLabel = objectType === "project" ? "项目" : "人物";
      const title = `建议合并${objectTypeLabel}：${newName} → ${best.name}`;
      const body = `检测到「${newName}」与「${best.name}」可能是同一${objectTypeLabel}（相似度 ${best.similarity.toFixed(2)}），建议合并。`;

      const payloadJson = JSON.stringify({
        objectType,
        fromId,
        toId,
        fromName: newName,
        toName: best.name,
        reason: `自动相似度检测（${best.similarity.toFixed(2)}）`,
        confidence: best.similarity,
      });

      const item: Omit<ProactiveItem, "id" | "createdAt" | "updatedAt"> = {
        type: "merge_suggestion",
        title,
        body,
        reason: `自动相似度检测（${best.similarity.toFixed(2)}）`,
        priority: best.similarity,
        surface: "in_app",
        requiresUserConfirmation: true,
        status: "new",
        sourceFactIds: [],
        sourceSceneIds: [],
        payloadJson,
      };
      this.proactiveItemRepo.create(item);
      logger.info({
        jobType: "linker_scene_judge",
        message: `[LinkerSceneJudgeWorker] 自动合并建议已写入: ${objectType} ${newName} -> ${best.name} (similarity=${best.similarity.toFixed(2)})`,
      });
    } catch (err) {
      logger.debug({
        jobType: "linker_scene_judge",
        message: `[LinkerSceneJudgeWorker] 自动合并建议检测失败（不阻断）: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** 计算字符串的字符 bigram 集合 */
  private computeBigrams(s: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      bigrams.add(s.slice(i, i + 2));
    }
    return bigrams;
  }

  /** 计算两个集合的 Jaccard 相似度 */
  private jaccardSimilarity<T>(a: Set<T>, b: Set<T>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const item of a) {
      if (b.has(item)) intersection++;
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * 把多个 sourceFactIds 追加到现有对象的 sourceFactIds（去重合并）
   *
   * 用于硬性去重命中时：不创建新对象，但仍建立 link。
   */
  private linkFactIdsToExisting(
    objectType: LinkableMemoryObjectType,
    existingId: string,
    factIds: string[]
  ): boolean {
    if (factIds.length === 0) return true;
    try {
      switch (objectType) {
        case "project": {
          const obj = this.memoryObjectRepo.getProjectByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateProject(existingId, {
            sourceFactIds: merged,
            lastActiveAt: new Date().toISOString(),
          });
          return true;
        }
        case "task": {
          const obj = this.memoryObjectRepo.getTaskByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateTask(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
        case "person": {
          const obj = this.memoryObjectRepo.getPersonByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updatePerson(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
        case "decision": {
          const obj = this.memoryObjectRepo.getDecisionByIdActive(existingId);
          if (!obj) return false;
          const merged = mergeUnique(obj.sourceFactIds, factIds);
          this.memoryObjectRepo.updateDecision(existingId, {
            sourceFactIds: merged,
          });
          return true;
        }
      }
    } catch {
      // 单条 link 失败不阻断
    }
    return false;
  }

  private finalizeObjectFactLinks(
    objectType: LinkableMemoryObjectType,
    objectId: string,
    factIds: string[],
    confidence: number,
    reason: string
  ): void {
    const projectId = this.resolveProjectIdForObject(objectType, objectId) ?? this.inferProjectIdFromFacts(factIds);
    this.backfillObjectProjectId(objectType, objectId, projectId);

    for (const factId of factIds) {
      this.backfillFactProjectId(factId, projectId, objectType === "project");
      this.persistFactObjectEdge({
        factId,
        objectType,
        objectId,
        relationType: this.relationForNewObject(objectType),
        confidence,
        reason,
      });
    }
  }

  private resolveProjectIdForObject(
    objectType: LinkableMemoryObjectType,
    objectId: string
  ): string | null {
    try {
      switch (objectType) {
        case "project":
          return objectId;
        case "task":
          return this.memoryObjectRepo.getTaskByIdActive(objectId)?.projectId ?? null;
        case "decision":
          return this.memoryObjectRepo.getDecisionByIdActive(objectId)?.projectId ?? null;
        case "person": {
          const person = this.memoryObjectRepo.getPersonByIdActive(objectId);
          return person?.relatedProjectIds[0] ?? null;
        }
      }
    } catch {
      return null;
    }
  }

  private inferProjectIdFromFacts(factIds: string[]): string | null {
    for (const factId of factIds) {
      try {
        const fact = this.factRepo.getByIdActive(factId);
        if (!fact) continue;
        if (fact.projectId) return fact.projectId;
        const hintedProjectId = resolveProjectIdHint(this.memoryObjectRepo, fact.projectHint ?? undefined);
        if (hintedProjectId) return hintedProjectId;
      } catch {
        // 单条 fact 查询失败不阻断其他事实
      }
    }
    return null;
  }

  private backfillObjectProjectId(
    objectType: LinkableMemoryObjectType,
    objectId: string,
    projectId: string | null
  ): void {
    if (!projectId) return;
    try {
      switch (objectType) {
        case "task": {
          const task = this.memoryObjectRepo.getTaskByIdActive(objectId);
          if (task && !task.projectId) {
            this.memoryObjectRepo.updateTask(objectId, { projectId });
          }
          return;
        }
        case "decision": {
          const decision = this.memoryObjectRepo.getDecisionByIdActive(objectId);
          if (decision && !decision.projectId) {
            this.memoryObjectRepo.updateDecision(objectId, { projectId });
          }
          return;
        }
        case "person": {
          const person = this.memoryObjectRepo.getPersonByIdActive(objectId);
          if (person && !person.relatedProjectIds.includes(projectId)) {
            this.memoryObjectRepo.updatePerson(objectId, {
              relatedProjectIds: [...person.relatedProjectIds, projectId],
            });
          }
          return;
        }
        case "project":
          return;
      }
    } catch {
      // 对象 projectId 回填失败不阻断主流程
    }
  }

  private backfillFactProjectId(
    factId: string,
    projectId: string | null,
    overwrite: boolean
  ): void {
    if (!projectId) return;
    try {
      const fact = this.factRepo.getByIdActive(factId);
      if (!fact) return;
      if (!overwrite && fact.projectId) return;
      if (fact.projectId === projectId) return;
      this.factRepo.update(factId, { projectId });
    } catch {
      // 单条 fact projectId 回填失败不阻断
    }
  }

  private relationForNewObject(objectType: LinkableMemoryObjectType): MemoryRelationType {
    switch (objectType) {
      case "project":
        return "belongs_to";
      case "person":
        return "mentions";
      case "task":
      case "decision":
        return "supports";
    }
  }

  private persistFactObjectEdge(input: {
    factId: string;
    objectType: LinkableMemoryObjectType;
    objectId: string;
    relationType: MemoryRelationType;
    confidence: number;
    reason: string;
  }): void {
    if (!this.edgeRepo) return;
    try {
      const existing = this.edgeRepo
        .listFrom("fact", input.factId, { status: "active", limit: 200 })
        .some(
          (edge) =>
            edge.toType === input.objectType &&
            edge.toId === input.objectId &&
            edge.relationType === input.relationType
        );
      if (existing) return;
      this.edgeRepo.create({
        fromType: "fact",
        fromId: input.factId,
        toType: input.objectType,
        toId: input.objectId,
        relationType: input.relationType,
        confidence: input.confidence,
        createdBy: "system",
        evidenceIds: [input.factId],
        status: "active",
        reason: input.reason,
      });
    } catch {
      // edge 写入失败不阻断
    }
  }
}

// ---------------------------------------------------------------------------
// 模块级辅助函数
// ---------------------------------------------------------------------------

/**
 * 合并两个 id 数组并去重（保持顺序：existing 在前，incoming 中新增的追加在后）
 * 用于硬性去重命中时把新 sourceFactIds 追加到现有对象。
 */
function mergeUnique(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const result = existing.slice();
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
