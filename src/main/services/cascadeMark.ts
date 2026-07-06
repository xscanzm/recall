// src/main/services/cascadeMark.ts
// 级联标记 / 用户纠错 / 对象合并 辅助函数
//
// 从 src/main/ipc/handlers.ts 抽离（M3-M3），减少 handlers.ts 体积。
// 这些函数是纯逻辑函数，接收 deps（repositories + db），不持有状态。
//
// 包含 5 个导出函数：
// - cascadeMarkAfterFactSceneDelete: facts/scenes 软删除后触发 L3 orphan + reports stale
// - applyCorrection: 用户纠错类型 -> 对象更新动作
// - softDeleteByType: 按类型 soft delete 对象
// - hardDeleteByType: 按类型 hard delete 对象（仅 sensitive_delete）
// - mergeObjects: 合并两个同类型对象（sourceFactIds 合并 + soft delete from）
//
// 重要约束：
// - soft delete 优先，不物理删除（除 sensitive_delete）
// - 不覆盖 source ids
// - 合并对象时保留 source 链路

import type { DB } from "../db/Database";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { ProactiveItemRepository } from "../db/repositories/ProactiveItemRepository";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { Fact, Scene } from "../models/types";

/**
 * 级联标记 / 纠错 / 合并 所需的依赖
 * 结构兼容 IpcDeps（handlers.ts 的 IpcDeps 拥有全部这些字段），
 * 因此调用方可直接传入 IpcDeps 实例。
 */
export interface CascadeMarkDeps {
  factRepo?: FactRepository;
  sceneRepo?: SceneRepository;
  memoryObjectRepo?: MemoryObjectRepository;
  proactiveItemRepo?: ProactiveItemRepository;
  reportRepo?: ReportRepository;
  db?: DB;
}

/**
 * 标准错误返回（与 handlers.ts 中的 fail 行为一致）
 * 抛出带 code 属性的 Error，由 IPC handler 捕获并返回给 renderer。
 */
function fail(code: string, message: string): never {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  throw err;
}

/**
 * 用户纠错类型 -> 对象更新动作映射
 * 来自 spec.md "用户纠错"：
 * - content_wrong -> 更新 content（基于 patch.content）
 * - not_important -> 降低 importance
 * - wrong_project -> 更新 projectId（基于 patch.projectId）
 * - task_done -> 更新 status=done + completedAt
 * - not_a_task -> soft delete 对象
 * - do_not_record -> soft delete 对象 + 后续不再采集类似内容
 * - sensitive_delete -> hard delete（敏感内容才硬删除）
 *
 * 重要约束：不覆盖 source ids
 */
export function applyCorrection(
  deps: CascadeMarkDeps,
  targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder",
  targetId: string,
  feedbackType:
    | "content_wrong"
    | "not_important"
    | "wrong_project"
    | "task_done"
    | "not_a_task"
    | "do_not_record"
    | "sensitive_delete",
  objectPatch?: Record<string, unknown>
): void {
  // 根据 targetType 和 feedbackType 执行对应动作
  // 重要：不覆盖 source ids（由 Repository update 方法控制只更新传入字段）

  switch (feedbackType) {
    case "content_wrong": {
      // 内容错了 -> 更新 content（fact）/ title+summary（task/project）/ title+decision（decision）
      if (targetType === "fact" && deps.factRepo) {
        if (typeof objectPatch?.content === "string") {
          deps.factRepo.update(targetId, { content: objectPatch.content });
        }
      } else if (targetType === "task" && deps.memoryObjectRepo) {
        const patch: Record<string, unknown> = {};
        if (typeof objectPatch?.title === "string") patch.title = objectPatch.title;
        if (typeof objectPatch?.summary === "string") patch.summary = objectPatch.summary;
        if (Object.keys(patch).length > 0) {
          deps.memoryObjectRepo.updateTask(targetId, patch);
        }
      } else if (targetType === "project" && deps.memoryObjectRepo) {
        const patch: Record<string, unknown> = {};
        if (typeof objectPatch?.name === "string") patch.name = objectPatch.name;
        if (typeof objectPatch?.summary === "string") patch.summary = objectPatch.summary;
        if (Object.keys(patch).length > 0) {
          deps.memoryObjectRepo.updateProject(targetId, patch);
        }
      } else if (targetType === "decision" && deps.memoryObjectRepo) {
        const patch: Record<string, unknown> = {};
        if (typeof objectPatch?.title === "string") patch.title = objectPatch.title;
        if (typeof objectPatch?.decision === "string") patch.decision = objectPatch.decision;
        if (Object.keys(patch).length > 0) {
          deps.memoryObjectRepo.updateDecision(targetId, patch);
        }
      } else if (targetType === "person" && deps.memoryObjectRepo) {
        const patch: Record<string, unknown> = {};
        if (typeof objectPatch?.name === "string") patch.name = objectPatch.name;
        if (typeof objectPatch?.summary === "string") patch.summary = objectPatch.summary;
        if (Object.keys(patch).length > 0) {
          deps.memoryObjectRepo.updatePerson(targetId, patch);
        }
      }
      break;
    }

    case "not_important": {
      // 不重要 -> 降低 importance（仅 fact 支持）
      if (targetType === "fact" && deps.factRepo) {
        const current = deps.factRepo.getByIdActive(targetId);
        if (current) {
          // 降低一级（最低 0.1）
          const newImportance = Math.max(0.1, current.importance - 0.2);
          deps.factRepo.update(targetId, { importance: newImportance });
        }
      } else if (targetType === "task" && deps.memoryObjectRepo) {
        // 任务降低 priority（最低 0.1）
        const current = deps.memoryObjectRepo.getTaskByIdActive(targetId);
        if (current) {
          const newPriority = Math.max(0.1, current.priority - 0.2);
          deps.memoryObjectRepo.updateTask(targetId, { priority: newPriority });
        }
      }
      break;
    }

    case "wrong_project": {
      // 项目归属错了 -> 更新 projectId
      if (targetType === "fact" && deps.factRepo) {
        if (typeof objectPatch?.projectId === "string") {
          deps.factRepo.update(targetId, { projectId: objectPatch.projectId });
        }
      } else if (targetType === "task" && deps.memoryObjectRepo) {
        if (typeof objectPatch?.projectId === "string") {
          deps.memoryObjectRepo.updateTask(targetId, { projectId: objectPatch.projectId });
        }
      } else if (targetType === "decision" && deps.memoryObjectRepo) {
        if (typeof objectPatch?.projectId === "string") {
          deps.memoryObjectRepo.updateDecision(targetId, { projectId: objectPatch.projectId });
        }
      }
      break;
    }

    case "task_done": {
      // 这个任务已完成 -> 更新 status=done + completedAt
      if (targetType === "task" && deps.memoryObjectRepo) {
        deps.memoryObjectRepo.updateTask(targetId, {
          status: "done",
          completedAt: new Date().toISOString(),
        });
      } else if (targetType === "reminder" && deps.proactiveItemRepo) {
        deps.proactiveItemRepo.updateStatus(targetId, "done");
      }
      break;
    }

    case "not_a_task":
    case "do_not_record": {
      // 这不是任务 / 不要记这类内容 -> soft delete
      // 后续 Judge 和 Linker 调用时通过 user_feedback 摘要学习
      softDeleteByType(deps, targetType, targetId);
      break;
    }

    case "sensitive_delete": {
      // 这是敏感内容删除 -> hard delete（敏感内容才硬删除）
      hardDeleteByType(deps, targetType, targetId);
      break;
    }

    default: {
      // 未知 feedbackType 不执行对象更新，仅写入 user_feedback
    }
  }
}

/**
 * soft delete 对象（按类型分发）
 * 来自 spec.md "删除和纠错"：soft delete 优先
 */
export function softDeleteByType(
  deps: CascadeMarkDeps,
  targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder",
  targetId: string
): void {
  switch (targetType) {
    case "fact":
      deps.factRepo?.softDelete(targetId);
      break;
    case "scene":
      deps.sceneRepo?.softDelete(targetId);
      break;
    case "task":
      deps.memoryObjectRepo?.softDeleteTask(targetId);
      break;
    case "person":
      deps.memoryObjectRepo?.softDeletePerson(targetId);
      break;
    case "decision":
      deps.memoryObjectRepo?.softDeleteDecision(targetId);
      break;
    case "project":
      // 项目使用 archive 而非删除（保留 source 链路）
      deps.memoryObjectRepo?.archiveProject(targetId);
      break;
    case "reminder":
      deps.proactiveItemRepo?.updateStatus(targetId, "ignored");
      break;
  }
}

/**
 * hard delete 对象（仅 sensitive_delete 时使用）
 * 来自 spec.md "删除和纠错"：sensitive_delete 才硬删除
 */
export function hardDeleteByType(
  deps: CascadeMarkDeps,
  targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder",
  targetId: string
): void {
  switch (targetType) {
    case "fact":
      deps.factRepo?.deleteById(targetId);
      break;
    case "scene":
      deps.sceneRepo?.deleteById(targetId);
      break;
    case "task":
      deps.memoryObjectRepo?.deleteTask(targetId);
      break;
    case "person":
      deps.memoryObjectRepo?.deletePerson(targetId);
      break;
    case "decision":
      deps.memoryObjectRepo?.deleteDecision(targetId);
      break;
    case "project":
      deps.memoryObjectRepo?.deleteProject(targetId);
      break;
    case "reminder":
      // reminder 没有 hard delete，soft delete 等价
      deps.proactiveItemRepo?.updateStatus(targetId, "ignored");
      break;
  }
}

/**
 * 合并对象
 * 来自 spec.md "合并对象基础能力"：
 * - 把 fromId 对象的 sourceFactIds 合并到 toId 对象
 * - soft delete fromId 对象
 *
 * 合并策略：
 * 1. 读取 fromId 和 toId 对象
 * 2. 把 fromId 的 sourceFactIds 中 toId 没有的部分追加到 toId
 * 3. soft delete fromId 对象
 * 4. 返回合并后的 toId 对象
 */
export function mergeObjects(
  deps: CascadeMarkDeps,
  objectType: "project" | "task" | "person" | "decision",
  fromId: string,
  toId: string
): { ok: true; fromId: string; toId: string; objectType: string } {
  if (!deps.memoryObjectRepo) {
    fail("not_ready", "MemoryObjectRepository 未初始化");
  }

  // 1. 读取两个对象
  let fromSourceFactIds: string[] = [];
  let toObject: { id: string; sourceFactIds: string[] } | null = null;

  switch (objectType) {
    case "project": {
      const from = deps.memoryObjectRepo.getProjectByIdActive(fromId);
      const to = deps.memoryObjectRepo.getProjectByIdActive(toId);
      if (!from || !to) {
        fail("not_found", `项目合并失败：from ${fromId} 或 to ${toId} 未找到`);
      }
      fromSourceFactIds = from!.sourceFactIds;
      toObject = to;
      // 合并 sourceFactIds（去重）
      const mergedFactIds = Array.from(new Set([...to!.sourceFactIds, ...fromSourceFactIds]));
      // 同时合并 sourceSceneIds
      const mergedSceneIds = Array.from(
        new Set([...to!.sourceSceneIds, ...from!.sourceSceneIds])
      );
      deps.memoryObjectRepo.updateProject(toId, {
        sourceFactIds: mergedFactIds,
        sourceSceneIds: mergedSceneIds,
      });
      // soft delete from（archive）
      deps.memoryObjectRepo.archiveProject(fromId);
      break;
    }
    case "task": {
      const from = deps.memoryObjectRepo.getTaskByIdActive(fromId);
      const to = deps.memoryObjectRepo.getTaskByIdActive(toId);
      if (!from || !to) {
        fail("not_found", `任务合并失败：from ${fromId} 或 to ${toId} 未找到`);
      }
      fromSourceFactIds = from!.sourceFactIds;
      toObject = to;
      // 合并 sourceFactIds
      const mergedFactIds = Array.from(new Set([...to!.sourceFactIds, ...fromSourceFactIds]));
      deps.memoryObjectRepo.updateTask(toId, { sourceFactIds: mergedFactIds });
      // soft delete from
      deps.memoryObjectRepo.softDeleteTask(fromId);
      break;
    }
    case "person": {
      const from = deps.memoryObjectRepo.getPersonByIdActive(fromId);
      const to = deps.memoryObjectRepo.getPersonByIdActive(toId);
      if (!from || !to) {
        fail("not_found", `人物合并失败：from ${fromId} 或 to ${toId} 未找到`);
      }
      fromSourceFactIds = from!.sourceFactIds;
      toObject = to;
      // 合并 sourceFactIds 和 relatedProjectIds
      const mergedFactIds = Array.from(new Set([...to!.sourceFactIds, ...fromSourceFactIds]));
      const mergedRelatedProjectIds = Array.from(
        new Set([...to!.relatedProjectIds, ...from!.relatedProjectIds])
      );
      deps.memoryObjectRepo.updatePerson(toId, {
        sourceFactIds: mergedFactIds,
        relatedProjectIds: mergedRelatedProjectIds,
      });
      // soft delete from
      deps.memoryObjectRepo.softDeletePerson(fromId);
      break;
    }
    case "decision": {
      const from = deps.memoryObjectRepo.getDecisionByIdActive(fromId);
      const to = deps.memoryObjectRepo.getDecisionByIdActive(toId);
      if (!from || !to) {
        fail("not_found", `决策合并失败：from ${fromId} 或 to ${toId} 未找到`);
      }
      fromSourceFactIds = from!.sourceFactIds;
      toObject = to;
      // 合并 sourceFactIds
      const mergedFactIds = Array.from(new Set([...to!.sourceFactIds, ...fromSourceFactIds]));
      deps.memoryObjectRepo.updateDecision(toId, { sourceFactIds: mergedFactIds });
      // soft delete from
      deps.memoryObjectRepo.softDeleteDecision(fromId);
      break;
    }
    default:
      fail("schema_invalid", `不支持的对象类型: ${objectType}`);
  }

  // 触发 toObject 已使用，避免 lint 警告（保留以备后续扩展）
  void toObject;

  return {
    ok: true,
    fromId,
    toId,
    objectType,
  };
}

// ============================================================================
// 003 新增辅助函数：级联标记 stale / orphan
// 当 facts/scenes 被 soft delete 时，触发反向影响：
// 1. L3 反向影响（12.7 / 12.8）：
//    - 仅由被删 fact 支撑的 L3 对象 -> markOrphaned('source_deleted')
//    - 多来源 L3 对象 -> removeFactFromSourceLinks（不标记 orphan）
// 2. reports 标记 stale（12.5 / 22.11）：
//    - 引用了被删 fact/scene 的 reports -> markStale('source_deleted')
// ============================================================================

/**
 * 级联标记：facts/scenes 被软删除后触发反向影响
 *
 * 重要约束：
 * - soft delete 优先，不物理删除
 * - 不立即重算 project summary，仅标记 orphan_status='needs_review'
 *   由后续 Judge 处理（这里使用 'source_deleted' 表示来源已被删）
 * - 多来源对象只移除被删 fact 的引用，不进入 orphan
 */
export function cascadeMarkAfterFactSceneDelete(
  deps: CascadeMarkDeps,
  facts: Fact[],
  scenes: Scene[]
): void {
  const factIds = new Set(facts.map((f) => f.id));
  const sceneIds = new Set(scenes.map((s) => s.id));
  const reportIdsToMarkStale = new Set<string>();
  const STALE_REASON = "source_deleted";

  // 1. 处理 facts：L3 反向影响 + reports stale
  for (const fact of facts) {
    // 1a. L3 反向影响
    if (deps.memoryObjectRepo) {
      // 仅由该 fact 支撑的对象 -> markOrphaned
      const orphans = deps.memoryObjectRepo.findOrphansByFactId(fact.id);
      for (const orphan of orphans) {
        deps.memoryObjectRepo.markOrphaned(orphan.type, orphan.id, "source_deleted");
      }

      // 多来源对象 -> removeFactFromSourceLinks
      // 查找引用了该 fact 但 sourceFactIds.length > 1 的对象
      // 通过 listByProjectId / 全量扫描的成本较高，这里复用一个简单的查询：
      // 遍历 projects / tasks / decisions，找出 sourceFactIds 包含该 fact 且长度 > 1 的对象
      if (deps.db) {
        const tables: Array<{ type: "project" | "task" | "decision"; table: string; activeFilter: string }> = [
          { type: "project", table: "projects", activeFilter: "archived_at IS NULL" },
          { type: "task", table: "tasks", activeFilter: "deleted_at IS NULL" },
          { type: "decision", table: "decisions", activeFilter: "deleted_at IS NULL" },
        ];
        for (const t of tables) {
          const rows = deps.db
            .prepare(
              `SELECT id, source_fact_ids_json FROM ${t.table}
               WHERE ${t.activeFilter}
               AND EXISTS (
                 SELECT 1 FROM json_each(${t.table}.source_fact_ids_json)
                 WHERE json_each.value = ?
               )`
            )
            .all(fact.id) as Array<{ id: string; source_fact_ids_json: string }>;
          for (const row of rows) {
            let ids: string[] = [];
            try {
              const parsed = JSON.parse(row.source_fact_ids_json);
              if (Array.isArray(parsed)) ids = parsed;
            } catch {
              continue;
            }
            // 多来源：从数组中移除被删 fact id
            if (ids.length > 1) {
              deps.memoryObjectRepo.removeFactFromSourceLinks(t.type, row.id, fact.id);
            }
            // 单来源的情况已被 findOrphansByFactId 处理（markOrphaned）
          }
        }
      }
    }

    // 1b. reports stale
    if (deps.reportRepo) {
      const reports = deps.reportRepo.findReportsReferencingFact(fact.id);
      for (const r of reports) {
        reportIdsToMarkStale.add(r.id);
      }
    }
  }

  // 2. 处理 scenes：reports stale
  for (const scene of scenes) {
    if (deps.reportRepo) {
      const reports = deps.reportRepo.findReportsReferencingScene(scene.id);
      for (const r of reports) {
        reportIdsToMarkStale.add(r.id);
      }
    }
  }

  // 3. 批量标记 reports stale
  if (deps.reportRepo && reportIdsToMarkStale.size > 0) {
    deps.reportRepo.markStaleMany(Array.from(reportIdsToMarkStale), STALE_REASON);
  }

  // 触发 factIds/sceneIds 已使用，避免 lint 警告（保留以备后续扩展）
  void factIds;
  void sceneIds;
}
