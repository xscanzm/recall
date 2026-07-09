import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type {
  DebugEvent,
  ExtractorOutputV2,
  Fact,
  Observation,
  Scene,
} from "../models/types";
import { ExtractorOutputV2Schema } from "../models/schemas";
import { EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE } from "../models/prompts";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { SettingsService } from "./SettingsService";

interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  summary: string;
}

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  projectId: string | null;
  summary: string | null;
}

interface EpisodePayload {
  sceneId: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  entityNames: string[];
  observationIds: string[];
  observations: Array<Record<string, unknown>>;
}

export interface EpisodeFactExtractorResult {
  facts: Fact[];
  discardedNoise: ExtractorOutputV2["discardedNoise"];
  modelJobId: string;
  attempts: number;
}

export class EpisodeFactExtractorWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly factRepo: FactRepository;
  private readonly observationRepo: ObservationRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    factRepo: FactRepository;
    observationRepo: ObservationRepository;
    memoryObjectRepo: MemoryObjectRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.factRepo = deps.factRepo;
    this.observationRepo = deps.observationRepo;
    this.memoryObjectRepo = deps.memoryObjectRepo;
    this.settingsService = deps.settingsService ?? null;
  }

  async run(input: {
    scenes: Scene[];
    multimodalModelConfigId: string;
    debugEvents?: DebugEvent[];
  }): Promise<JobResult<EpisodeFactExtractorResult>> {
    const { scenes, multimodalModelConfigId, debugEvents } = input;
    const episodes = this.loadEpisodes(scenes);
    if (episodes.length === 0) {
      debugEvents?.push({
        layer: "L2",
        action: "skip",
        reason: "no_episode_observations_for_fact_extraction",
      });
      return {
        ok: true,
        data: {
          facts: [],
          discardedNoise: [],
          modelJobId: "",
          attempts: 0,
        },
        modelJobId: "",
        attempts: 0,
      };
    }

    const extractorInput = {
      episodes,
      activeKnownProjects: this.fetchActiveProjects(),
      activeTasks: this.fetchActiveTasks(),
      userFeedbackSummary: this.fetchUserFeedbackSummary(),
    };
    const inputJson = JSON.stringify(extractorInput, null, 2);
    const knownAliasesBlock = this.buildKnownAliasesBlock();
    const userPrompt = EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE.replace(
      "{{episode_extractor_input_json}}",
      inputJson
    ).replace("{{known_aliases_block}}", knownAliasesBlock);

    const jobInputJson = JSON.stringify({
      sceneIds: scenes.map((scene) => scene.id),
      observationCount: episodes.reduce(
        (sum, episode) => sum + episode.observations.length,
        0
      ),
      projectCount: extractorInput.activeKnownProjects.length,
      taskCount: extractorInput.activeTasks.length,
    });

    const result = await this.modelJobQueue.enqueueMultimodalJob<ExtractorOutputV2>({
      type: "episode_fact_extractor",
      priority: 2,
      executor: async () => {
        return this.modelGateway.callMultimodal<ExtractorOutputV2>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "episode_fact_extractor",
            jobInputJson,
          },
          ExtractorOutputV2Schema
        );
      },
    });

    if (!result.ok || !result.data) {
      return {
        ok: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 0,
      };
    }

    const facts: Fact[] = [];
    for (const factInput of result.data.facts) {
      try {
        const fact = this.factRepo.create({
          type: factInput.type,
          content: factInput.content,
          status: factInput.status ?? null,
          projectId: null,
          projectHint: factInput.projectHint ?? null,
          importance: factInput.importance,
          confidence: factInput.confidence,
          inferred: factInput.inferred,
          evidenceText: factInput.evidenceText,
          sourceObservationIds: factInput.sourceObservationIds,
          tags: factInput.tags,
          displayUse: factInput.displayUse,
          reportable: factInput.reportable,
          privateRisk: factInput.privateRisk,
          userValue: factInput.userValue,
          peopleHints: factInput.peopleHints ?? null,
        });
        facts.push(fact);
      } catch {
        debugEvents?.push({
          layer: "L2",
          action: "discard",
          reason: "fact_persist_failed",
        });
      }
    }

    return {
      ok: true,
      data: {
        facts,
        discardedNoise: result.data.discardedNoise,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 0,
      },
      modelJobId: result.modelJobId ?? "",
      attempts: result.attempts ?? 0,
    };
  }

  private loadEpisodes(scenes: Scene[]): EpisodePayload[] {
    const episodes: EpisodePayload[] = [];
    for (const scene of scenes) {
      const observations = scene.observationIds
        .map((id) => this.observationRepo.getById(id))
        .filter((obs): obs is Observation => !!obs);
      if (observations.length === 0) continue;

      episodes.push({
        sceneId: scene.id,
        title: scene.title,
        summary: scene.summary,
        startAt: scene.startAt,
        endAt: scene.endAt,
        entityNames: scene.entityNames,
        observationIds: scene.observationIds,
        observations: observations.map((obs) => this.toObservationPayload(obs)),
      });
    }
    return episodes;
  }

  private toObservationPayload(obs: Observation): Record<string, unknown> {
    return {
      id: obs.id,
      capturedAt: obs.capturedAt,
      appName: obs.appName,
      windowTitle: obs.windowTitle,
      urlOrDomain: obs.urlOrDomain,
      captureReason: obs.captureReason,
      sceneSummary: obs.sceneSummary,
      userFacingSummary: obs.userFacingSummary ?? null,
      likelyWorkPurpose: obs.likelyWorkPurpose ?? null,
      visibleContent: obs.visibleContent,
      detectedEntities: obs.detectedEntities,
      possibleIntent: obs.possibleIntent,
      possibleTasks: obs.possibleTasks,
      possibleDecisions: obs.possibleDecisions,
      sensitivity: obs.sensitivity,
      confidence: obs.confidence,
      uncertainties: obs.uncertainties,
      privacyRisk: obs.privacyRisk ?? null,
      reportableSignal: obs.reportableSignal ?? null,
    };
  }

  private fetchActiveProjects(): ProjectSummary[] {
    try {
      const projects = this.memoryObjectRepo.listProjects({
        status: "active",
        limit: 10,
      });
      return projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        summary: p.summary,
      }));
    } catch {
      return [];
    }
  }

  private fetchActiveTasks(): TaskSummary[] {
    try {
      const openTasks = this.memoryObjectRepo.listTasks({ status: "open", limit: 10 });
      const inProgressTasks = this.memoryObjectRepo.listTasks({
        status: "in_progress",
        limit: 10,
      });
      return [...openTasks, ...inProgressTasks].slice(0, 20).map((t) => ({
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

  private fetchUserFeedbackSummary(): string {
    if (!this.settingsService) return "";
    try {
      const recentFeedbackTypes = [
        "not_important",
        "wrong_content",
        "project_wrong",
        "task_done",
        "not_a_task",
        "do_not_record",
        "sensitive_content",
      ];
      const summaries: string[] = [];
      for (const fbType of recentFeedbackTypes) {
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

  private buildKnownAliasesBlock(): string {
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
    } catch {
      return "（无法加载已知别名）";
    }
  }
}
