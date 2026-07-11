import type { Fact, MemoryRelationType, Scene } from "../models/types";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { MemoryEdgeRepository } from "../db/repositories/MemoryEdgeRepository";

export class SceneRelationProjector {
  private readonly sceneRepo: SceneRepository;
  private readonly factRepo: FactRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly edgeRepo: MemoryEdgeRepository | null;

  constructor(deps: {
    sceneRepo: SceneRepository;
    factRepo: FactRepository;
    memoryObjectRepo: MemoryObjectRepository;
    edgeRepo?: MemoryEdgeRepository;
  }) {
    this.sceneRepo = deps.sceneRepo;
    this.factRepo = deps.factRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.edgeRepo = deps.edgeRepo ?? null;
  }

  projectScenes(scenes: Scene[]): void {
    for (const scene of scenes) {
      this.projectScene(scene);
    }
  }

  projectScene(scene: Scene): void {
    const latestScene = this.sceneRepo.getByIdActive(scene.id) ?? scene;
    const facts = this.factRepo
      .listByIds(latestScene.factIds)
      .filter((fact) => !fact.deletedAt);
    if (facts.length === 0) return;

    const activeProjects = this.memoryObjectRepo.listProjects({
      includeArchived: false,
      limit: 500,
    });
    const activeTasks = this.memoryObjectRepo.listTasks({
      includeDeleted: false,
      limit: 500,
    });
    const activeDecisions = this.memoryObjectRepo.listDecisions({
      includeDeleted: false,
      limit: 500,
    });
    const activePeople = this.memoryObjectRepo.listPeople({
      includeDeleted: false,
      limit: 500,
    });

    const sceneFactIds = new Set(facts.map((fact) => fact.id));
    const projectIds = this.collectSceneProjectIds(facts, activeProjects);
    const primaryProjectId = projectIds[0] ?? null;
    const taskIds = activeTasks
      .filter((task) => task.sourceFactIds.some((id) => sceneFactIds.has(id)))
      .map((task) => task.id);
    const decisionIds = activeDecisions
      .filter((decision) => decision.sourceFactIds.some((id) => sceneFactIds.has(id)))
      .map((decision) => decision.id);
    const people = activePeople.filter((person) =>
      person.sourceFactIds.some((id) => sceneFactIds.has(id))
    );
    const entityNames = Array.from(
      new Set([
        ...latestScene.entityNames,
        ...people.map((person) => person.name),
        ...activeProjects
          .filter((project) => projectIds.includes(project.id))
          .map((project) => project.name),
      ])
    );

    this.sceneRepo.update(latestScene.id, {
      projectId: primaryProjectId,
      taskIds,
      decisionIds,
      entityNames,
    });

    if (primaryProjectId) {
      for (const fact of facts) {
        if (fact.projectId) continue;
        try {
          this.factRepo.update(fact.id, { projectId: primaryProjectId });
        } catch {
          // 单条 fact 回填失败不阻断
        }
      }
    }

    for (const projectId of projectIds) {
      const project = activeProjects.find((item) => item.id === projectId);
      if (!project) continue;
      if (!project.sourceSceneIds.includes(latestScene.id)) {
        this.memoryObjectRepo.updateProject(project.id, {
          sourceSceneIds: [...project.sourceSceneIds, latestScene.id],
          lastActiveAt: latestScene.endAt,
        });
      }
      this.ensureEdge(
        latestScene.id,
        "project",
        project.id,
        "belongs_to",
        latestScene.factIds
      );
    }

    for (const taskId of taskIds) {
      const task = activeTasks.find((item) => item.id === taskId);
      if (!task) continue;
      if (!task.projectId && primaryProjectId) {
        this.memoryObjectRepo.updateTask(task.id, { projectId: primaryProjectId });
      }
      this.ensureEdge(latestScene.id, "task", task.id, "contains", latestScene.factIds);
    }

    for (const decisionId of decisionIds) {
      const decision = activeDecisions.find((item) => item.id === decisionId);
      if (!decision) continue;
      if (!decision.projectId && primaryProjectId) {
        this.memoryObjectRepo.updateDecision(decision.id, { projectId: primaryProjectId });
      }
      this.ensureEdge(
        latestScene.id,
        "decision",
        decision.id,
        "contains",
        latestScene.factIds
      );
    }

    for (const person of people) {
      const mergedProjectIds = Array.from(
        new Set([...person.relatedProjectIds, ...projectIds])
      );
      if (mergedProjectIds.length !== person.relatedProjectIds.length) {
        this.memoryObjectRepo.updatePerson(person.id, {
          relatedProjectIds: mergedProjectIds,
        });
      }
      this.ensureEdge(latestScene.id, "person", person.id, "involves", latestScene.factIds);
    }
  }

  private collectSceneProjectIds(
    facts: Fact[],
    projects: Array<{ id: string; name: string; sourceFactIds: string[] }>
  ): string[] {
    const scores = new Map<string, number>();
    for (const fact of facts) {
      if (fact.projectId) {
        scores.set(fact.projectId, (scores.get(fact.projectId) ?? 0) + 2 + fact.confidence);
      }
    }

    for (const project of projects) {
      const relatedFacts = facts.filter((fact) => project.sourceFactIds.includes(fact.id));
      if (relatedFacts.length === 0) continue;
      const weight = relatedFacts.reduce((sum, fact) => sum + 1 + fact.confidence, 0);
      scores.set(project.id, (scores.get(project.id) ?? 0) + weight);
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  }

  private ensureEdge(
    sceneId: string,
    toType: "project" | "task" | "decision" | "person",
    toId: string,
    relationType: MemoryRelationType,
    evidenceIds: string[]
  ): void {
    if (!this.edgeRepo) return;
    try {
      const existing = this.edgeRepo
        .listFrom("scene", sceneId, { status: "active", limit: 200 })
        .some(
          (edge) =>
            edge.toType === toType &&
            edge.toId === toId &&
            edge.relationType === relationType
        );
      if (existing) return;
      this.edgeRepo.create({
        fromType: "scene",
        fromId: sceneId,
        toType,
        toId,
        relationType,
        confidence: 0.9,
        createdBy: "system",
        evidenceIds,
        status: "active",
        reason: "scene_relation_projector",
      });
    } catch {
      // 单条 edge 写入失败不阻断
    }
  }
}
