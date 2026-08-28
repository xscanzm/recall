// src/main/services/MemoryPipeline.ocrFallback.test.ts
// 视觉链路 OCR 降级保底（Task 4）：MemoryPipeline 步骤 1 分支接线的行为测试
//
// 场景（计划 Task 4 Step 1 的 A-E）：
// A. 默认服务 + 熔断器 open → 不调用视觉 worker，OCR 产物落库，EpisodeBuilder 规则产物照常
// B. 默认服务 + closed → 视觉失败（rate_limited）→ 同批立即降级 + 熔断器转开 + 记录视觉原始错误
// C. 默认服务 + 视觉成功 → generationPath = vision_model:v1，不降级
// D. 默认服务 + 视觉 rate_limited + OCR 全空/缺失 → 维持原失败路径，熔断器已计数
// E. 用户自配服务 + 视觉 rate_limited → 永远原链路，熔断器完全不参与
//
// fixture 策略：
// - normalizer 用真实的 ObservationNormalizer + mock 的 ObservationRepository（捕获 create 调用），
//   保证 generationPath 透传链路被真实覆盖
// - EpisodeBuilder / SceneRelationProjector 不 mock（纯规则），配内存版 sceneRepo/factRepo
// - 视觉/文本 worker、modelJobQueue 用 vi.fn() 打桩的普通对象

import { describe, expect, it, vi } from "vitest";
import { MemoryPipeline } from "./MemoryPipeline";
import { ObservationNormalizer } from "./ObservationNormalizer";
import { VisionHealthTracker } from "./VisionHealthTracker";
import {
  OCR_FALLBACK_GENERATION_PATH,
  VISION_MODEL_GENERATION_PATH,
} from "./OcrObservationBuilder";
import type {
  BatchCaptureBundle,
  BatchFrameOcrResult,
  CaptureBundle,
  Observation,
  ObserverOutputV2,
  Scene,
} from "../models/types";
import type { ObserverExtractorWorker } from "./ObserverExtractorWorker";
import type { LinkerSceneJudgeWorker } from "./LinkerSceneJudgeWorker";
import type { EpisodeFactExtractorWorker } from "./EpisodeFactExtractorWorker";
import type { ModelJobQueue } from "./ModelJobQueue";
import type { SceneRepository } from "../db/repositories/SceneRepository";
import type { FactRepository } from "../db/repositories/FactRepository";
import type { MemoryObjectRepository } from "../db/repositories/MemoryObjectRepository";
import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { SettingsService } from "./SettingsService";

const DEFAULT_VISION_CONFIG_ID = "recall-default-multimodal";
const USER_VISION_CONFIG_ID = "user-openai-vision-1";
const TEXT_CONFIG_ID = "recall-default-language";

// ---------------------------------------------------------------- fixture

function frame(index: number, overrides: Partial<CaptureBundle> = {}): CaptureBundle {
  const minute = String(index).padStart(2, "0");
  return {
    captureId: `cap_${index}`,
    capturedAt: `2026-08-28T10:${minute}:00.000Z`,
    timezone: "Asia/Shanghai",
    appName: "Google Chrome",
    windowTitle: "回声Recall 文档",
    captureReason: "content_changed",
    activitySignals: {
      keyboardActive: false,
      mouseActive: false,
      idleSeconds: 0,
      activeWindowStableSeconds: 0,
    },
    imagePaths: [],
    retentionPolicy: "today",
    ...overrides,
  };
}

function makeOcrResults(texts: string[]): BatchFrameOcrResult[] {
  return texts.map((text, i) => ({
    frameIndex: i + 1,
    text,
    lines: text.trim() ? text.split("\n") : [],
    engine: "rapidocr",
    mode: "full" as const,
  }));
}

function makeBatchBundle(overrides: Partial<BatchCaptureBundle> = {}): BatchCaptureBundle {
  return {
    batchId: "batch_test",
    frames: [frame(1), frame(2), frame(3)],
    compressedImagePaths: ["a.png", "b.png", "c.png"],
    capturedAtStart: "2026-08-28T10:00:00.000Z",
    capturedAtEnd: "2026-08-28T10:02:00.000Z",
    timezone: "Asia/Shanghai",
    appName: "Google Chrome",
    windowTitle: "回声Recall 文档",
    captureReason: "batch_flush",
    imagePaths: [],
    retentionPolicy: "today",
    ocrResults: makeOcrResults(["第一帧的屏幕文字", "第二帧的屏幕文字", "第三帧的屏幕文字"]),
    ...overrides,
  };
}

function visionObservation(index: number): ObserverOutputV2 {
  return {
    frameIndex: index,
    sceneSummary: `视觉场景摘要 ${index}`,
    userFacingSummary: "视觉摘要",
    likelyWorkPurpose: "写文档",
    visibleContent: [
      { type: "document", summary: "视觉摘要", fullText: "视觉全文", keyTextSnippets: [] },
    ],
    detectedEntities: [],
    possibleUserIntent: "",
    possibleTasks: [],
    possibleDecisions: [],
    possibleProjectProgress: [],
    privacyRisk: "low",
    privacyRiskReason: "",
    reportableSignal: "yes",
    reportableReason: "",
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties: [],
  };
}

// ---------------------------------------------------------------- stubs

function makeObservationRepo() {
  const created: Observation[] = [];
  let seq = 0;
  const repo = {
    create: vi.fn((input: Record<string, unknown>) => {
      seq += 1;
      const observation = {
        ...input,
        id: `obs_${seq}`,
        createdAt: "2026-08-28T10:05:00.000Z",
      } as Observation;
      created.push(observation);
      return observation;
    }),
    getById: vi.fn((id: string) => created.find((o) => o.id === id) ?? null),
  };
  return { repo: repo as unknown as ObservationRepository, created, raw: repo };
}

function makeSceneRepo() {
  const scenes: Scene[] = [];
  let seq = 0;
  const repo = {
    create: vi.fn((input: Record<string, unknown>) => {
      seq += 1;
      const scene = {
        ...input,
        id: `scene_${seq}`,
        createdAt: "2026-08-28T10:05:00.000Z",
        updatedAt: "2026-08-28T10:05:00.000Z",
        deletedAt: null,
      } as Scene;
      scenes.push(scene);
      return scene;
    }),
    listByIds: vi.fn((ids: string[]) => scenes.filter((s) => ids.includes(s.id))),
    getByIdActive: vi.fn((id: string) =>
      scenes.find((s) => s.id === id && !s.deletedAt) ?? null),
    update: vi.fn((id: string, patch: Record<string, unknown>) => {
      const scene = scenes.find((s) => s.id === id);
      if (scene) Object.assign(scene, patch);
      return scene ?? null;
    }),
  };
  return { repo: repo as unknown as SceneRepository, scenes };
}

function makeFactRepo() {
  const repo = {
    listByIds: vi.fn(() => []),
    listBySourceEpisodeIds: vi.fn(() => []),
    update: vi.fn(() => null),
  };
  return repo as unknown as FactRepository;
}

function makeMemoryObjectRepo() {
  const repo = {
    listProjects: vi.fn(() => []),
    listTasks: vi.fn(() => []),
    listDecisions: vi.fn(() => []),
    listPeople: vi.fn(() => []),
  };
  return repo as unknown as MemoryObjectRepository;
}

function makeModelJobQueue() {
  return {} as unknown as ModelJobQueue;
}

interface PipelineHandles {
  pipeline: MemoryPipeline;
  tracker: VisionHealthTracker;
  observerRun: ReturnType<typeof vi.fn>;
  factExtractorRun: ReturnType<typeof vi.fn>;
  linkerRun: ReturnType<typeof vi.fn>;
  observationRepo: ReturnType<typeof makeObservationRepo>;
  sceneRepo: ReturnType<typeof makeSceneRepo>;
}

function buildPipeline(opts: {
  visionConfigId: string;
  observerBehavior: "success" | "rate_limited";
  withTracker?: boolean;
}): PipelineHandles {
  const tracker = new VisionHealthTracker();
  const observationRepo = makeObservationRepo();
  const sceneRepo = makeSceneRepo();

  const normalizer = new ObservationNormalizer({
    observationRepo: observationRepo.repo,
  });

  const observerRun = vi.fn(async () => {
    if (opts.observerBehavior === "rate_limited") {
      return {
        ok: false as const,
        errorCode: "rate_limited",
        errorMessage: "Server is busy",
      };
    }
    return {
      ok: true as const,
      data: {
        observations: [visionObservation(1), visionObservation(2), visionObservation(3)],
        modelJobId: "mj_vision",
        attempts: 1,
      },
    };
  });
  const observerExtractorWorker = {
    runObservationsForBatch: observerRun,
  } as unknown as ObserverExtractorWorker;

  const factExtractorRun = vi.fn(async () => ({
    ok: true as const,
    data: {
      facts: [],
      episodeActivities: [],
      discardedNoise: [],
      modelJobId: "mj_atom",
      attempts: 1,
    },
  }));
  const episodeFactExtractorWorker = {
    run: factExtractorRun,
  } as unknown as EpisodeFactExtractorWorker;

  const linkerRun = vi.fn(async () => ({
    linkedFacts: [],
    newObjects: [],
    mergedObjects: [],
    scenes: [],
    proactiveItems: [],
    unfinishedThreads: [],
    modelJobId: "mj_linker",
    attempts: 1,
  }));
  const linkerSceneJudgeWorker = {
    run: linkerRun,
  } as unknown as LinkerSceneJudgeWorker;

  const settingsService = {
    isDebugMode: vi.fn(() => false),
    resolveModelConfigId: vi.fn(async (taskKind: string) =>
      taskKind === "vision" ? opts.visionConfigId : TEXT_CONFIG_ID),
    isModelConfigUsable: vi.fn(async () => false),
  } as unknown as SettingsService;

  const pipeline = new MemoryPipeline({
    observerExtractorWorker,
    normalizer,
    linkerSceneJudgeWorker,
    episodeFactExtractorWorker,
    modelJobQueue: makeModelJobQueue(),
    sceneRepo: sceneRepo.repo,
    factRepo: makeFactRepo(),
    memoryObjectRepo: makeMemoryObjectRepo(),
    observationRepo: observationRepo.repo,
    settingsService,
    visionHealth: opts.withTracker === false ? null : tracker,
  });

  return {
    pipeline,
    tracker,
    observerRun,
    factExtractorRun,
    linkerRun,
    observationRepo,
    sceneRepo,
  };
}

// ---------------------------------------------------------------- tests

describe("MemoryPipeline OCR fallback（视觉链路降级保底）", () => {
  it("场景 A：默认服务 + 熔断器 open → 不调用视觉 worker，OCR 产物落库且带 ocr_fallback 溯源", async () => {
    const handles = buildPipeline({
      visionConfigId: DEFAULT_VISION_CONFIG_ID,
      observerBehavior: "rate_limited", // 即使桩会失败也无所谓：断言它完全没被调用
    });
    handles.tracker.recordFailure(); // 熔断器 open
    expect(handles.tracker.nextAction()).toBe("ocr");

    const result = await handles.pipeline.processBatchCaptureBundle(makeBatchBundle());

    // 视觉 worker 不被调用
    expect(handles.observerRun).not.toHaveBeenCalled();
    // 降级标记
    expect(result.degradedToOcr).toBe(true);
    // OCR 产物逐帧落库
    expect(result.written.observationIds).toHaveLength(3);
    expect(result.written.observationIds.every((id) => id !== null)).toBe(true);
    // generationPath 溯源：ocr_fallback:v1
    expect(handles.observationRepo.raw.create).toHaveBeenCalledTimes(3);
    for (const call of handles.observationRepo.raw.create.mock.calls) {
      expect(call[0].generationPath).toBe(OCR_FALLBACK_GENERATION_PATH);
    }
    expect(handles.observationRepo.created[0].visibleContent?.[0])
      .toMatchObject({ fullText: "第一帧的屏幕文字" });
    // EpisodeBuilder 规则产物照常
    expect(result.written.sceneIds.length).toBeGreaterThanOrEqual(1);
    expect(result.steps.episodes).toBe(true);
    expect(result.steps.atoms).toBe(true);
    expect(result.steps.linkerSceneJudge).toBe(true);
    expect(result.steps.observerExtractor).toBe(true);
  });

  it("场景 B：默认服务 + closed → 视觉 rate_limited → 同批立即降级 + 熔断器转开 + 记录视觉错误", async () => {
    const handles = buildPipeline({
      visionConfigId: DEFAULT_VISION_CONFIG_ID,
      observerBehavior: "rate_limited",
    });
    expect(handles.tracker.nextAction()).toBe("vision");

    const result = await handles.pipeline.processBatchCaptureBundle(makeBatchBundle());

    // 同批立即降级
    expect(result.degradedToOcr).toBe(true);
    expect(handles.observerRun).toHaveBeenCalledTimes(1);
    // 本批 observations 来自 OCR（fullText 为 OCR 全文而非视觉输出）
    expect(handles.observationRepo.created[0].visibleContent?.[0])
      .toMatchObject({ fullText: "第一帧的屏幕文字" });
    for (const call of handles.observationRepo.raw.create.mock.calls) {
      expect(call[0].generationPath).toBe(OCR_FALLBACK_GENERATION_PATH);
    }
    // 熔断器转开：第二次 nextAction() 返回 ocr
    expect(handles.tracker.nextAction()).toBe("ocr");
    expect(handles.tracker.getConsecutiveFailures()).toBe(1);
    // result.errors 含视觉原始错误码
    const visionError = result.errors.find((e) => e.code === "rate_limited");
    expect(visionError).toBeDefined();
    expect(visionError?.step).toBe("observerExtractor");
    // 降级批次整体仍算成功（步骤全绿，下游 facts/episode 照常）
    expect(result.steps.observerExtractor).toBe(true);
    expect(result.steps.episodes).toBe(true);
  });

  it("场景 C：默认服务 + 视觉成功 → generationPath=vision_model:v1，不降级", async () => {
    const handles = buildPipeline({
      visionConfigId: DEFAULT_VISION_CONFIG_ID,
      observerBehavior: "success",
    });

    const result = await handles.pipeline.processBatchCaptureBundle(makeBatchBundle());

    expect(handles.observerRun).toHaveBeenCalledTimes(1);
    expect(result.degradedToOcr).toBe(false);
    expect(result.steps.observerExtractor).toBe(true);
    for (const call of handles.observationRepo.raw.create.mock.calls) {
      expect(call[0].generationPath).toBe(VISION_MODEL_GENERATION_PATH);
    }
    expect(handles.observationRepo.created[0].visibleContent?.[0])
      .toMatchObject({ fullText: "视觉全文" });
    // 成功后熔断器保持 closed
    expect(handles.tracker.nextAction()).toBe("vision");
  });

  it("场景 D：默认服务 + 视觉 rate_limited + OCR 全空白 → 不降级，走原失败路径，熔断器已计数", async () => {
    const handles = buildPipeline({
      visionConfigId: DEFAULT_VISION_CONFIG_ID,
      observerBehavior: "rate_limited",
    });
    const bundle = makeBatchBundle({
      ocrResults: makeOcrResults(["   ", "", "  \t "]), // 全空白：trim 后不可用
    });

    const result = await handles.pipeline.processBatchCaptureBundle(bundle);

    expect(result.degradedToOcr).toBe(false);
    expect(result.steps.observerExtractor).toBe(false);
    expect(result.steps.episodes).toBe(false);
    const visionError = result.errors.find((e) => e.code === "rate_limited");
    expect(visionError).toBeDefined();
    // 未落库任何 observation
    expect(handles.observationRepo.raw.create).not.toHaveBeenCalled();
    // 熔断器已计数（容量类故障）
    expect(handles.tracker.getConsecutiveFailures()).toBe(1);
    expect(handles.tracker.nextAction()).toBe("ocr");
  });

  it("场景 D2：默认服务 + 视觉 rate_limited + ocrResults 缺失 → 同样维持原失败路径", async () => {
    const handles = buildPipeline({
      visionConfigId: DEFAULT_VISION_CONFIG_ID,
      observerBehavior: "rate_limited",
    });
    const bundle = makeBatchBundle();
    delete (bundle as Partial<BatchCaptureBundle>).ocrResults;

    const result = await handles.pipeline.processBatchCaptureBundle(bundle);

    expect(result.degradedToOcr).toBe(false);
    expect(result.steps.observerExtractor).toBe(false);
    const visionError = result.errors.find((e) => e.code === "rate_limited");
    expect(visionError).toBeDefined();
    expect(handles.tracker.getConsecutiveFailures()).toBe(1);
  });

  it("场景 E：用户自配服务 + 视觉 rate_limited → 不降级、熔断器完全不参与", async () => {
    const handles = buildPipeline({
      visionConfigId: USER_VISION_CONFIG_ID,
      observerBehavior: "rate_limited",
    });

    const result = await handles.pipeline.processBatchCaptureBundle(makeBatchBundle());

    // 走原失败路径
    expect(result.degradedToOcr).toBe(false);
    expect(result.steps.observerExtractor).toBe(false);
    const visionError = result.errors.find((e) => e.code === "rate_limited");
    expect(visionError).toBeDefined();
    expect(handles.observationRepo.raw.create).not.toHaveBeenCalled();
    // 熔断器不计数：nextAction() 仍是 vision
    expect(handles.tracker.nextAction()).toBe("vision");
    expect(handles.tracker.getConsecutiveFailures()).toBe(0);
    // 视觉 worker 仍以用户配置 id 被调用
    expect(handles.observerRun).toHaveBeenCalledTimes(1);
    expect(handles.observerRun.mock.calls[0][0].multimodalModelConfigId).toBe(USER_VISION_CONFIG_ID);
  });
});
