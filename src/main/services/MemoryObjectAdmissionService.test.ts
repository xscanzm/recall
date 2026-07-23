import { describe, expect, it, vi } from "vitest";
import type { Fact } from "../models/types";
import { MemoryObjectAdmissionService } from "./MemoryObjectAdmissionService";

const fact = (patch: Partial<Fact> & Pick<Fact, "id" | "type">): Fact => ({
  content: "",
  status: null,
  projectId: null,
  projectHint: null,
  importance: 0.8,
  confidence: 0.9,
  inferred: false,
  evidenceText: null,
  sourceObservationIds: [],
  tags: [],
  createdAt: "2026-07-23T01:00:00.000Z",
  updatedAt: "2026-07-23T01:00:00.000Z",
  deletedAt: null,
  peopleHints: [],
  sourceEpisodeIds: [],
  claimStatus: "active",
  generationPath: null,
  generationVersion: 1,
  derivationKey: null,
  ...patch,
});

function service(facts: Fact[]) {
  return new MemoryObjectAdmissionService({
    factRepo: { listByIds: vi.fn((ids: string[]) => facts.filter((item) => ids.includes(item.id))) } as never,
    memoryObjectRepo: {} as never,
  });
}

describe("MemoryObjectAdmissionService", () => {
  it("promotes a project with explicit task evidence", () => {
    const evaluator = service([fact({ id: "f1", type: "task", projectHint: "Recall" })]);
    expect(evaluator.evaluateCandidate({
      objectType: "project",
      title: "Recall",
      summary: "",
      sourceFactIds: ["f1"],
      confidence: 0.9,
    })).toMatchObject({ status: "promoted", reason: "strong_project_evidence" });
  });

  it("keeps an ordinary project mention candidate until independent episodes accumulate", () => {
    const facts = [
      fact({ id: "f1", type: "note", projectHint: "Recall", sourceEpisodeIds: ["e1"] }),
      fact({ id: "f2", type: "note", projectHint: "Recall", sourceEpisodeIds: ["e2"] }),
    ];
    expect(service(facts).evaluateCandidate({
      objectType: "project",
      title: "Recall",
      summary: "",
      sourceFactIds: ["f1"],
      confidence: 0.8,
    }).status).toBe("candidate");
    expect(service(facts).evaluateCandidate({
      objectType: "project",
      title: "Recall",
      summary: "",
      sourceFactIds: ["f1", "f2"],
      confidence: 0.8,
    })).toMatchObject({ status: "promoted", reason: "project_continuity_across_episodes" });
  });

  it("promotes a person only when an exact hint has direct work evidence", () => {
    const evaluator = service([fact({
      id: "f1",
      type: "project_progress",
      peopleHints: ["陈晨"],
    })]);
    expect(evaluator.evaluateCandidate({
      objectType: "person",
      title: "陈晨",
      summary: "",
      sourceFactIds: ["f1"],
      confidence: 0.9,
    })).toMatchObject({ status: "promoted", reason: "direct_work_relationship" });
  });

  it("rejects authors, lists and example names as long-lived people", () => {
    const evaluator = service([fact({
      id: "f1",
      type: "knowledge",
      content: "文章作者：陈晨",
      peopleHints: ["陈晨"],
    })]);
    expect(evaluator.evaluateCandidate({
      objectType: "person",
      title: "陈晨",
      summary: "",
      sourceFactIds: ["f1"],
      confidence: 0.9,
    }).status).toBe("rejected");
    expect(evaluator.evaluateCandidate({
      objectType: "person",
      title: "张三",
      summary: "",
      sourceFactIds: ["f1"],
      confidence: 0.9,
    }).status).toBe("rejected");
  });

  it("rejects candidates whose model-provided source ids are not all real facts", () => {
    const evaluator = service([fact({ id: "f1", type: "task", projectHint: "Recall" })]);
    expect(evaluator.evaluateCandidate({
      objectType: "project",
      title: "Recall",
      summary: "",
      sourceFactIds: ["f1", "invented"],
      confidence: 0.9,
    })).toMatchObject({ status: "rejected", reason: "missing_or_invalid_source_facts" });
  });

  it("persists user decisions and restores soft-deleted objects with highest priority", () => {
    const memoryObjectRepo = {
      updateProject: vi.fn(() => ({ id: "project-1" })),
      updatePerson: vi.fn(() => ({ id: "person-1" })),
      archiveProject: vi.fn(() => true),
      softDeletePerson: vi.fn(() => true),
      restoreProject: vi.fn(() => true),
      restorePerson: vi.fn(() => true),
    };
    const admission = new MemoryObjectAdmissionService({
      factRepo: { listByIds: vi.fn(() => []) } as never,
      memoryObjectRepo: memoryObjectRepo as never,
    });

    expect(admission.review({ objectType: "project", id: "project-1", decision: "promote" })).toBe(true);
    expect(memoryObjectRepo.updateProject).toHaveBeenCalledWith("project-1", expect.objectContaining({
      admissionStatus: "promoted",
      admissionDecidedBy: "user",
    }));

    expect(admission.review({ objectType: "person", id: "person-1", decision: "reject" })).toBe(true);
    expect(memoryObjectRepo.updatePerson).toHaveBeenCalledWith("person-1", expect.objectContaining({
      admissionStatus: "rejected",
      admissionDecidedBy: "user",
    }));
    expect(memoryObjectRepo.softDeletePerson).toHaveBeenCalledWith("person-1");

    expect(admission.review({ objectType: "project", id: "project-1", decision: "restore" })).toBe(true);
    expect(admission.review({ objectType: "person", id: "person-1", decision: "restore" })).toBe(true);
    expect(memoryObjectRepo.restoreProject).toHaveBeenCalledWith("project-1");
    expect(memoryObjectRepo.restorePerson).toHaveBeenCalledWith("person-1");
  });

  it("reassesses every historical batch once without overriding user decisions", async () => {
    const projects: Array<{
      id: string;
      name: string;
      sourceFactIds: string[];
      admissionRuleVersion: number;
      admissionDecidedBy: "legacy" | "user";
    }> = ["one", "two", "three"].map((name) => ({
      id: `project-${name}`,
      name,
      sourceFactIds: [`fact-${name}`],
      admissionRuleVersion: 0,
      admissionDecidedBy: "legacy" as const,
    }));
    projects.push({
      id: "project-user",
      name: "user",
      sourceFactIds: ["fact-user"],
      admissionRuleVersion: 0,
      admissionDecidedBy: "user",
    });
    const facts = projects.map((project) => fact({
      id: project.sourceFactIds[0],
      type: "task",
      projectHint: project.name,
    }));
    const memoryObjectRepo = {
      listProjectsForAdmissionReview: vi.fn((ruleVersion: number, limit: number) => projects
        .filter((project) => project.admissionDecidedBy !== "user" && project.admissionRuleVersion < ruleVersion)
        .slice(0, limit)),
      listPeopleForAdmissionReview: vi.fn(() => []),
      getProjectById: vi.fn((id: string) => projects.find((project) => project.id === id) ?? null),
      updateProject: vi.fn((id: string, patch: { admissionRuleVersion: number }) => {
        const project = projects.find((item) => item.id === id);
        if (!project) return null;
        Object.assign(project, patch);
        return project;
      }),
      archiveProject: vi.fn(() => true),
    };
    const factRepo = { listByIds: vi.fn((ids: string[]) => facts.filter((item) => ids.includes(item.id))) };
    const admission = new MemoryObjectAdmissionService({
      factRepo: factRepo as never,
      memoryObjectRepo: memoryObjectRepo as never,
    });

    await expect(admission.reassessHistorical(2)).resolves.toMatchObject({ reviewed: 3, promoted: 3 });
    await expect(admission.reassessHistorical(2)).resolves.toMatchObject({ reviewed: 0 });
    expect(memoryObjectRepo.updateProject).not.toHaveBeenCalledWith("project-user", expect.anything());
    expect(factRepo.listByIds).toHaveBeenCalledTimes(2);
  });
});
