const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { CaptureInboxRepository } = require("../dist/main/db/repositories/CaptureInboxRepository");
const { DataLifecycleService } = require("../dist/main/services/DataLifecycleService");
const { FactRepository } = require("../dist/main/db/repositories/FactRepository");
const { MemorySearchRepository } = require("../dist/main/db/repositories/MemorySearchRepository");
const { ObservationRepository } = require("../dist/main/db/repositories/ObservationRepository");
const { SceneRepository } = require("../dist/main/db/repositories/SceneRepository");
const { MemoryEdgeRepository } = require("../dist/main/db/repositories/MemoryEdgeRepository");
const { CorrectionLifecycleRepository } = require("../dist/main/db/repositories/CorrectionLifecycleRepository");
const { TimelineBlockRepository } = require("../dist/main/db/repositories/TimelineBlockRepository");
const { TimelineGenerationWindowRepository } = require("../dist/main/db/repositories/TimelineGenerationWindowRepository");
const { MemoryObjectRepository } = require("../dist/main/db/repositories/MemoryObjectRepository");
const { ModelJobRepository } = require("../dist/main/db/repositories/ModelJobRepository");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-sqlite-"));
const migrationsDir = path.join(__dirname, "..", "src", "main", "db", "migrations");

function migrations() {
  return fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
}

function migrate(db, files = migrations()) {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, executed_at TEXT NOT NULL)");
  const applied = new Set(db.prepare("SELECT version FROM _migrations").all().map((row) => row.version));
  for (const name of files) {
    if (applied.has(name)) continue;
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(migrationsDir, name), "utf8"));
      db.prepare("INSERT INTO _migrations VALUES (?, ?)").run(name, new Date().toISOString());
    })();
  }
}

function capture(id, imagePath = "", capturedAt = "2026-07-11T10:00:00.000Z") {
  return {
    captureId: id, capturedAt, timezone: "UTC", appName: "Editor",
    windowTitle: "Recall", captureReason: "manual_capture", activitySignals: {
      keyboardActive: true, mouseActive: false, idleSeconds: 0, activeWindowStableSeconds: 30,
    }, imagePaths: imagePath ? [imagePath] : [], retentionPolicy: "today",
  };
}

function batch(id, frames) {
  return {
    batchId: id, frames, capturedAtStart: frames[0].capturedAt,
    capturedAtEnd: frames.at(-1).capturedAt, timezone: "UTC", appName: "Editor",
    windowTitle: "Recall", captureReason: "batch_flush", imagePaths: [],
    compressedImagePaths: [], retentionPolicy: "today",
  };
}

function insertObservation(db, id, captureId, capturedAt, screenshotPaths = []) {
  db.prepare(`INSERT INTO observations
    (id,capture_id,captured_at,app_name,window_title,capture_reason,scene_summary,visible_content_json,
     detected_entities_json,possible_tasks_json,possible_decisions_json,sensitivity,confidence,
     uncertainties_json,screenshot_retention,screenshot_paths_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, captureId, capturedAt, "Editor", "Recall", "manual_capture", "summary", "[]", "[]", "[]", "[]",
      "normal", 1, "[]", "today", JSON.stringify(screenshotPaths), capturedAt
    );
}

function timelineBlock(id, sourceObservationIds, sourceSceneIds = []) {
  return {
    id, dateKey: "2026-07-11", startAt: "2026-07-11T10:00:00.000Z", endAt: "2026-07-11T10:05:00.000Z",
    title: id, summary: id, category: "coding", projectIds: [], projectNames: [], highlights: [],
    generatedTasks: [], generatedDecisions: [], reportable: true, privateRisk: "low",
    sourceSceneIds, sourceFactIds: [], sourceObservationIds,
  };
}

async function main() {
  const dbPath = path.join(root, "integration.db");
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  try {
    migrate(db);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM _migrations").get().count, migrations().length);

    const modelJobs = new ModelJobRepository(db);
    const succeededJob = modelJobs.create({ id: "model-job-succeeded", type: "integration", inputJson: "{}" });
    modelJobs.markRunning(succeededJob.id);
    modelJobs.markSucceeded(
      succeededJob.id,
      JSON.stringify({ result: "ok" }),
      2,
      undefined,
      undefined,
      {
        promptTokens: 120,
        completionTokens: 45,
        cachedPromptTokens: 80,
        requestCount: 3,
        latencyMs: 950,
      },
    );
    assert.deepEqual(
      {
        status: modelJobs.getById(succeededJob.id).status,
        promptTokens: modelJobs.getById(succeededJob.id).promptTokens,
        completionTokens: modelJobs.getById(succeededJob.id).completionTokens,
        cachedPromptTokens: modelJobs.getById(succeededJob.id).cachedPromptTokens,
        requestCount: modelJobs.getById(succeededJob.id).requestCount,
        latencyMs: modelJobs.getById(succeededJob.id).latencyMs,
      },
      {
        status: "succeeded",
        promptTokens: 120,
        completionTokens: 45,
        cachedPromptTokens: 80,
        requestCount: 3,
        latencyMs: 950,
      },
      "successful model jobs persist usage and request metrics",
    );

    modelJobs.appendDebugEvents(succeededJob.id, [{ layer: "L0", action: "skip", reason: "integration-one" }]);
    modelJobs.appendDebugEvents(succeededJob.id, [{ layer: "L1", action: "dedup", reason: "integration-two" }]);
    assert.deepEqual(
      JSON.parse(modelJobs.getById(succeededJob.id).debugEventsJson).map((event) => event.reason),
      ["integration-one", "integration-two"],
      "debug events append without replacing prior events",
    );

    const failedJob = modelJobs.create({ id: "model-job-failed", type: "integration", inputJson: "{}" });
    modelJobs.markFailed(
      failedJob.id,
      "rate_limited",
      "integration failure",
      1,
      null,
      undefined,
      undefined,
      {
        promptTokens: 12,
        completionTokens: null,
        cachedPromptTokens: null,
        latencyMs: 300,
      },
    );
    const failedMetrics = db.prepare(
      `SELECT prompt_tokens, completion_tokens, cached_prompt_tokens, request_count, latency_ms
       FROM model_jobs WHERE id = ?`,
    ).get(failedJob.id);
    assert.deepEqual(
      failedMetrics,
      {
        prompt_tokens: 12,
        completion_tokens: null,
        cached_prompt_tokens: null,
        request_count: null,
        latency_ms: 300,
      },
      "failed model jobs preserve nullable metrics and keep unknown request counts null",
    );

    const updatedJob = modelJobs.update(failedJob.id, {
      errorMessage: "updated integration failure",
      attempts: 2,
    });
    assert.equal(updatedJob.errorMessage, "updated integration failure");
    assert.equal(updatedJob.attempts, 2);
    assert.equal(updatedJob.requestCount, null, "ordinary updates preserve nullable metrics");
    assert.equal(modelJobs.delete(failedJob.id), true);
    assert.equal(modelJobs.getById(failedJob.id), null);
    assert.equal(modelJobs.delete(failedJob.id), false, "deleting a missing model job reports false");

    const timelineRepo = new TimelineBlockRepository(db);
    timelineRepo.insertMany("2026-07-11", [timelineBlock("frozen", ["o-frozen"]), timelineBlock("mutable", [], ["scene-stable"])]);
    timelineRepo.insertMany("2026-07-11", [{
      ...timelineBlock("partial-card", ["o-partial"]),
      startAt: "2026-07-11T11:00:00.000Z",
      endAt: "2026-07-11T11:06:00.000Z",
      sourceCompleteness: "partial",
    }]);
    assert.equal(timelineRepo.findByDateKey("2026-07-11").find((block) => block.id === "partial-card").sourceCompleteness, "partial");

    const timelineWindows = new TimelineGenerationWindowRepository(db);
    const persistedWindow = timelineWindows.create({
      dateKey: "2026-07-11",
      collectionStart: "2026-07-11T11:00:00.000Z",
      collectionEnd: "2026-07-11T11:10:00.000Z",
    });
    timelineWindows.update(persistedWindow.id, {
      status: "succeeded",
      actualStart: "2026-07-11T11:00:00.000Z",
      actualEnd: "2026-07-11T11:06:00.000Z",
      sourceCompleteness: "partial",
      timelineBlockId: "partial-card",
      sourceObservationCount: 2,
      closeReason: "duration",
    });
    assert.deepEqual(
      {
        status: timelineWindows.getById(persistedWindow.id).status,
        actualEnd: timelineWindows.getById(persistedWindow.id).actualEnd,
        sourceCompleteness: timelineWindows.getById(persistedWindow.id).sourceCompleteness,
        timelineBlockId: timelineWindows.getById(persistedWindow.id).timelineBlockId,
      },
      {
        status: "succeeded",
        actualEnd: "2026-07-11T11:06:00.000Z",
        sourceCompleteness: "partial",
        timelineBlockId: "partial-card",
      },
      "timeline window state and stable card identity persist",
    );
    db.prepare(`INSERT INTO reports
      (id,type,date_key,title,content_json,source_fact_ids_json,source_scene_ids_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
        "timeline-report", "work_daily_report", "2026-07-11", "Report",
        JSON.stringify({ sourceTimelineBlockIds: ["frozen"] }), "[]", "[]", new Date().toISOString(), new Date().toISOString()
      );
    const replaced = timelineRepo.replaceWindowAndCheckpoint({
      dateKey: "2026-07-11", windowStart: "2026-07-11T09:00:00.000Z", windowEnd: "2026-07-11T11:00:00.000Z",
      blocks: [timelineBlock("ignored-model-id", ["o-frozen"]), timelineBlock("another-model-id", [], ["scene-stable"])],
      processedThrough: "2026-07-11T11:00:00.000Z",
    });
    assert.deepEqual(replaced.map((value) => value.id).sort(), ["frozen", "mutable"], "report references freeze cards and source overlap inherits IDs");
    assert.equal(db.prepare("SELECT processed_through FROM timeline_build_checkpoints WHERE date_key = ?").get("2026-07-11").processed_through, "2026-07-11T11:00:00.000Z");

    const beforeTimeline = timelineRepo.findByDateKey("2026-07-11");
    assert.throws(() => timelineRepo.replaceWindowAndCheckpoint({
      dateKey: "2026-07-11", windowStart: "2026-07-11T09:00:00.000Z", windowEnd: "2026-07-11T11:00:00.000Z",
      blocks: [{ ...timelineBlock("invalid", ["new-source"]), title: undefined }],
      processedThrough: "2026-07-11T12:00:00.000Z",
    }));
    assert.deepEqual(timelineRepo.findByDateKey("2026-07-11"), beforeTimeline, "timeline replacement rolls back deleted blocks");
    assert.equal(db.prepare("SELECT processed_through FROM timeline_build_checkpoints WHERE date_key = ?").get("2026-07-11").processed_through, "2026-07-11T11:00:00.000Z", "checkpoint rolls back with replacement");

    const inbox = new CaptureInboxRepository(db);
    const first = capture("cap-1");
    assert.equal(inbox.enqueueCapture(first), true);
    assert.equal(inbox.enqueueCapture(first), false, "capture enqueue is idempotent");
    assert.equal(inbox.createBatch(batch("batch-1", [first])), true);
    assert.equal(inbox.createBatch(batch("batch-1", [first])), false, "batch creation is idempotent");
    inbox.markStageRunning("batch-1", "observer");
    inbox.markStageSucceeded("batch-1", "observer", { observationIds: ["obs-1"] });
    const checkpointed = inbox.listProcessableBatches(3)[0];
    assert.equal(checkpointed.stages.observer, "succeeded");
    assert.deepEqual(checkpointed.checkpoint.observationIds, ["obs-1"]);
    inbox.markRunning("batch-1");
    assert.equal(inbox.recoverRunningBatches(), 1);
    assert.equal(inbox.listProcessableBatches(3)[0].attempts, 1);
    inbox.markRunning("batch-1");
    inbox.checkpointRunning("batch-1");
    assert.equal(inbox.listProcessableBatches(3)[0].status, "pending");
    inbox.markSucceeded("batch-1");
    assert.equal(db.prepare("SELECT status FROM capture_inbox WHERE capture_id = ?").get("cap-1").status, "succeeded");

    const failedCapture = capture("cap-failed", "", "2026-07-11T10:05:00.000Z");
    inbox.enqueueCapture(failedCapture);
    inbox.createBatch(batch("batch-failed", [failedCapture]));
    inbox.markFailed("batch-failed", "OCR exhausted", false);
    const boundaryCapture = capture("cap-boundary", "", "2026-07-11T10:10:00.000Z");
    inbox.enqueueCapture(boundaryCapture);
    const firstWindowWatermark = inbox.getWindowWatermark(
      "2026-07-11T10:00:00.000Z",
      "2026-07-11T10:10:00.000Z",
    );
    assert.deepEqual(
      {
        totalCount: firstWindowWatermark.totalCount,
        unsettledCount: firstWindowWatermark.unsettledCount,
        failedCount: firstWindowWatermark.failedCount,
      },
      { totalCount: 2, unsettledCount: 0, failedCount: 1 },
      "event-time watermark treats exhausted failures as terminal partial data",
    );
    assert.equal(
      inbox.getWindowWatermark("2026-07-11T10:10:00.000Z", "2026-07-11T10:20:00.000Z").totalCount,
      1,
      "an observation exactly on the boundary belongs only to the next half-open window",
    );

    // 重试用尽却被恢复动作写回 pending 的 batch：既挑不出来处理，也不能永远算 unsettled。
    const zombieCapture = capture("cap-zombie", "", "2026-07-11T10:30:00.000Z");
    inbox.enqueueCapture(zombieCapture);
    inbox.createBatch(batch("batch-zombie", [zombieCapture]));
    db.prepare("UPDATE capture_batches SET attempts = 3, status = 'running' WHERE batch_id = ?").run("batch-zombie");
    assert.equal(inbox.recoverRunningBatches(), 1);
    assert.equal(
      inbox.listProcessableBatchesForWindow("2026-07-11T10:30:00.000Z", "2026-07-11T10:40:00.000Z", 3).length,
      0,
      "a retry-exhausted batch is never processable again",
    );
    assert.deepEqual(
      {
        unsettled: inbox.getWindowWatermark("2026-07-11T10:30:00.000Z", "2026-07-11T10:40:00.000Z").unsettledCount,
        failed: inbox.getWindowWatermark("2026-07-11T10:30:00.000Z", "2026-07-11T10:40:00.000Z").failedCount,
      },
      { unsettled: 0, failed: 1 },
      "the watermark counts a retry-exhausted pending batch as failed, not unsettled",
    );
    assert.equal(inbox.failExhaustedBatches(3), 1, "the reaper drives exhausted batches to a terminal status");
    assert.equal(
      db.prepare("SELECT status FROM capture_batches WHERE batch_id = ?").get("batch-zombie").status,
      "failed",
    );
    assert.equal(inbox.failExhaustedBatches(3), 0, "the reaper is idempotent");

    const now = "2026-07-11T10:00:00.000Z";
    db.prepare("INSERT INTO projects (id,name,summary,status,source_fact_ids_json,source_scene_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("p1", "Recall project", "SQLite search", "active", "[]", "[]", now, now);
    const memoryObjects = new MemoryObjectRepository(db);
    memoryObjects.createProject({
      id: "candidate-project", name: "Possible project", summary: "Needs review", status: "active",
      lastActiveAt: now, sourceFactIds: [], sourceSceneIds: [], aliases: ["Project alias"],
      admissionStatus: "candidate", admissionReason: "project_needs_independent_episode",
      admissionEvidence: [], admissionDecidedBy: "auto", admissionRuleVersion: 1, admissionReviewedAt: now,
    });
    memoryObjects.createPerson({
      id: "candidate-person", name: "Possible person", role: null, organization: null,
      summary: "Needs review", relatedProjectIds: [], sourceFactIds: [], relationship: null, aliases: ["Person alias"],
      admissionStatus: "candidate", admissionReason: "person_without_direct_relationship",
      admissionEvidence: [], admissionDecidedBy: "auto", admissionRuleVersion: 1, admissionReviewedAt: now,
    });
    assert.equal(memoryObjects.listProjects({ includeArchived: true }).some((project) => project.id === "candidate-project"), false);
    assert.equal(memoryObjects.listPeople({ includeDeleted: true }).some((person) => person.id === "candidate-person"), false);
    assert.equal(memoryObjects.listProjects({ admissionStatus: "candidate" })[0].id, "candidate-project");
    assert.equal(memoryObjects.listPeople({ admissionStatus: "candidate" })[0].id, "candidate-person");
    assert.equal(memoryObjects.findActiveProjectByFuzzyName("Project alias").id, "candidate-project");
    assert.equal(memoryObjects.findActiveProjectByFuzzyName("Possible"), null, "project substrings never resolve identity");
    assert.equal(memoryObjects.findPersonByFuzzyName("Person alias").id, "candidate-person");
    assert.equal(memoryObjects.findPersonByFuzzyName("Possible"), null, "person substrings never resolve identity");
    db.prepare("INSERT INTO facts (id,type,content,project_id,importance,confidence,inferred,source_observation_ids_json,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("f1", "note", "fix C++ parser edge-case", "p1", 1, 1, 0, "[]", '["fts5"]', now, now);
    db.prepare("INSERT INTO reports (id,type,date_key,title,content_json,source_fact_ids_json,source_scene_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("r1", "daily", "2026-07-11", "FTS report", '{"body":"parser progress"}', "[]", "[]", now, now);
    const search = new MemorySearchRepository(db).search("parser", 1, 0);
    assert.equal(search.total, 2);
    assert.equal(search.results.length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM memory_search_fts").get().count >= 3, true);

    insertObservation(db, "obs-search", "cap-search", now);
    db.prepare("UPDATE observations SET user_facing_summary = ?, scene_summary = ?, visible_content_json = ? WHERE id = ?")
      .run("查看离线架构文档", "阅读工具架构说明", JSON.stringify([{ type: "document", summary: "离线方案", fullText: "最终采用本地缓存\nMatilda 负责缓存失效策略", keyTextSnippets: ["最终采用本地缓存"] }]), "obs-search");
    db.prepare("INSERT INTO facts (id,type,content,importance,confidence,inferred,source_observation_ids_json,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("f-search", "note", "整理架构研究", 1, 1, 0, '["obs-search"]', "[]", now, now);
    const sourceSearch = new MemorySearchRepository(db).search("本地缓存", 10, 0);
    assert.equal(sourceSearch.results.some((item) => item.id === "f-search" && item.type === "fact"), true, "observation text recalls its aggregated fact");
    const sourceDetail = new MemorySearchRepository(db).getDetail({ id: "f-search", type: "fact" });
    assert.equal(sourceDetail.sources[0].visibleContent[0].keyTextSnippets[0], "最终采用本地缓存");
    assert.equal(sourceDetail.sources[0].visibleContent[0].fullText.includes("Matilda"), true);
    assert.equal(new MemorySearchRepository(db).search("Matilda", 10, 0).results.some((item) => item.id === "f-search"), true, "full observation text participates in recall");
    timelineRepo.insertMany("2026-07-11", [{
      ...timelineBlock("detail-block", ["obs-search"]),
      title: "整理离线架构文档",
      summary: "确认最终采用本地缓存",
      highlights: ["保留识别文本"],
      generatedTasks: ["补充缓存失效策略"],
    }]);
    const timelineDetail = new MemorySearchRepository(db).getDetail({ id: "detail-block", type: "timeline" });
    assert.equal(timelineDetail.title, "整理离线架构文档");
    assert.equal(timelineDetail.sources[0].visibleContent[0].keyTextSnippets[0], "最终采用本地缓存");
    assert.equal(timelineDetail.contentSections[1].items[0], "补充缓存失效策略");

    const corrections = new CorrectionLifecycleRepository(db);
    corrections.recordRevision({ targetType: "fact", targetId: "f1", feedbackType: "content_wrong", before: { content: "before" }, after: { content: "after" } });
    const revisions = corrections.listRevisions("fact", "f1");
    assert.equal(revisions.length, 1);
    assert.deepEqual(revisions[0].before, { content: "before" });
    corrections.enqueue("fact", "f1", ["timeline", "report", "search", "l3"], "correction:content_wrong");
    corrections.enqueue("fact", "f1", ["search"], "correction:content_wrong");
    assert.equal(corrections.listPending().length, 4, "pending invalidations are deduplicated by projection and target");
    assert.equal(corrections.markCompleted(corrections.listPending()[0].id), true);
    assert.equal(corrections.listPending().length, 3);

    const oldFile = path.join(root, "old.png");
    fs.writeFileSync(oldFile, "test");
    insertObservation(db, "obs-old", "cap-old", "2020-01-01T00:00:00.000Z", [oldFile]);
    const observationRepo = new ObservationRepository(db);
    const factRepo = new FactRepository(db);
    const sceneRepo = new SceneRepository(db);
    const episodeInput = {
      title: "Episode", summary: "summary", startAt: now, endAt: now, projectId: null,
      confidence: 1, factIds: [], observationIds: ["obs-old"], entityNames: [], taskIds: [], decisionIds: [],
      derivationKey: "episode:v1:obs-old", derivationVersion: 1,
    };
    const episode = sceneRepo.create(episodeInput);
    assert.equal(sceneRepo.create(episodeInput).id, episode.id, "episode derivation is idempotent");
    const atomInput = {
      type: "note", content: "derived", status: null, projectId: null, projectHint: null,
      importance: 1, confidence: 1, inferred: false, evidenceText: "evidence",
      sourceObservationIds: ["obs-old"], tags: [], sourceEpisodeIds: [episode.id],
      claimStatus: "active", generationPath: "test", generationVersion: 1, derivationKey: "atom:v1:test:0",
    };
    const atom = factRepo.create(atomInput);
    assert.equal(factRepo.create(atomInput).id, atom.id, "atom derivation is idempotent");
    const edges = new MemoryEdgeRepository(db);
    const edgeInput = { fromType: "scene", fromId: episode.id, toType: "fact", toId: atom.id, relationType: "contains", confidence: 0.5, createdBy: "system", evidenceIds: ["obs-old"], status: "active" };
    const edge = edges.create(edgeInput);
    assert.equal(edges.create({ ...edgeInput, confidence: 0.9 }).id, edge.id, "edge natural key upserts");
    assert.equal(edges.getById(edge.id).confidence, 0.9);
    assert.throws(() => edges.create({ ...edgeInput, toId: "missing" }), /endpoint does not exist/);
    const service = new DataLifecycleService({
      db, observationRepo, factRepo, sceneRepo,
      screenshotCache: {
        deleteFiles: async (paths) => {
          for (const file of paths) fs.rmSync(file, { force: true });
          return { attempted: paths.length, deletedScreenshots: paths.length, failed: 0 };
        },
        clearAll: async () => ({ attempted: 0, deletedScreenshots: 0, failed: 0 }),
      },
      captureService: { drain: async () => {} }, captureBatcher: { suspendAndFlush: async () => {}, resumeAccepting: () => {} },
      batchProcessor: { drain: async () => {} }, isObserving: () => false, pauseSources: () => {}, resumeSources: () => {},
      cascade: () => {},
    });
    const forgotten = await service.forgetRecent("15m");
    assert.equal(forgotten.deletedObservations, 0, "strict recent range preserves old observations");

    const beforeRollback = db.prepare("SELECT COUNT(*) count FROM facts").get().count;
    const failingService = new DataLifecycleService({
      db, observationRepo, factRepo, sceneRepo, screenshotCache: { deleteFiles: async () => ({ attempted: 0, deletedScreenshots: 0, failed: 0 }) },
      captureService: { drain: async () => {} }, captureBatcher: { suspendAndFlush: async () => {}, resumeAccepting: () => {} },
      batchProcessor: { drain: async () => {} }, isObserving: () => false, pauseSources: () => {}, resumeSources: () => {},
      cascade: () => { throw new Error("rollback marker"); },
    });
    insertObservation(db, "obs-new", "cap-new", new Date().toISOString());
    db.prepare("UPDATE facts SET source_observation_ids_json = ? WHERE id = ?").run('["obs-new"]', "f1");
    await assert.rejects(() => failingService.forgetRecent("15m"), /rollback marker/);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM facts").get().count, beforeRollback);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM observations WHERE id = 'obs-new'").get().count, 1);

    const exportCollections = ["observations", "facts", "scenes", "tasks", "decisions", "people", "projects", "reports"];
    const exportCounts = Object.fromEntries(exportCollections.map((table) => [table, db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count]));
    assert.equal(exportCounts.facts, 3);
    assert.equal(exportCounts.reports, 2);

    await service.clearAll();
    for (const table of ["observations", "facts", "scenes", "projects", "reports", "capture_inbox", "capture_batches"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count, 0, `${table} cleared transactionally`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) count FROM memory_search_fts").get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM observation_search_fts").get().count, 0);
  } finally {
    db.close();
  }

  const failurePath = path.join(root, "migration-failure.db");
  const failureDb = new Database(failurePath);
  try {
    const files = migrations();
    const targetMigration = "021_observation_search_fts.sql";
    const targetIndex = files.indexOf(targetMigration);
    assert.notEqual(targetIndex, -1, `${targetMigration} is present`);
    migrate(failureDb, files.slice(0, targetIndex));
    failureDb.exec("CREATE TABLE preserved_user_data (value TEXT NOT NULL); INSERT INTO preserved_user_data VALUES ('keep-me');");
    failureDb.exec("CREATE TABLE observation_search_fts (value TEXT)");
    assert.throws(() => migrate(failureDb, files.slice(0, targetIndex + 1)), /already exists/);
    assert.equal(failureDb.prepare("SELECT value FROM preserved_user_data").get().value, "keep-me");
    assert.equal(failureDb.prepare("SELECT COUNT(*) count FROM _migrations WHERE version = ?").get(targetMigration).count, 0);
  } finally {
    failureDb.close();
  }

  const ocrMigrationPath = path.join(root, "ocr-migration.db");
  const ocrMigrationDb = new Database(ocrMigrationPath);
  try {
    const files = migrations();
    const targetMigration = "023_compact_persisted_ocr_evidence.sql";
    const targetIndex = files.indexOf(targetMigration);
    assert.notEqual(targetIndex, -1, `${targetMigration} is present`);
    migrate(ocrMigrationDb, files.slice(0, targetIndex));
    insertObservation(ocrMigrationDb, "obs-ocr", "cap-ocr", "2026-07-16T00:00:00.000Z");
    const originalOcrText = "完整 OCR 原文";
    ocrMigrationDb.prepare("UPDATE observations SET visible_content_json = ? WHERE id = ?").run(JSON.stringify([{
      type: "document", summary: "summary", fullText: "model text", keyTextSnippets: [],
      ocrEvidence: {
        source: "windows_ocr_original_image", text: originalOcrText, lines: [originalOcrText],
        blocks: [{ id: "b1", text: originalOcrText, boundingBox: { x: 1, y: 2, width: 3, height: 4 }, words: [] }],
        delta: { unchangedBlockIds: [], addedBlocks: [], changedBlocks: [], removedBlocks: [] },
        screenSignature: { pixelHash: "hash", dHash: "hash", width: 100, height: 100 },
      },
    }]), "obs-ocr");

    migrate(ocrMigrationDb);
    const migrated = JSON.parse(ocrMigrationDb.prepare(
      "SELECT visible_content_json FROM observations WHERE id = ?"
    ).get("obs-ocr").visible_content_json);
    assert.equal(migrated[0].ocrEvidence.text, originalOcrText, "OCR text survives geometry cleanup");
    assert.equal("blocks" in migrated[0].ocrEvidence, false);
    assert.equal("delta" in migrated[0].ocrEvidence, false);
    assert.equal("screenSignature" in migrated[0].ocrEvidence, false);
  } finally {
    ocrMigrationDb.close();
  }

  const timelineMigrationPath = path.join(root, "timeline-window-migration.db");
  const timelineMigrationDb = new Database(timelineMigrationPath);
  try {
    const files = migrations();
    const targetMigration = "026_timeline_generation_windows.sql";
    const targetIndex = files.indexOf(targetMigration);
    assert.notEqual(targetIndex, -1, `${targetMigration} is present`);
    migrate(timelineMigrationDb, files.slice(0, targetIndex));
    const legacyCapturedAt = "2026-07-11T09:03:00.000Z";
    const legacyCapture = capture("legacy-capture", "", legacyCapturedAt);
    timelineMigrationDb.prepare(`INSERT INTO capture_inbox
      (capture_id, bundle_json, status, batch_id, created_at, updated_at)
      VALUES (?, ?, 'pending', NULL, ?, ?)`)
      .run(legacyCapture.captureId, JSON.stringify(legacyCapture), legacyCapturedAt, legacyCapturedAt);
    timelineMigrationDb.prepare(`INSERT INTO projects
      (id, name, summary, status, source_fact_ids_json, source_scene_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', '[]', ?, ?)`)
      .run("legacy-project", "Legacy project", "Before admission migration", "active", legacyCapturedAt, legacyCapturedAt);
    timelineMigrationDb.prepare(`INSERT INTO people
      (id, name, summary, related_project_ids_json, source_fact_ids_json, created_at, updated_at)
      VALUES (?, ?, ?, '[]', '[]', ?, ?)`)
      .run("legacy-person", "Legacy person", "Before admission migration", legacyCapturedAt, legacyCapturedAt);

    migrate(timelineMigrationDb);
    assert.equal(
      timelineMigrationDb.prepare("SELECT captured_at FROM capture_inbox WHERE capture_id = ?").get("legacy-capture").captured_at,
      legacyCapturedAt,
      "captured_at is backfilled from the durable capture bundle",
    );
    assert.equal(
      timelineMigrationDb.prepare("SELECT admission_status FROM projects WHERE id = ?").get("legacy-project").admission_status,
      "promoted",
      "legacy projects remain visible until conservative reassessment",
    );
    assert.equal(
      timelineMigrationDb.prepare("SELECT admission_status FROM people WHERE id = ?").get("legacy-person").admission_status,
      "promoted",
      "legacy people remain visible until conservative reassessment",
    );
  } finally {
    timelineMigrationDb.close();
  }

  console.log("SQLite integration passed: timeline windows/watermarks, admission filtering, migrations/failure preservation, model job metrics/debug lifecycle, OCR geometry cleanup, inbox recovery/checkpoint/idempotency, lifecycle transactions, FTS and counts.");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
