/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const rootDir = path.resolve(__dirname, "..");
const outputDir = path.join(rootDir, "scripts", "output");
const dbPath = path.join(outputDir, "smoke-memory-pipeline.db");

function requireDist(modulePath) {
  return require(path.join(rootDir, "dist", "main", modulePath));
}

const { ObservationRepository } = requireDist("db/repositories/ObservationRepository.js");
const { FactRepository } = requireDist("db/repositories/FactRepository.js");
const { SceneRepository } = requireDist("db/repositories/SceneRepository.js");
const { MemoryObjectRepository } = requireDist("db/repositories/MemoryObjectRepository.js");
const { ProactiveItemRepository } = requireDist("db/repositories/ProactiveItemRepository.js");
const { createMemoryEdgeRepository } = requireDist("db/repositories/MemoryEdgeRepository.js");
const { ObservationNormalizer } = requireDist("services/ObservationNormalizer.js");
const { MemoryPipeline } = requireDist("services/MemoryPipeline.js");
const { LinkerSceneJudgeWorker } = requireDist("services/LinkerSceneJudgeWorker.js");
const { LinkerSceneJudgeOutputSchema } = requireDist("models/schemas.js");

function resetSmokeDb() {
  fs.mkdirSync(outputDir, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = dbPath + suffix;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
}

function runMigrations(db) {
  const migrationsDir = path.join(rootDir, "src", "main", "db", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec(sql);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertLinkerSceneJudgeDefaults() {
  const parsed = LinkerSceneJudgeOutputSchema.safeParse({
    links: [],
    newObjects: [],
  });
  assert(parsed.success, `linker scene judge sparse output should parse: ${JSON.stringify(parsed.error?.issues)}`);
  assert(Array.isArray(parsed.data.linkedFacts), "linkedFacts default missing");
  assert(Array.isArray(parsed.data.newObjects), "newObjects default missing");
  assert(Array.isArray(parsed.data.mergedObjects), "mergedObjects default missing");
  assert(Array.isArray(parsed.data.scenes), "scenes default missing");
  assert(Array.isArray(parsed.data.unfinishedThreads), "unfinishedThreads default missing");
  assert(Array.isArray(parsed.data.proactiveItems), "proactiveItems default missing");
}

function makeObservation(index) {
  return {
    sceneSummary: `微信中讨论 Recall 记忆系统重构，第 ${index + 1} 帧。`,
    userFacingSummary: `正在微信里讨论 Recall 记忆系统重构的第 ${index + 1} 个瞬间。`,
    likelyWorkPurpose: "围绕 L0 到 L3 的记忆数据流做方案确认与任务拆解。",
    visibleContent: [
      {
        type: "chat",
        summary: "微信聊天围绕 Recall 记忆系统重构、批次观察、片段和事实沉淀展开。",
        fullText: "L0 只做识别\nN 帧形成片段\n事实继续沉淀到项目和人物",
        keyTextSnippets: ["L0 只做识别", "N 帧形成片段", "事实继续沉淀到项目和人物"],
      },
    ],
    detectedEntities: [
      { name: "Recall 记忆系统重构", type: "project", evidence: "聊天标题和内容反复出现", confidence: 0.92 },
      { name: "小陈", type: "person", evidence: "聊天中提到小陈负责验证", confidence: 0.81 },
    ],
    possibleUserIntent: "确认记忆系统重构的一层层数据流是否能稳定积累。",
    possibleTasks: [
      { text: "补一条端到端 smoke 验证", confidence: 0.88, evidence: "聊天中讨论验证 L0-L3 数据链路" },
    ],
    possibleDecisions: [
      { text: "先以 6 帧批次作为 L0 默认提交单位", confidence: 0.84, evidence: "讨论中确认一次提交 6 帧" },
    ],
    possibleProjectProgress: [
      { text: "记忆系统重构进入端到端验证阶段", projectHint: "Recall 记忆系统重构", confidence: 0.9, evidence: "围绕重构验收展开" },
    ],
    privacyRisk: "low",
    privacyRiskReason: "smoke 测试数据为合成内容",
    reportableSignal: "yes",
    reportableReason: "包含明确项目进展和后续验证任务",
    sensitivity: "normal",
    confidence: 0.9,
    uncertainties: [],
  };
}

function makeFrame(index, capturedAt) {
  return {
    captureId: `smoke_capture_${index + 1}`,
    capturedAt,
    timezone: "Asia/Shanghai",
    appName: "微信",
    windowTitle: "Recall 记忆系统重构讨论",
    urlOrDomain: null,
    captureReason: index === 0 ? "window_focus_changed" : "content_changed",
    activitySignals: {
      keyboardActive: true,
      mouseActive: false,
      idleSeconds: 0,
      activeWindowStableSeconds: 60 + index * 30,
    },
    imagePaths: [`smoke-frame-${index + 1}.jpg`],
    retentionPolicy: "today",
  };
}

class StaticBatchObserver {
  async runObservationsForBatch() {
    return {
      ok: true,
      data: {
        observations: Array.from({ length: 6 }, (_, index) => makeObservation(index)),
      },
      modelJobId: "job_observer_smoke",
      attempts: 1,
    };
  }

  async run() {
    throw new Error("single-frame observer should not run in smoke test");
  }
}

class StaticEpisodeFactExtractor {
  constructor(factRepo) {
    this.factRepo = factRepo;
  }

  async run(input) {
    const scene = input.scenes[0];
    const observationIds = scene.observationIds;
    const mk = (patch) => this.factRepo.create({
      status: null,
      projectId: null,
      projectHint: null,
      importance: 0.8,
      confidence: 0.88,
      inferred: false,
      evidenceText: "smoke evidence",
      sourceObservationIds: observationIds.slice(0, 2),
      tags: ["smoke", "memory-pipeline"],
      displayUse: ["timeline", "memory", "work_report"],
      reportable: true,
      privateRisk: "low",
      userValue: "high",
      peopleHints: [],
      ...patch,
    });

    const facts = [
      mk({
        type: "project_progress",
        content: "Recall 记忆系统重构进入 L0 到 L3 端到端验证阶段。",
        projectHint: "Recall 记忆系统重构",
        sourceObservationIds: observationIds,
      }),
      mk({
        type: "task",
        content: "需要补一条可重复执行的记忆管线 smoke 验证。",
        status: "open",
        projectHint: "Recall 记忆系统重构",
        sourceObservationIds: observationIds.slice(1, 4),
      }),
      mk({
        type: "person",
        content: "小陈参与 Recall 记忆系统重构验证讨论。",
        peopleHints: ["小陈"],
        sourceObservationIds: observationIds.slice(2, 5),
      }),
      mk({
        type: "decision",
        content: "默认按 6 帧批次提交 L0 观察，再从片段抽取事实。",
        status: "done",
        projectHint: "Recall 记忆系统重构",
        sourceObservationIds: observationIds.slice(0, 6),
      }),
    ];

    return {
      ok: true,
      data: {
        facts,
        discardedNoise: [],
        modelJobId: "job_episode_fact_smoke",
        attempts: 1,
      },
      modelJobId: "job_episode_fact_smoke",
      attempts: 1,
    };
  }
}

class StaticModelJobQueue {
  constructor(getFacts) {
    this.getFacts = getFacts;
  }

  async enqueueMultimodalJob(input) {
    if (input.type !== "linker_scene_judge") {
      throw new Error(`unexpected model job type: ${input.type}`);
    }
    const facts = this.getFacts();
    const factIds = facts.map((fact) => fact.id);
    return {
      ok: true,
      data: {
        linkedFacts: [],
        newObjects: [
          {
            objectType: "project",
            title: "Recall 记忆系统重构",
            summary: "围绕 L0 到 L3 分层记忆、事实沉淀和前台呈现进行的重构。",
            sourceFactIds: factIds,
            confidence: 0.95,
          },
          {
            objectType: "task",
            title: "补记忆管线 smoke 验证",
            summary: "验证批次观察可以继续形成片段、事实、对象和关系边。",
            sourceFactIds: [facts[1].id],
            confidence: 0.9,
          },
          {
            objectType: "person",
            title: "小陈",
            summary: "参与 Recall 记忆系统重构验证讨论的人物。",
            sourceFactIds: [facts[2].id],
            confidence: 0.82,
          },
          {
            objectType: "decision",
            title: "L0 默认 6 帧批次",
            summary: "L0 默认按 6 帧批次提交，只做观察识别，再由片段抽取事实。",
            sourceFactIds: [facts[3].id],
            confidence: 0.88,
          },
        ],
        mergedObjects: [],
        scenes: [],
        unfinishedThreads: [],
        proactiveItems: [],
      },
      modelJobId: "job_linker_smoke",
      attempts: 1,
    };
  }
}

async function main() {
  assertLinkerSceneJudgeDefaults();
  resetSmokeDb();
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const observationRepo = new ObservationRepository(db);
    const factRepo = new FactRepository(db);
    const sceneRepo = new SceneRepository(db);
    const memoryObjectRepo = new MemoryObjectRepository(db);
    const proactiveItemRepo = new ProactiveItemRepository(db);
    const edgeRepo = createMemoryEdgeRepository(db);
    const normalizer = new ObservationNormalizer({ observationRepo });
    let latestFacts = [];

    const linkerWorker = new LinkerSceneJudgeWorker({
      modelGateway: {},
      modelJobQueue: new StaticModelJobQueue(() => latestFacts),
      factRepo,
      sceneRepo,
      memoryObjectRepo,
      proactiveItemRepo,
      edgeRepo,
      settingsService: {
        getAll: () => ({
          notification: { inAppReminders: true, desktopNotifications: false },
          dailyReport: { autoGenerate: false },
        }),
        listUserFeedbackByType: () => [],
      },
    });

    const episodeFactExtractorWorker = new StaticEpisodeFactExtractor(factRepo);
    const originalRun = episodeFactExtractorWorker.run.bind(episodeFactExtractorWorker);
    episodeFactExtractorWorker.run = async (input) => {
      const result = await originalRun(input);
      latestFacts = result.data.facts;
      return result;
    };

    const pipeline = new MemoryPipeline({
      observerExtractorWorker: new StaticBatchObserver(),
      normalizer,
      linkerSceneJudgeWorker: linkerWorker,
      episodeFactExtractorWorker,
      modelJobQueue: {},
      sceneRepo,
      factRepo,
      memoryObjectRepo,
      edgeRepo,
      settingsService: {
        isDebugMode: () => false,
        getActiveMultimodalModelConfigId: () => "smoke_multimodal_config",
      },
      config: { enableSceneBuilder: true },
    });

    const start = Date.parse("2026-07-09T10:00:00.000Z");
    const frames = Array.from({ length: 6 }, (_, index) =>
      makeFrame(index, new Date(start + index * 60_000).toISOString())
    );
    const result = await pipeline.processBatchCaptureBundle({
      batchId: "smoke_batch_memory_pipeline",
      frames,
      capturedAtStart: frames[0].capturedAt,
      capturedAtEnd: frames[frames.length - 1].capturedAt,
      timezone: "Asia/Shanghai",
      appName: "微信",
      windowTitle: "Recall 记忆系统重构讨论",
      captureReason: "batch_flush",
      imagePaths: frames.flatMap((frame) => frame.imagePaths),
      compressedImagePaths: [],
      retentionPolicy: "today",
    });

    assert(result.errors.length === 0, `pipeline errors: ${JSON.stringify(result.errors)}`);
    assert(result.steps.observerExtractor === true, "batch observer did not complete");
    assert(result.steps.normalizer.ok === 6, `expected 6 observations, got ${result.steps.normalizer.ok}`);
    assert(result.steps.factsWrite.written === 4, `expected 4 facts, got ${result.steps.factsWrite.written}`);
    assert(result.steps.linkerSceneJudge === true, "linker scene judge did not complete");

    const observations = observationRepo.listByCapturedAt({ limit: 20 });
    const scenes = sceneRepo.listByStartAt({ limit: 20 });
    const facts = factRepo.list({ limit: 20 });
    const projects = memoryObjectRepo.listProjects({ limit: 20 });
    const tasks = memoryObjectRepo.listTasks({ limit: 20 });
    const people = memoryObjectRepo.listPeople({ limit: 20 });
    const decisions = memoryObjectRepo.listDecisions({ limit: 20 });
    const edges = edgeRepo.list({ limit: 1000 });

    assert(observations.length === 6, `expected 6 observations in db, got ${observations.length}`);
    assert(scenes.length === 1, `expected 1 episode scene, got ${scenes.length}`);
    assert(facts.length === 4, `expected 4 facts in db, got ${facts.length}`);
    assert(projects.length === 1, `expected 1 project, got ${projects.length}`);
    assert(tasks.length === 1, `expected 1 task, got ${tasks.length}`);
    assert(people.length === 1, `expected 1 person, got ${people.length}`);
    assert(decisions.length === 1, `expected 1 decision, got ${decisions.length}`);

    const scene = scenes[0];
    const project = projects[0];
    const task = tasks[0];
    const person = people[0];
    const decision = decisions[0];
    const sceneAfterProjection = sceneRepo.getById(scene.id);

    assert(sceneAfterProjection.factIds.length === 4, "scene did not keep all linked facts");
    assert(sceneAfterProjection.observationIds.length === 6, "scene did not keep all source observations");
    assert(sceneAfterProjection.projectId === project.id, "scene projectId was not projected");
    assert(sceneAfterProjection.taskIds.includes(task.id), "scene taskIds missing linked task");
    assert(sceneAfterProjection.decisionIds.includes(decision.id), "scene decisionIds missing linked decision");
    assert(project.sourceSceneIds.includes(scene.id), "project sourceSceneIds missing episode scene");
    assert(task.projectId === project.id, "task projectId was not inferred from project facts");
    assert(decision.projectId === project.id, "decision projectId was not inferred from project facts");
    assert(person.relatedProjectIds.includes(project.id), "person relatedProjectIds missing project");
    assert(facts.every((fact) => fact.projectId === project.id), "not all facts were backfilled with projectId");

    const countEdges = (fromType, toType, relationType) =>
      edges.filter((edge) => edge.fromType === fromType && edge.toType === toType && edge.relationType === relationType).length;

    assert(countEdges("scene", "observation", "contains") === 6, "scene->observation edges incomplete");
    assert(countEdges("scene", "fact", "contains") === 4, "scene->fact edges incomplete");
    assert(countEdges("fact", "project", "belongs_to") === 4, "fact->project edges incomplete");
    assert(countEdges("fact", "task", "supports") === 1, "fact->task edge missing");
    assert(countEdges("fact", "person", "mentions") === 1, "fact->person edge missing");
    assert(countEdges("fact", "decision", "supports") === 1, "fact->decision edge missing");
    assert(countEdges("scene", "project", "belongs_to") === 1, "scene->project edge missing");
    assert(countEdges("scene", "task", "contains") === 1, "scene->task edge missing");
    assert(countEdges("scene", "person", "involves") === 1, "scene->person edge missing");
    assert(countEdges("scene", "decision", "contains") === 1, "scene->decision edge missing");

    console.log(JSON.stringify({
      ok: true,
      batchId: result.batchId,
      observations: observations.length,
      episodes: scenes.length,
      facts: facts.length,
      projects: projects.length,
      tasks: tasks.length,
      people: people.length,
      decisions: decisions.length,
      edges: edges.length,
      dbPath,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
