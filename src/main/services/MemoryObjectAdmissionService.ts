import type { FactRepository } from "../db/repositories/FactRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type {
  Fact,
  MemoryObjectAdmissionEvidence,
  Person,
  Project,
} from "../models/types";

export const MEMORY_OBJECT_ADMISSION_RULE_VERSION = 1;

export type AdmissionObjectType = "project" | "person";
export type AdmissionStatus = "promoted" | "candidate" | "rejected";

export interface AdmissionCandidate {
  objectType: AdmissionObjectType;
  title: string;
  summary: string;
  sourceFactIds: string[];
  confidence: number;
  role?: string | null;
  organization?: string | null;
}

export interface AdmissionDecision {
  status: AdmissionStatus;
  reason: string;
  evidence: MemoryObjectAdmissionEvidence[];
}

export interface AdmissionResult {
  object: Project | Person;
  status: AdmissionStatus;
  created: boolean;
}

export class MemoryObjectAdmissionService {
  constructor(private readonly deps: {
    factRepo: FactRepository;
    memoryObjectRepo: MemoryObjectRepository;
  }) {}

  evaluateCandidate(candidate: AdmissionCandidate): AdmissionDecision {
    const requestedIds = [...new Set(candidate.sourceFactIds)];
    const facts = this.deps.factRepo.listByIds(requestedIds);
    return evaluateCandidateFromFacts(candidate, facts);
  }

  private reassessLoadedObject(
    objectType: AdmissionObjectType,
    object: Project | Person,
    prefetchedFacts?: Fact[]
  ): AdmissionDecision | null {
    if (object.admissionDecidedBy === "user") return null;
    const candidate: AdmissionCandidate = {
      objectType,
      title: object.name,
      summary: object.summary,
      sourceFactIds: object.sourceFactIds,
      confidence: 1,
      role: "role" in object ? object.role : undefined,
      organization: "organization" in object ? object.organization : undefined,
    };
    const decision = prefetchedFacts
      ? evaluateCandidateFromFacts(candidate, prefetchedFacts)
      : this.evaluateCandidate(candidate);
    const patch = {
      admissionStatus: decision.status,
      admissionReason: decision.reason,
      admissionEvidence: decision.evidence,
      admissionDecidedBy: "auto" as const,
      admissionRuleVersion: MEMORY_OBJECT_ADMISSION_RULE_VERSION,
      admissionReviewedAt: new Date().toISOString(),
    };
    if (objectType === "project") this.deps.memoryObjectRepo.updateProject(object.id, patch);
    else this.deps.memoryObjectRepo.updatePerson(object.id, patch);
    if (decision.status === "rejected") this.rejectObject(objectType, object.id);
    return decision;
  }

  private factsForObjects(objects: Array<Project | Person>): Map<string, Fact> {
    const ids = [...new Set(objects.flatMap((object) => object.sourceFactIds))];
    return new Map(this.deps.factRepo.listByIds(ids).map((fact) => [fact.id, fact]));
  }

  private factsForObject(object: Project | Person, facts: Map<string, Fact>): Fact[] {
    return [...new Set(object.sourceFactIds)].flatMap((id) => facts.get(id) ?? []);
  }

  private async yieldToEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Reassess legacy objects in small batches so Electron can keep painting and serving IPC. */
  async reassessHistorical(
    limit = 10,
    shouldContinue: () => boolean = () => true
  ): Promise<{ reviewed: number; promoted: number; candidate: number; rejected: number }> {
    const result = { reviewed: 0, promoted: 0, candidate: 0, rejected: 0 };
    for (const type of ["project", "person"] as const) {
      while (shouldContinue()) {
        const objects = type === "project"
          ? this.deps.memoryObjectRepo.listProjectsForAdmissionReview(MEMORY_OBJECT_ADMISSION_RULE_VERSION, limit)
          : this.deps.memoryObjectRepo.listPeopleForAdmissionReview(MEMORY_OBJECT_ADMISSION_RULE_VERSION, limit);
        if (objects.length === 0) break;
        const facts = this.factsForObjects(objects);
        let progressed = 0;
        for (const object of objects) {
          const decision = this.reassessLoadedObject(type, object, this.factsForObject(object, facts));
          if (!decision) continue;
          progressed++;
          result.reviewed++;
          result[decision.status]++;
        }
        if (progressed === 0) break;
        await this.yieldToEventLoop();
      }
    }
    return result;
  }

  admitOrAccumulate(candidate: AdmissionCandidate): AdmissionResult {
    const repo = this.deps.memoryObjectRepo;
    const existing = candidate.objectType === "project"
      ? repo.findProjectByExactIdentity(candidate.title)
      : repo.findPersonByExactIdentity(candidate.title);
    const sourceFactIds = [...new Set([...(existing?.sourceFactIds ?? []), ...candidate.sourceFactIds])];
    const accumulated = { ...candidate, sourceFactIds };

    if (existing?.admissionDecidedBy === "user") {
      const object = candidate.objectType === "project"
        ? repo.updateProject(existing.id, { sourceFactIds })!
        : repo.updatePerson(existing.id, { sourceFactIds })!;
      return { object, status: object.admissionStatus ?? "promoted", created: false };
    }

    const decision = this.evaluateCandidate(accumulated);
    const now = new Date().toISOString();
    const admission = {
      admissionStatus: decision.status,
      admissionReason: decision.reason,
      admissionEvidence: decision.evidence,
      admissionDecidedBy: "auto" as const,
      admissionRuleVersion: MEMORY_OBJECT_ADMISSION_RULE_VERSION,
      admissionReviewedAt: now,
    };

    if (existing) {
      const object = candidate.objectType === "project"
        ? repo.updateProject(existing.id, { sourceFactIds, ...admission })!
        : repo.updatePerson(existing.id, { sourceFactIds, ...admission })!;
      if (decision.status === "rejected") this.rejectObject(candidate.objectType, object.id);
      return { object, status: decision.status, created: false };
    }

    if (candidate.objectType === "project") {
      const object = repo.createProject({
        name: candidate.title,
        summary: candidate.summary,
        status: "active",
        lastActiveAt: now,
        sourceFactIds,
        sourceSceneIds: [],
        ...admission,
      });
      if (decision.status === "rejected") repo.archiveProject(object.id);
      return { object: repo.getProjectById(object.id)!, status: decision.status, created: true };
    }

    const object = repo.createPerson({
      name: candidate.title,
      role: candidate.role ?? null,
      organization: candidate.organization ?? null,
      relationship: null,
      summary: candidate.summary,
      relatedProjectIds: [],
      sourceFactIds,
      ...admission,
    });
    if (decision.status === "rejected") repo.softDeletePerson(object.id);
    return { object: repo.getPersonById(object.id)!, status: decision.status, created: true };
  }

  reassessObject(objectType: AdmissionObjectType, id: string): AdmissionDecision | null {
    const object = objectType === "project"
      ? this.deps.memoryObjectRepo.getProjectById(id)
      : this.deps.memoryObjectRepo.getPersonById(id);
    return object ? this.reassessLoadedObject(objectType, object) : null;
  }

  review(input: {
    objectType: AdmissionObjectType;
    id: string;
    decision: "promote" | "reject" | "restore";
  }): boolean {
    const repo = this.deps.memoryObjectRepo;
    const now = new Date().toISOString();
    if (input.decision === "restore") {
      return input.objectType === "project"
        ? repo.restoreProject(input.id)
        : repo.restorePerson(input.id);
    }
    const status = input.decision === "promote" ? "promoted" : "rejected";
    const patch = {
      admissionStatus: status as AdmissionStatus,
      admissionReason: `user_${input.decision}`,
      admissionDecidedBy: "user" as const,
      admissionRuleVersion: MEMORY_OBJECT_ADMISSION_RULE_VERSION,
      admissionReviewedAt: now,
    };
    const updated = input.objectType === "project"
      ? repo.updateProject(input.id, patch)
      : repo.updatePerson(input.id, patch);
    if (!updated) return false;
    if (status === "rejected") this.rejectObject(input.objectType, input.id);
    return true;
  }

  private rejectObject(objectType: AdmissionObjectType, id: string): void {
    if (objectType === "project") this.deps.memoryObjectRepo.archiveProject(id);
    else this.deps.memoryObjectRepo.softDeletePerson(id);
  }
}

function evaluateCandidateFromFacts(candidate: AdmissionCandidate, facts: Fact[]): AdmissionDecision {
  const requestedIds = [...new Set(candidate.sourceFactIds)];
  if (requestedIds.length === 0 || facts.length !== requestedIds.length) {
    return { status: "rejected", reason: "missing_or_invalid_source_facts", evidence: [] };
  }
  if (isObviousNoiseName(candidate.title)) {
    return { status: "rejected", reason: "obvious_noise_name", evidence: [] };
  }
  return candidate.objectType === "project"
    ? evaluateProject(candidate.title, facts)
    : evaluatePerson(candidate.title, facts);
}

function evaluateProject(title: string, facts: Fact[]): AdmissionDecision {
  const exact = facts.filter((fact) => normalize(fact.projectHint) === normalize(title));
  if (exact.length === 0) {
    return { status: "candidate", reason: "project_without_exact_hint", evidence: [] };
  }
  const strong = exact.filter((fact) =>
    ["task", "decision", "project_progress"].includes(fact.type)
    && !fact.inferred
    && fact.confidence >= 0.65
  );
  const episodes = new Set(exact.flatMap((fact) => fact.sourceEpisodeIds));
  const evidence = exact.map((fact): MemoryObjectAdmissionEvidence => ({
    factId: fact.id,
    kind: strong.includes(fact) ? "strong_work" : episodes.size >= 2 ? "continuity" : "exact_hint",
    episodeIds: fact.sourceEpisodeIds,
  }));
  if (strong.length > 0) return { status: "promoted", reason: "strong_project_evidence", evidence };
  if (episodes.size >= 2) return { status: "promoted", reason: "project_continuity_across_episodes", evidence };
  return { status: "candidate", reason: "project_needs_independent_episode", evidence };
}

function evaluatePerson(title: string, facts: Fact[]): AdmissionDecision {
  const exact = facts.filter((fact) =>
    (fact.peopleHints ?? []).some((hint) => normalize(hint) === normalize(title))
  );
  if (exact.length === 0) {
    return { status: "candidate", reason: "person_without_exact_hint", evidence: [] };
  }
  const sourceOnly = exact.every((fact) =>
    ["knowledge", "note"].includes(fact.type)
    && /作者|author|名单|示例|群昵称/i.test(fact.content)
  );
  if (sourceOnly) return { status: "rejected", reason: "source_author_or_list_only", evidence: [] };
  const direct = exact.filter((fact) =>
    ["person", "task", "decision", "project_progress"].includes(fact.type)
    && !fact.inferred
    && fact.confidence >= 0.65
  );
  const evidence = exact.map((fact): MemoryObjectAdmissionEvidence => ({
    factId: fact.id,
    kind: direct.includes(fact) ? "direct_relationship" : "exact_hint",
    episodeIds: fact.sourceEpisodeIds,
  }));
  return direct.length > 0
    ? { status: "promoted", reason: "direct_work_relationship", evidence }
    : { status: "candidate", reason: "person_relationship_not_established", evidence };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function isObviousNoiseName(name: string): boolean {
  const normalized = normalize(name);
  return !normalized
    || ["张三", "李四", "王五", "某某", "unknown", "用户", "作者", "群友"].includes(normalized)
    || /^示例/.test(normalized);
}
