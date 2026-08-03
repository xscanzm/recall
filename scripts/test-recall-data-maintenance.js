#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { runRecallDataMaintenance } = require("../dist/main/db/RecallDataMaintenance.js");
const { CaptureInboxRepository } = require("../dist/main/db/repositories/CaptureInboxRepository.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-maintenance-test-"));
const dbPath = path.join(root, "recall.db");
const backupPath = path.join(root, "recall.db.before.bak");
const db = new Database(dbPath);

try {
  db.exec(`
    CREATE TABLE observations (id TEXT PRIMARY KEY);
    CREATE TABLE facts (id TEXT PRIMARY KEY);
    CREATE TABLE scenes (id TEXT PRIMARY KEY);
    CREATE TABLE timeline_blocks (id TEXT PRIMARY KEY);
    CREATE TABLE capture_batches (
      batch_id TEXT PRIMARY KEY,
      bundle_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      observer_status TEXT NOT NULL DEFAULT 'pending',
      episode_status TEXT NOT NULL DEFAULT 'pending',
      atom_status TEXT NOT NULL DEFAULT 'pending',
      linker_status TEXT NOT NULL DEFAULT 'pending',
      checkpoint_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE capture_inbox (
      capture_id TEXT PRIMARY KEY,
      bundle_json TEXT NOT NULL,
      status TEXT NOT NULL,
      batch_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      captured_at TEXT
    );
    CREATE TABLE model_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      raw_input_json TEXT,
      debug_events_json TEXT
    );
  `);

  db.prepare("INSERT INTO observations (id) VALUES (?)").run("obs-1");
  db.prepare("INSERT INTO facts (id) VALUES (?)").run("fact-1");
  db.prepare("INSERT INTO scenes (id) VALUES (?)").run("scene-1");
  db.prepare("INSERT INTO timeline_blocks (id) VALUES (?)").run("timeline-1");

  const terminalBundle = JSON.stringify({
    batchId: "batch-terminal",
    capturedAtStart: "2026-08-01T00:00:00.000Z",
    capturedAtEnd: "2026-08-01T00:05:00.000Z",
    timezone: "Asia/Shanghai",
    appName: "Recall",
    windowTitle: "Maintenance Test",
    captureReason: "batch_flush",
    frames: [{ captureId: "capture-terminal", text: "x".repeat(8_000) }],
    imagePaths: ["C:/screenshots/terminal.png"],
    compressedImagePaths: ["C:/temp/terminal.jpg"],
    ocrResults: [{ blocks: [{ text: "x".repeat(8_000) }] }],
    retentionPolicy: "today",
  });
  const pendingBundle = JSON.stringify({
    batchId: "batch-pending",
    capturedAtStart: "2026-08-01T01:00:00.000Z",
    capturedAtEnd: "2026-08-01T01:05:00.000Z",
    frames: [{ captureId: "capture-pending", text: "pending payload" }],
    imagePaths: ["C:/screenshots/pending.png"],
    retentionPolicy: "today",
  });
  const now = "2026-08-01T02:00:00.000Z";
  db.prepare(`
    INSERT INTO capture_batches
      (batch_id, bundle_json, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, ?)
  `).run("batch-terminal", terminalBundle, "succeeded", now, now);
  db.prepare(`
    INSERT INTO capture_batches
      (batch_id, bundle_json, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run("batch-pending", pendingBundle, "pending", now, now);
  db.prepare(`
    INSERT INTO capture_inbox
      (capture_id, bundle_json, status, batch_id, created_at, updated_at, captured_at)
    VALUES (?, ?, 'batched', ?, ?, ?, ?)
  `).run("capture-terminal", JSON.stringify({
    captureId: "capture-terminal",
    capturedAt: "2026-08-01T00:00:00.000Z",
    imagePaths: ["C:/screenshots/terminal.png"],
    text: "x".repeat(8_000),
  }), "batch-terminal", now, now, "2026-08-01T00:00:00.000Z");
  db.prepare(`
    INSERT INTO capture_inbox
      (capture_id, bundle_json, status, batch_id, created_at, updated_at, captured_at)
    VALUES (?, ?, 'pending', ?, ?, ?, ?)
  `).run("capture-pending", pendingBundle, "batch-pending", now, now, "2026-08-01T01:00:00.000Z");
  db.prepare(`
    INSERT INTO model_jobs (id, status, raw_input_json, debug_events_json)
    VALUES (?, ?, ?, ?)
  `).run("job-terminal", "succeeded", "x".repeat(5_000), JSON.stringify([{ layer: "L0" }]));
  db.prepare(`
    INSERT INTO model_jobs (id, status, raw_input_json, debug_events_json)
    VALUES (?, ?, ?, ?)
  `).run("job-running", "running", "keep-input", "keep-debug");

  const result = runRecallDataMaintenance(db, dbPath, {
    apply: true,
    vacuum: true,
    backupPath,
  });

  assert.equal(result.applied, true);
  assert.equal(result.vacuumed, true);
  assert.equal(result.backupPath, backupPath);
  assert.equal(result.before.observations, 1);
  assert.equal(result.before.facts, 1);
  assert.equal(result.before.scenes, 1);
  assert.equal(result.before.timelineBlocks, 1);
  assert.equal(result.after.observations, 1);
  assert.equal(result.after.facts, 1);
  assert.equal(result.after.scenes, 1);
  assert.equal(result.after.timelineBlocks, 1);
  assert.equal(result.compaction.batches, 1);
  assert.equal(result.compaction.captures, 1);
  assert.ok(result.compaction.reclaimedBytes > 0);
  assert.equal(result.clearedDebugRows, 1);
  assert.equal(fs.existsSync(backupPath), true);

  const compactedBatch = JSON.parse(db.prepare(
    "SELECT bundle_json FROM capture_batches WHERE batch_id = ?"
  ).get("batch-terminal").bundle_json);
  assert.equal(compactedBatch.frames, undefined);
  assert.equal(compactedBatch.imagePaths, undefined);
  assert.equal(compactedBatch.frameCount, 1);
  assert.equal(compactedBatch.imageCount, 1);

  const retainedPending = JSON.parse(db.prepare(
    "SELECT bundle_json FROM capture_batches WHERE batch_id = ?"
  ).get("batch-pending").bundle_json);
  assert.equal(retainedPending.frames[0].text, "pending payload");

  const terminalJob = db.prepare(
    "SELECT raw_input_json, debug_events_json FROM model_jobs WHERE id = ?"
  ).get("job-terminal");
  const runningJob = db.prepare(
    "SELECT raw_input_json, debug_events_json FROM model_jobs WHERE id = ?"
  ).get("job-running");
  assert.equal(terminalJob.raw_input_json, null);
  assert.equal(terminalJob.debug_events_json, null);
  assert.equal(runningJob.raw_input_json, "keep-input");
  assert.equal(runningJob.debug_events_json, "keep-debug");

  const captureRepo = new CaptureInboxRepository(db);
  assert.deepEqual(captureRepo.listPendingCaptureImagePaths(), ["C:/screenshots/pending.png"]);
  assert.equal(captureRepo.listProcessableBatches(3, 1).length, 1);
  assert.equal(captureRepo.getLatestProcessableBatch(3)?.batchId, "batch-pending");

  console.log("Recall data maintenance integration passed");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
