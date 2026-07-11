-- 016_capture_inbox.sql
-- Durable capture inbox and batch processing checkpoints.

CREATE TABLE capture_inbox (
  capture_id TEXT PRIMARY KEY,
  bundle_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  batch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_capture_inbox_status_created
  ON capture_inbox(status, created_at);

CREATE TABLE capture_batches (
  batch_id TEXT PRIMARY KEY,
  bundle_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_capture_batches_status_created
  ON capture_batches(status, created_at);

CREATE INDEX idx_observations_capture_id
  ON observations(capture_id);
