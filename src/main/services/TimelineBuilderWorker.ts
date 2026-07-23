import type { ModelGateway } from "./ModelGateway";
import type { ModelJobQueue } from "./ModelJobQueue";
import type { Fact, Observation, Scene, TimelineBuilderInput, TimelineBuilderOutput } from "../models/types";
import type { TimelineBlock } from "../../shared/types";
import type { TimelineSourceCompleteness } from "../db/repositories/TimelineGenerationWindowRepository";
import { TimelineBuilderOutputSchema } from "../models/schemas";
import { TIMELINE_BUILDER_PROMPT_TEMPLATE } from "../models/prompts";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { TimelineBlockRepository } from "../db/repositories/TimelineBlockRepository";
import type { TimelineBuildCheckpointRepository } from "../db/repositories/TimelineBuildCheckpointRepository";
import type { SettingsService } from "./SettingsService";
import { getSystemTimezone, getSystemTimezoneOffset } from "../utils/timezone";

const MAX_OBSERVATIONS = 2_000;
const TIMELINE_MAX_TOKENS = 8_192;

export interface TimelineBuildWindowRequest {
  dateKey: string;
  collectionStart: string;
  collectionEnd: string;
  sourceCompleteness: TimelineSourceCompleteness;
  existingTimelineBlockId?: string | null;
}

export interface TimelineBuilderResult {
  ok: boolean;
  block?: TimelineBlock;
  /** Compatibility for existing callers while all IPC projections move to singular cards. */
  blocks: TimelineBlock[];
  dayStartSummary: string;
  dayMainThread: string;
  modelJobId?: string;
  attempts?: number;
  errorCode?: string;
  errorMessage?: string;
}

export class TimelineBuilderWorker {
  private readonly modelGateway: ModelGateway;
  private readonly modelJobQueue: ModelJobQueue;
  private readonly observationRepo: ObservationRepository;
  private readonly factRepo: FactRepository;
  private readonly sceneRepo: SceneRepository;
  private readonly timelineBlockRepo: TimelineBlockRepository;

  constructor(deps: {
    modelGateway: ModelGateway;
    modelJobQueue: ModelJobQueue;
    observationRepo: ObservationRepository;
    factRepo: FactRepository;
    sceneRepo: SceneRepository;
    timelineBlockRepo: TimelineBlockRepository;
    timelineBuildCheckpointRepo?: TimelineBuildCheckpointRepository;
    settingsService?: SettingsService;
  }) {
    this.modelGateway = deps.modelGateway;
    this.modelJobQueue = deps.modelJobQueue;
    this.observationRepo = deps.observationRepo;
    this.factRepo = deps.factRepo;
    this.sceneRepo = deps.sceneRepo;
    this.timelineBlockRepo = deps.timelineBlockRepo;
  }

  async buildWindow(request: TimelineBuildWindowRequest): Promise<TimelineBuilderResult> {
    const observations = this.observationRepo.listByCapturedAt({
      from: request.collectionStart,
      to: request.collectionEnd,
      limit: MAX_OBSERVATIONS,
      order: "asc",
    });
    if (observations.length === 0) {
      return failure("empty_window", "窗口内没有有效 Observation。");
    }

    const actualStart = observations[0].capturedAt;
    const actualEnd = observations[observations.length - 1].capturedAt;
    const observationIds = observations.map((value) => value.id);
    const scenes = this.sceneRepo.listByObservationIds(observationIds);
    const factsById = new Map([
      ...this.factRepo.listBySourceObservationIds(observationIds),
      ...this.factRepo.listBySourceEpisodeIds(scenes.map((value) => value.id)),
    ].map((fact) => [fact.id, fact]));
    const facts = [...factsById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const modelConfigId = await this.modelGateway.resolveConfigId("text");
    if (!modelConfigId) {
      return failure("no_language_model", "没有可用的语言模型服务，无法生成时间轴。");
    }

    const modelInput = {
      systemTimezone: getSystemTimezone(),
      systemTimezoneOffset: getSystemTimezoneOffset(),
      dateKey: request.dateKey,
      collectionStart: request.collectionStart,
      collectionEnd: request.collectionEnd,
      actualStart,
      actualEnd,
      observations: observations.map(toObservationSummary),
      facts: facts.map(toFactSummary),
      episodes: scenes.map(toSceneSummary),
    };
    const inputJson = JSON.stringify(modelInput);
    const userPrompt = TIMELINE_BUILDER_PROMPT_TEMPLATE.replace(
      "{{timeline_builder_input_json}}",
      inputJson
    );
    const dedupeKey = `timeline_builder:${request.dateKey}:${request.collectionStart}:${request.collectionEnd}`;
    const result = await this.modelJobQueue.enqueueMultimodalJob<TimelineBuilderOutput>({
      type: "timeline_builder",
      priority: 2,
      dedupeKey,
      rateLimitKey: modelConfigId,
      executor: async () => this.modelGateway.callByConfigId<TimelineBuilderOutput>({
        kind: "multimodal",
        configId: modelConfigId,
        systemPrompt: "",
        userPrompt,
        jobType: "timeline_builder",
        jobInputJson: JSON.stringify({
          dateKey: request.dateKey,
          collectionStart: request.collectionStart,
          collectionEnd: request.collectionEnd,
          actualStart,
          actualEnd,
          observationCount: observations.length,
          factCount: facts.length,
          episodeCount: scenes.length,
          sourceCompleteness: request.sourceCompleteness,
        }),
        maxTokens: TIMELINE_MAX_TOKENS,
        streaming: true,
      }, TimelineBuilderOutputSchema),
    });

    if (!result.ok || !result.data) {
      return failure(
        result.errorCode ?? "unknown_error",
        result.errorMessage ?? "时间轴模型调用失败。",
        result.modelJobId,
        result.attempts
      );
    }

    const projectIds = [...new Set([
      ...facts.flatMap((fact) => fact.projectId ? [fact.projectId] : []),
      ...scenes.flatMap((scene) => scene.projectId ? [scene.projectId] : []),
    ])];
    const output = result.data;
    const block: TimelineBlock = {
      id: request.existingTimelineBlockId ?? "",
      dateKey: request.dateKey,
      startAt: actualStart,
      endAt: actualEnd,
      title: output.title,
      summary: output.summary,
      category: output.category,
      projectIds,
      projectNames: output.projectNames,
      highlights: output.highlights,
      generatedTasks: output.generatedTasks,
      generatedDecisions: output.generatedDecisions,
      reportable: output.reportable,
      privateRisk: output.privateRisk,
      privateRiskReason: output.privateRiskReason,
      sourceSceneIds: scenes.map((value) => value.id),
      sourceFactIds: facts.map((value) => value.id),
      sourceObservationIds: observationIds,
      sourceCompleteness: request.sourceCompleteness,
      confidence: output.confidence,
    };

    try {
      const persisted = this.timelineBlockRepo.replaceWindowAndCheckpoint({
        dateKey: request.dateKey,
        windowStart: request.collectionStart,
        windowEnd: request.collectionEnd,
        blocks: [block],
        processedThrough: request.collectionEnd,
      }).find((value) => value.sourceObservationIds.some((id) => observationIds.includes(id)));
      if (!persisted) {
        return failure("timeline_data_error", "时间轴卡片未能持久化。", result.modelJobId, result.attempts);
      }
      return {
        ok: true,
        block: persisted,
        blocks: [persisted],
        dayStartSummary: "",
        dayMainThread: "",
        modelJobId: result.modelJobId,
        attempts: result.attempts,
      };
    } catch (error) {
      return failure(
        "timeline_data_error",
        `写入时间轴失败: ${errorMessage(error)}`,
        result.modelJobId,
        result.attempts
      );
    }
  }

  /** Legacy entrypoints cannot infer a collection window anymore. */
  async buildTimeline(_dateKey: string, _mode?: unknown): Promise<TimelineBuilderResult> {
    return failure("explicit_window_required", "时间轴必须由窗口协调器提交显式收集窗口。");
  }

  async reorganizeDay(_dateKey: string): Promise<TimelineBuilderResult> {
    return failure("explicit_window_required", "时间轴重建必须按持久化窗口执行。");
  }
}

function toObservationSummary(obs: Observation): TimelineBuilderInput["observations"][number] {
  return {
    id: obs.id,
    capturedAt: obs.capturedAt,
    appName: obs.appName,
    windowTitle: obs.windowTitle,
    sceneSummary: obs.sceneSummary,
    userFacingSummary: obs.userFacingSummary ?? undefined,
    likelyWorkPurpose: obs.likelyWorkPurpose ?? undefined,
    privacyRisk: obs.privacyRisk ?? undefined,
    reportableSignal: obs.reportableSignal ?? undefined,
  };
}

function toFactSummary(fact: Fact): TimelineBuilderInput["facts"][number] {
  return {
    id: fact.id,
    type: fact.type,
    content: fact.content,
    projectId: fact.projectId ?? undefined,
    projectHint: fact.projectHint ?? undefined,
    confidence: fact.confidence,
    importance: fact.importance,
    displayUse: fact.displayUse ?? undefined,
    reportable: fact.reportable ?? undefined,
    privateRisk: fact.privateRisk ?? undefined,
    sourceObservationIds: fact.sourceObservationIds,
  };
}

function toSceneSummary(scene: Scene): TimelineBuilderInput["scenes"][number] {
  return {
    id: scene.id,
    title: scene.title,
    summary: scene.summary,
    startAt: scene.startAt,
    endAt: scene.endAt,
    projectId: scene.projectId ?? undefined,
    factIds: scene.factIds,
    observationIds: scene.observationIds,
    entityNames: scene.entityNames,
    confidence: scene.confidence,
  };
}

function failure(
  errorCode: string,
  errorMessageValue: string,
  modelJobId?: string,
  attempts?: number
): TimelineBuilderResult {
  return {
    ok: false,
    blocks: [],
    dayStartSummary: "",
    dayMainThread: "",
    errorCode,
    errorMessage: errorMessageValue,
    modelJobId,
    attempts,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
