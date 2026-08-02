import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import type { Fact, Scene } from "../../models/types";
import {
  applyCorrection,
  cascadeMarkAfterFactSceneDelete,
  mergeObjects,
} from "../../services/cascadeMark";
import { handleValidated, ipcFail } from "../validated";

/**
 * 安全空状态占位
 */
const EMPTY_TODAY = {
  observations: [],
  facts: [],
  scenes: [],
  tasks: [],
  decisions: [],
  people: [],
  projects: [],
};

export function registerMemoryHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "memory:listToday", () => {
    // M4：从 Repositories 读取今日数据
    // - observations：今日捕获的 L0 观察记录
    // - facts：由今日 observations / scenes 反推出的今日事实（避免混入历史全局 facts）
    // - scenes：今日的 L2 场景
    // - tasks：未删除的 L3 任务（按 updated_at 降序）
    // - decisions：未删除的 L3 决策
    // - people：未删除的 L3 人物
    // - projects：未归档的 L3 项目
    try {
      const observations = deps.observationRepo?.listToday() ?? [];
      const scenes = deps.sceneRepo?.listToday() ?? [];
      const factMap = new Map<string, Fact>();

      if (deps.factRepo) {
        const sceneFactIds = Array.from(new Set(scenes.flatMap((scene) => scene.factIds)));
        for (const fact of deps.factRepo.listByIds(sceneFactIds)) {
          factMap.set(fact.id, fact);
        }

        for (const observation of observations) {
          for (const fact of deps.factRepo.listBySourceObservationId(observation.id)) {
            factMap.set(fact.id, fact);
          }
        }
      }

      const facts = Array.from(factMap.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);

      return {
        observations,
        facts,
        scenes,
        tasks: deps.memoryObjectRepo?.listTasks({ includeDeleted: false }) ?? [],
        decisions: deps.memoryObjectRepo?.listDecisions({ includeDeleted: false }) ?? [],
        people: deps.memoryObjectRepo?.listPeople({ includeDeleted: false }) ?? [],
        projects: deps.memoryObjectRepo?.listProjects({ includeArchived: false }) ?? [],
      };
    } catch {
      // 查询失败时返回空状态（避免 renderer 端崩溃）
      return EMPTY_TODAY;
    }
  });

  handleValidated(ipcMain, "memory:updateFact", (_event, input) => {
    if (!deps.factRepo) {
      ipcFail("not_ready", "FactRepository 未初始化");
    }
    // 重要约束（来自 spec.md "删除和纠错"）：不覆盖 source ids
    // 这里只更新传入的字段（content/importance/status/tags），不动 source_observation_ids_json
    const patch: Record<string, unknown> = {};
    if (input.content !== undefined) patch.content = input.content;
    if (input.importance !== undefined) patch.importance = input.importance;
    if (input.status !== undefined) patch.status = input.status;
    if (input.tags !== undefined) patch.tags = input.tags;
    const updated = deps.factRepo.update(input.id, patch);
    if (!updated) {
      ipcFail("not_found", `未找到线索 ${input.id}`);
    }
    return { ok: true, fact: updated };
  });

  handleValidated(ipcMain, "memory:updateTask", (_event, input) => {
    if (!deps.memoryObjectRepo) {
      ipcFail("not_ready", "MemoryObjectRepository 未初始化");
    }
    // 重要约束：不覆盖 source ids
    const patch: Record<string, unknown> = {};
    if (input.title !== undefined) patch.title = input.title;
    if (input.status !== undefined) patch.status = input.status;
    if (input.projectId !== undefined) patch.projectId = input.projectId;
    if (input.summary !== undefined) patch.summary = input.summary;
    // 标记完成时同步设置 completedAt
    if (input.status === "done") {
      patch.completedAt = new Date().toISOString();
    }
    const updated = deps.memoryObjectRepo.updateTask(input.id, patch);
    if (!updated) {
      ipcFail("not_found", `未找到任务 ${input.id}`);
    }
    return { ok: true, task: updated };
  });

  handleValidated(ipcMain, "memory:updatePerson", (_event, input) => {
    if (!deps.memoryObjectRepo) {
      ipcFail("not_ready", "MemoryObjectRepository 未初始化");
    }
    // 重要约束：Person.summary 是非空 string，null 转为 ""（允许用户清空简介）
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.role !== undefined) patch.role = input.role;
    if (input.organization !== undefined) patch.organization = input.organization;
    if (input.relationship !== undefined) patch.relationship = input.relationship;
    if (input.summary !== undefined) patch.summary = input.summary === null ? "" : input.summary;
    const updated = deps.memoryObjectRepo.updatePerson(input.id, patch);
    if (!updated) {
      ipcFail("not_found", `未找到人物 ${input.id}`);
    }
    return { ok: true, person: updated };
  });

  handleValidated(ipcMain, "memory:deleteObject", (_event, input) => {
    if (!deps.db || !deps.memoryObjectRepo || !deps.factRepo || !deps.sceneRepo) {
      ipcFail("not_ready", "Repositories 未初始化");
    }
    // soft delete + 级联标记整体纳入事务（better-sqlite3 transaction 为同步 API：
    // 事务体内禁止 await / async 函数，任一步失败整体回滚，不再吞错返回成功）
    const { id, type } = input;
    let staleReportIds: string[] = [];
    deps.db.transaction(() => {
      let deleted = false;
      let deletedFact: Fact | null = null;
      let deletedScene: Scene | null = null;
      switch (type) {
        case "fact":
          // 先取出 fact（用于级联标记），再 soft delete
          deletedFact = deps.factRepo!.getByIdActive(id);
          deleted = deps.factRepo!.softDelete(id);
          break;
        case "scene":
          deletedScene = deps.sceneRepo!.getByIdActive(id);
          deleted = deps.sceneRepo!.softDelete(id);
          break;
        case "task":
          deleted = deps.memoryObjectRepo!.softDeleteTask(id);
          break;
        case "person":
          deleted = deps.memoryObjectRepo!.softDeletePerson(id);
          break;
        case "decision":
          deleted = deps.memoryObjectRepo!.softDeleteDecision(id);
          break;
        case "project":
          // 项目使用 archive 而非删除（保留 source 链路）
          deleted = deps.memoryObjectRepo!.archiveProject(id);
          break;
        default:
          ipcFail("schema_invalid", `不支持的删除类型: ${type}`);
      }
      if (!deleted) {
        ipcFail("not_found", `未找到 ${type} ${id} 或已删除`);
      }
      // 级联标记：fact / scene 软删除后触发 reports.markStale + L3 orphan 标记
      // （12.5 / 12.7 / 12.8 / 22.11）。事务内只收集受影响的 reportIds，
      // deleteImage（异步副作用）必须在事务提交之后执行。
      try {
        cascadeMarkAfterFactSceneDelete(
          {
            ...deps,
            onReportsStale: (reportIds) => {
              staleReportIds = reportIds;
            },
          },
          deletedFact ? [deletedFact] : [],
          deletedScene ? [deletedScene] : []
        );
      } catch (err) {
        // 级联失败 → 整个事务回滚，返回结构化错误（不再吞错返回成功）
        ipcFail(
          "delete_cascade_failed",
          `级联标记失败，删除已回滚: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();

    // 事务提交成功后，再触发信息图清理（异步副作用，不得在事务内执行）
    for (const reportId of staleReportIds) {
      void deps.infographicService?.deleteImage(reportId);
    }

    return { ok: true };
  });

  // -------------------- memory: 用户纠错（来自 spec.md "用户纠错"） --------------------
  /**
   * 处理逻辑（来自 spec.md Flow 6）：
   * 1. 保存 edit history（通过 patch 更新对应对象）
   * 2. 更新对应对象（不覆盖 source ids）
   * 3. 把纠错写入 user_feedback
   * 4. 后续 Judge 和 Linker 调用时带入用户反馈摘要
   *
   * 纠错类型映射：
   * - content_wrong -> 更新 content
   * - not_important -> 降低 importance
   * - wrong_project -> 更新 projectId
   * - task_done -> 更新 status=done + completedAt
   * - not_a_task -> soft delete
   * - do_not_record -> soft delete + 写入 user_feedback
   * - sensitive_delete -> hard delete（敏感内容才硬删除）
   */
  handleValidated(ipcMain, "memory:createUserFeedback", (_event, input) => {
    if (!deps.settingsService) {
      ipcFail("not_ready", "SettingsService 未初始化");
    }
    if (!deps.db || !deps.correctionLifecycleRepo) {
      ipcFail("not_ready", "Correction lifecycle repository 未初始化");
    }

    const { targetType, targetId, feedbackType, note, patch: objectPatch } = input;

    const feedback = deps.db.transaction(() => {
      const before = readCorrectionTarget(deps, targetType, targetId);
      if (before === null) ipcFail("not_found", `未找到纠错目标 ${targetType}:${targetId}`);

      applyCorrection(deps, targetType, targetId, feedbackType, objectPatch);
      const after = readCorrectionTarget(deps, targetType, targetId);
      deps.correctionLifecycleRepo!.recordRevision({ targetType, targetId, feedbackType, before, after });

      return deps.settingsService.createUserFeedback({
        targetType,
        targetId,
        feedbackType,
        note: JSON.stringify({ note: note ?? null, before, after }),
      });
    })();

    void deps.projectionInvalidationProcessor?.processPending();

    return { ok: true, feedback };
  });

  // -------------------- memory: 项目详情（来自 spec.md "项目详情"） --------------------
  /**
   * 返回项目主线 + 最近场景 + 任务 + 决策 + 人物 + 报告片段
   */
  handleValidated(ipcMain, "memory:getProjectDetail", (_event, input) => {
    if (!deps.memoryObjectRepo || !deps.sceneRepo || !deps.factRepo || !deps.reportRepo) {
      ipcFail("not_ready", "Repositories 未初始化");
    }
    const { id } = input;

    const project = deps.memoryObjectRepo.getProjectByIdActive(id);
    if (!project) {
      ipcFail("not_found", `未找到项目 ${id}`);
    }

    // 项目主线：summary + 最近 facts/scenes
    const sceneCandidates = [
      ...deps.sceneRepo.listByProjectId(id, { includeDeleted: false, limit: 20 }),
      ...project.sourceSceneIds
        .map((sceneId) => deps.sceneRepo!.getByIdActive(sceneId))
        .filter((scene): scene is NonNullable<typeof scene> => !!scene),
    ];
    const scenes = Array.from(new Map(sceneCandidates.map((scene) => [scene.id, scene])).values())
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 10);
    const facts = Array.from(
      new Map([
        ...deps.factRepo
          .listByProjectId(id, { includeDeleted: false, limit: 20 })
          .map((fact) => [fact.id, fact] as const),
        ...deps.factRepo
          .listByIds(Array.from(new Set(scenes.flatMap((scene) => scene.factIds))))
          .map((fact) => [fact.id, fact] as const),
      ]).values()
    )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);
    const tasks = Array.from(
      new Map([
        ...deps.memoryObjectRepo
          .listTasks({ projectId: id, includeDeleted: false, limit: 50 })
          .map((task) => [task.id, task] as const),
        ...Array.from(new Set(scenes.flatMap((scene) => scene.taskIds)))
          .map((taskId) => deps.memoryObjectRepo!.getTaskByIdActive(taskId))
          .filter((task): task is NonNullable<typeof task> => !!task)
          .map((task) => [task.id, task] as const),
      ]).values()
    )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
    const decisions = Array.from(
      new Map([
        ...deps.memoryObjectRepo
          .listDecisions({ projectId: id, includeDeleted: false, limit: 20 })
          .map((decision) => [decision.id, decision] as const),
        ...Array.from(new Set(scenes.flatMap((scene) => scene.decisionIds)))
          .map((decisionId) => deps.memoryObjectRepo!.getDecisionByIdActive(decisionId))
          .filter((decision): decision is NonNullable<typeof decision> => !!decision)
          .map((decision) => [decision.id, decision] as const),
      ]).values()
    )
      .sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? ""))
      .slice(0, 20);
    const people = deps.memoryObjectRepo
      .listPeople({ includeDeleted: false, limit: 50 })
      .filter((p) => p.relatedProjectIds.includes(id));

    // 报告片段：列出 source_fact_ids 或 source_scene_ids 命中项目相关证据的 reports
    const projectFactIds = new Set(facts.map((f) => f.id));
    const projectSceneIds = new Set(scenes.map((scene) => scene.id));
    const recentReports = deps.reportRepo.list({ limit: 10 }).filter((r) =>
      r.sourceFactIds.some((fid) => projectFactIds.has(fid)) ||
      r.sourceSceneIds.some((sid) => projectSceneIds.has(sid))
    );

    return {
      project,
      facts,
      scenes,
      tasks,
      decisions,
      people,
      recentReports,
    };
  });

  handleValidated(ipcMain, "memory:getPersonDetail", (_event, input) => {
    if (!deps.memoryObjectRepo || !deps.sceneRepo || !deps.factRepo) {
      ipcFail("not_ready", "Repositories 未初始化");
    }

    const { id } = input;
    const person = deps.memoryObjectRepo.getPersonByIdActive(id);
    if (!person) {
      ipcFail("not_found", `未找到人物 ${id}`);
    }

    const knownNames = new Set<string>([person.name, ...(person.aliases ?? [])].filter(Boolean));

    const personEdges = deps.memoryEdgeRepo
      ? [
          ...deps.memoryEdgeRepo.listFrom("person", id, { status: "active", limit: 500 }),
          ...deps.memoryEdgeRepo.listTo("person", id, { status: "active", limit: 500 }),
        ]
      : [];
    const edgeIds = (types: string[]) => new Set(
      personEdges.flatMap((edge) => {
        if (edge.fromType === "person" && edge.fromId === id && types.includes(edge.toType)) return [edge.toId];
        if (edge.toType === "person" && edge.toId === id && types.includes(edge.fromType)) return [edge.fromId];
        return [];
      })
    );
    const edgeFactIds = edgeIds(["fact", "atom"]);
    const edgeSceneIds = edgeIds(["scene", "episode"]);
    const edgeTaskIds = edgeIds(["task"]);
    const edgeProjectIds = edgeIds(["project"]);

    const heuristicFacts = Array.from(
      new Map([
        ...deps.factRepo.listByIds(person.sourceFactIds).map((fact) => [fact.id, fact] as const),
        ...deps.factRepo
          .list({ includeDeleted: false, limit: 500 })
          .filter((fact) => {
            if (fact.peopleHints?.some((name) => knownNames.has(name))) return true;
            return Array.from(knownNames).some((name) => fact.content.includes(name));
          })
          .map((fact) => [fact.id, fact] as const),
      ]).values()
    )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 120);
    const relatedFacts = edgeFactIds.size > 0
      ? deps.factRepo.listByIds(Array.from(edgeFactIds))
      : heuristicFacts;

    const relatedFactIds = new Set(relatedFacts.map((fact) => fact.id));

    const heuristicScenes = deps.sceneRepo
      .listByStartAt({ includeDeleted: false, limit: 500 })
      .filter((scene) => {
        if (scene.entityNames.some((name) => knownNames.has(name))) return true;
        return scene.factIds.some((factId) => relatedFactIds.has(factId));
      })
      .sort((a, b) => b.startAt.localeCompare(a.startAt))
      .slice(0, 80);
    const relatedScenes = edgeSceneIds.size > 0
      ? deps.sceneRepo.listByIds(Array.from(edgeSceneIds))
      : heuristicScenes;

    const allTasks = deps.memoryObjectRepo
      .listTasks({ includeDeleted: false, limit: 300 })
    const relatedTasks = allTasks
      .filter((task) => edgeTaskIds.size > 0
        ? edgeTaskIds.has(task.id)
        : task.sourceFactIds.some((factId) => relatedFactIds.has(factId)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 80);

    const relatedProjectIds = new Set<string>([
      ...person.relatedProjectIds,
      ...edgeProjectIds,
      ...relatedFacts
        .map((fact) => fact.projectId)
        .filter((projectId): projectId is string => !!projectId),
      ...relatedScenes
        .map((scene) => scene.projectId)
        .filter((projectId): projectId is string => !!projectId),
      ...relatedTasks
        .map((task) => task.projectId)
        .filter((projectId): projectId is string => !!projectId),
    ]);

    const relatedProjects = Array.from(relatedProjectIds)
      .map((projectId) => deps.memoryObjectRepo!.getProjectByIdActive(projectId))
      .filter((project): project is NonNullable<typeof project> => !!project)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      person,
      relatedProjects,
      relatedScenes,
      relatedTasks,
      relatedFacts,
    };
  });

  // -------------------- memory: 合并对象（来自 spec.md "合并对象基础能力"） --------------------
  /**
   * 当 Linker 输出 mergeSuggestions 时，写入 proactive_items 作为 needs_confirmation。
   * 用户在提醒页确认合并时，调用合并 API。
   *
   * 012 增强：
   * - facts.projectHint / projectId 改写（项目合并）
   * - facts.people_hints 改写（人物合并）
   * - scenes.entityNames 改写
   * - to.aliases 追加 from.name
   * - object_merges 审计
   */
  handleValidated(ipcMain, "memory:mergeObjects", (_event, input) => {
    if (!deps.memoryObjectRepo || !deps.factRepo || !deps.sceneRepo) {
      ipcFail("not_ready", "Repositories 未初始化");
    }
    const { objectType, fromId, toId, reason } = input;

    const merged = mergeObjects(deps, objectType, fromId, toId, {
      source: "user_manual",
      reason,
    });
    return { ok: true, merged };
  });

  // -------------------- memory: 合并建议（来自 Linker 输出的 mergeSuggestions） --------------------
  /**
   * 012/013 新增：列出所有 merge_suggestion 类型的 proactive_item
   * - 用于前端"合并建议"列表（默认 status='new'）
   * - 配合 mergeSuggestion payloadJson 解析后展示 from/to 详情
   */
  handleValidated(ipcMain, "memory:listMergeSuggestions", (_event, input) => {
    if (!deps.proactiveItemRepo) {
      ipcFail("not_ready", "ProactiveItemRepository 未初始化");
    }
    const opts: { status?: string; limit?: number } = { limit: input?.limit ?? 200 };
    if (input?.status && input.status !== "all") {
      opts.status = input.status;
    }
    const items = deps.proactiveItemRepo.listMergeSuggestions(opts);
    return { ok: true, items };
  });

  /**
   * 012/013 新增：拒绝某个 merge_suggestion
   * - 不执行合并，仅把 proactive_item 状态改为 ignored
   * - 用户后续可以再通过"合并到..."手动发起
   */
  handleValidated(ipcMain, "memory:rejectMergeSuggestion", (_event, input) => {
    if (!deps.proactiveItemRepo) {
      ipcFail("not_ready", "ProactiveItemRepository 未初始化");
    }
    const item = deps.proactiveItemRepo.getById(input.id);
    if (!item) {
      ipcFail("not_found", `merge_suggestion ${input.id} 不存在`);
    }
    if (item!.type !== "merge_suggestion") {
      ipcFail("invalid_input", `proactive_item ${input.id} 不是 merge_suggestion 类型`);
    }
    deps.proactiveItemRepo.updateStatus(input.id, "ignored");
    return { ok: true };
  });

  /**
   * 012/013 新增：列出所有已知别名（项目 + 人物）
   * - 用于 Linker / Extractor prompt 注入，让模型识别到 from.name 时映射到 to
   * - 返回简化格式：{projects: [{id, name, aliases}], people: [{id, name, aliases}]}
   */
  handleValidated(ipcMain, "memory:listAllAliases", () => {
    if (!deps.memoryObjectRepo) {
      ipcFail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return {
      ok: true,
      projects: deps.memoryObjectRepo.listProjectAliases(),
      people: deps.memoryObjectRepo.listPersonAliases(),
    };
  });

  /**
   * 012 新增：列出所有人物
   * - 用于人物页 PeoplePage 渲染
   * - 返回 Person 完整字段（含 aliases）
   */
  handleValidated(ipcMain, "memory:listPeople", (_event, input) => {
    if (!deps.memoryObjectRepo) {
      ipcFail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return {
      ok: true,
      people: deps.memoryObjectRepo.listPeople({
        includeDeleted: input?.includeDeleted ?? false,
        admissionStatus: input?.admissionStatus,
        includeNonPromoted: input?.includeNonPromoted,
        limit: 500,
      }),
    };
  });

  /**
   * 012 新增：列出所有项目
   * - 用于项目页 ProjectsPage 渲染
   * - 返回 Project 完整字段（含 aliases）
   */
  handleValidated(ipcMain, "memory:listProjects", (_event, input) => {
    if (!deps.memoryObjectRepo) {
      ipcFail("not_ready", "MemoryObjectRepository 未初始化");
    }
    return {
      ok: true,
      projects: deps.memoryObjectRepo.listProjects({
        includeArchived: input?.includeArchived ?? false,
        admissionStatus: input?.admissionStatus,
        includeNonPromoted: input?.includeNonPromoted,
        limit: 500,
      }),
    };
  });

  handleValidated(ipcMain, "memory:reviewAdmission", (_event, input) => {
    if (!deps.memoryObjectAdmissionService) {
      ipcFail("not_ready", "MemoryObjectAdmissionService 未初始化");
    }
    const updated = deps.memoryObjectAdmissionService.review(input);
    if (!updated) ipcFail("not_found", "未找到待审核对象");
    return { ok: true };
  });
}

function readCorrectionTarget(
  deps: IpcDeps,
  targetType: "fact" | "task" | "scene" | "project" | "person" | "decision" | "reminder",
  targetId: string
): unknown {
  switch (targetType) {
    case "fact": return deps.factRepo?.getByIdActive(targetId) ?? null;
    case "scene": return deps.sceneRepo?.getByIdActive(targetId) ?? null;
    case "project": return deps.memoryObjectRepo?.getProjectByIdActive(targetId) ?? null;
    case "task": return deps.memoryObjectRepo?.getTaskByIdActive(targetId) ?? null;
    case "person": return deps.memoryObjectRepo?.getPersonByIdActive(targetId) ?? null;
    case "decision": return deps.memoryObjectRepo?.getDecisionByIdActive(targetId) ?? null;
    case "reminder": return deps.proactiveItemRepo?.getById(targetId) ?? null;
  }
}
