import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue, JobResult } from "./ModelJobQueue";
import type {
  DebugEvent,
  EpisodeActivityClassification,
  EpisodeFactExtractorOutput,
  Fact,
  Observation,
  Scene,
} from "../models/types";
import { EpisodeFactExtractorOutputSchema } from "../models/schemas";
import { EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE } from "../models/prompts";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
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

interface EpisodeExtractorInput {
  episodes: EpisodePayload[];
  activeKnownProjects: ProjectSummary[];
  activeTasks: TaskSummary[];
  userFeedbackSummary: string;
}

export const EPISODE_FACT_PROMPT_CHAR_BUDGET = 120_000;

export interface EpisodeFactExtractorResult {
  facts: Fact[];
  episodeActivities: EpisodeActivityClassification[];
  discardedNoise: EpisodeFactExtractorOutput["discardedNoise"];
  modelJobId: string;
  attempts: number;
}

export class EpisodeFactExtractorWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly factRepo: FactRepository;
  private readonly observationRepo: ObservationRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly memoryObjectRepo: MemoryObjectRepository;
  private readonly settingsService: SettingsService | null;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    factRepo: FactRepository;
    observationRepo: ObservationRepository;
    sceneRepo: SceneRepository;
    memoryObjectRepo: MemoryObjectRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.factRepo = deps.factRepo;
    this.observationRepo = deps.observationRepo;
    this.sceneRepo = deps.sceneRepo;
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
          episodeActivities: [],
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
    const knownAliasesBlock = this.buildKnownAliasesBlock();
    let promptBuild: EpisodeFactPromptBuildResult;
    try {
      promptBuild = buildEpisodeFactPrompt(extractorInput, knownAliasesBlock);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debugEvents?.push({
        layer: "L2",
        action: "skip",
        reason: "episode_fact_prompt_exceeds_local_budget",
      });
      return {
        ok: false,
        errorCode: "input_too_large",
        errorMessage,
        modelJobId: "",
        attempts: 0,
      };
    }
    const userPrompt = promptBuild.userPrompt;
    if (promptBuild.compactedFullTextCount > 0) {
      debugEvents?.push({
        layer: "L2",
        action: "downgrade",
        reason: "episode_fact_prompt_full_text_compacted",
      });
    }

    const jobInputJson = JSON.stringify({
      sceneIds: scenes.map((scene) => scene.id),
      observationCount: episodes.reduce(
        (sum, episode) => sum + episode.observations.length,
        0
      ),
      projectCount: extractorInput.activeKnownProjects.length,
      taskCount: extractorInput.activeTasks.length,
      promptChars: promptBuild.promptChars,
      originalInputChars: promptBuild.originalInputChars,
      compactedFullTextCount: promptBuild.compactedFullTextCount,
    });

    const result = await this.modelJobQueue.enqueueMultimodalJob<EpisodeFactExtractorOutput>({
      type: "episode_fact_extractor",
      priority: 2,
      executor: async () => {
        return this.modelGateway.callMultimodal<EpisodeFactExtractorOutput>(
          {
            kind: "multimodal",
            configId: multimodalModelConfigId,
            systemPrompt: "",
            userPrompt,
            jobType: "episode_fact_extractor",
            jobInputJson,
          },
          EpisodeFactExtractorOutputSchema
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

    const episodeActivities = this.persistEpisodeActivities(
      scenes,
      result.data.episodeActivities,
      debugEvents
    );
    const facts: Fact[] = [];
    for (const [index, factInput] of result.data.facts.entries()) {
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
          sourceEpisodeIds: scenes
            .filter((scene) => factInput.sourceObservationIds.some((id) => scene.observationIds.includes(id)))
            .map((scene) => scene.id),
          claimStatus: "active",
          generationPath: "episode_fact_extractor",
          generationVersion: 1,
          derivationKey: `atom:v1:${scenes.map((scene) => scene.id).sort().join(",")}:${index}`,
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
        episodeActivities,
        discardedNoise: result.data.discardedNoise,
        modelJobId: result.modelJobId ?? "",
        attempts: result.attempts ?? 0,
      },
      modelJobId: result.modelJobId ?? "",
      attempts: result.attempts ?? 0,
    };
  }

  private persistEpisodeActivities(
    scenes: Scene[],
    classifications: EpisodeActivityClassification[],
    debugEvents?: DebugEvent[]
  ): EpisodeActivityClassification[] {
    const scenesById = new Map(scenes.map((scene) => [scene.id, scene]));
    const persisted = new Map<string, EpisodeActivityClassification>();
    for (const classification of classifications) {
      if (!scenesById.has(classification.sceneId)) {
        debugEvents?.push({
          layer: "L1",
          action: "discard",
          reason: "episode_activity_unknown_scene",
          itemId: classification.sceneId,
        });
        continue;
      }
      try {
        this.sceneRepo.update(classification.sceneId, {
          activityCategory: classification.category,
          activityConfidence: classification.confidence,
        });
        persisted.set(classification.sceneId, classification);
      } catch {
        debugEvents?.push({
          layer: "L1",
          action: "discard",
          reason: "episode_activity_persist_failed",
          itemId: classification.sceneId,
        });
      }
    }

    for (const scene of scenes) {
      if (persisted.has(scene.id)) continue;
      debugEvents?.push({
        layer: "L1",
        action: "fallback",
        reason: "episode_activity_missing",
        itemId: scene.id,
      });
    }
    return [...persisted.values()];
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
      visibleContent: sanitizeVisibleContentForEpisodeFacts(obs.visibleContent),
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
        "content_wrong",
        "wrong_project",
        "task_done",
        "not_a_task",
        "do_not_record",
        "sensitive_delete",
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

interface EpisodeFactPromptBuildResult {
  userPrompt: string;
  promptChars: number;
  originalInputChars: number;
  compactedFullTextCount: number;
}

/**
 * OCR geometry is transient processing state and is never persisted. L2 only
 * needs the stored text and semantic fields to extract facts.
 */
export function sanitizeVisibleContentForEpisodeFacts(
  visibleContent: unknown[]
): Array<Record<string, unknown>> {
  return visibleContent.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return [{
      type: typeof record.type === "string" ? record.type : "unknown",
      summary: typeof record.summary === "string" ? record.summary : "",
      fullText: typeof record.fullText === "string" ? record.fullText : "",
      keyTextSnippets: Array.isArray(record.keyTextSnippets)
        ? record.keyTextSnippets.filter((value): value is string => typeof value === "string")
        : [],
    }];
  });
}

export function buildEpisodeFactPrompt(
  extractorInput: EpisodeExtractorInput,
  knownAliasesBlock: string,
  maxPromptChars = EPISODE_FACT_PROMPT_CHAR_BUDGET
): EpisodeFactPromptBuildResult {
  const workingInput = JSON.parse(JSON.stringify(extractorInput)) as EpisodeExtractorInput;
  const originalInputChars = JSON.stringify(workingInput).length;
  const fullTextRefs = collectFullTextRefs(workingInput);
  const render = () => EPISODE_FACT_EXTRACTOR_PROMPT_TEMPLATE.replace(
    "{{episode_extractor_input_json}}",
    JSON.stringify(workingInput, null, 2)
  ).replace("{{known_aliases_block}}", knownAliasesBlock);

  let userPrompt = render();
  if (userPrompt.length <= maxPromptChars) {
    return {
      userPrompt,
      promptChars: userPrompt.length,
      originalInputChars,
      compactedFullTextCount: 0,
    };
  }

  const originals = fullTextRefs.map(({ owner }) => String(owner.fullText ?? ""));
  let low = 0;
  let high = originals.reduce((max, text) => Math.max(max, text.length), 0);
  let bestPrompt: string | null = null;
  let bestCap = -1;

  while (low <= high) {
    const cap = Math.floor((low + high) / 2);
    for (let index = 0; index < fullTextRefs.length; index += 1) {
      fullTextRefs[index].owner.fullText = compactTextForModel(originals[index], cap);
    }
    const candidate = render();
    if (candidate.length <= maxPromptChars) {
      bestPrompt = candidate;
      bestCap = cap;
      low = cap + 1;
    } else {
      high = cap - 1;
    }
  }

  if (!bestPrompt) {
    for (const { owner } of fullTextRefs) {
      owner.fullText = "";
      owner.keyTextSnippets = [];
    }
    bestPrompt = render();
  } else {
    for (let index = 0; index < fullTextRefs.length; index += 1) {
      fullTextRefs[index].owner.fullText = compactTextForModel(originals[index], bestCap);
    }
  }

  if (bestPrompt.length > maxPromptChars) {
    throw new Error(
      `episode fact prompt ${bestPrompt.length} chars exceeds local budget ${maxPromptChars}`
    );
  }

  userPrompt = bestPrompt;
  return {
    userPrompt,
    promptChars: userPrompt.length,
    originalInputChars,
    compactedFullTextCount: originals.filter((text, index) =>
      String(fullTextRefs[index].owner.fullText ?? "") !== text
    ).length,
  };
}

function collectFullTextRefs(
  input: EpisodeExtractorInput
): Array<{ owner: Record<string, unknown> }> {
  const refs: Array<{ owner: Record<string, unknown> }> = [];
  for (const episode of input.episodes) {
    for (const observation of episode.observations) {
      const visibleContent = observation.visibleContent;
      if (!Array.isArray(visibleContent)) continue;
      for (const item of visibleContent) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          refs.push({ owner: item as Record<string, unknown> });
        }
      }
    }
  }
  return refs;
}

function compactTextForModel(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";
  const marker = `\n[本次模型输入省略 ${text.length - maxChars} 个字符；完整原文保留在本地 L0]\n`;
  if (marker.length >= maxChars) return text.slice(0, maxChars);
  const available = maxChars - marker.length;
  const prefixLength = Math.ceil(available * 0.7);
  const suffixLength = available - prefixLength;
  return `${text.slice(0, prefixLength)}${marker}${text.slice(text.length - suffixLength)}`;
}
