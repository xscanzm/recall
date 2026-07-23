-- Event-time timeline windows and capture watermark support.

ALTER TABLE capture_inbox ADD COLUMN captured_at TEXT;

UPDATE capture_inbox
SET captured_at = COALESCE(
  json_extract(bundle_json, '$.capturedAt'),
  created_at
)
WHERE captured_at IS NULL;

CREATE INDEX idx_capture_inbox_captured_at
  ON capture_inbox(captured_at);

CREATE INDEX idx_capture_inbox_status_captured_at
  ON capture_inbox(status, captured_at);

ALTER TABLE timeline_blocks ADD COLUMN source_completeness TEXT NOT NULL DEFAULT 'complete'
  CHECK(source_completeness IN ('complete', 'partial'));

CREATE TABLE timeline_generation_windows (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  collection_start TEXT NOT NULL,
  collection_end TEXT NOT NULL,
  actual_start TEXT,
  actual_end TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'collecting', 'sealing', 'ready', 'generating', 'succeeded', 'skipped', 'failed'
  )),
  close_reason TEXT CHECK(close_reason IN (
    'duration', 'idle', 'pause', 'day_rollover', 'report', 'shutdown', 'rebuild'
  )),
  source_completeness TEXT NOT NULL DEFAULT 'complete'
    CHECK(source_completeness IN ('complete', 'partial')),
  timeline_block_id TEXT,
  source_observation_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sealed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(date_key, collection_start, collection_end),
  FOREIGN KEY(timeline_block_id) REFERENCES timeline_blocks(id) ON DELETE SET NULL
);

CREATE INDEX idx_timeline_generation_windows_status
  ON timeline_generation_windows(status, collection_end);

CREATE INDEX idx_timeline_generation_windows_date_start
  ON timeline_generation_windows(date_key, collection_start);
