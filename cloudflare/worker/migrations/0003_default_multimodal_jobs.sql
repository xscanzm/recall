CREATE TABLE IF NOT EXISTS default_multimodal_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  installation_hash TEXT NOT NULL,
  idempotency_hash TEXT NOT NULL,
  task_type TEXT NOT NULL,
  client_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  input_object_key TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  delivered_at TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE (installation_hash, idempotency_hash)
);

CREATE INDEX IF NOT EXISTS idx_default_multimodal_jobs_owner
  ON default_multimodal_jobs (installation_hash, id);

CREATE INDEX IF NOT EXISTS idx_default_multimodal_jobs_expiry
  ON default_multimodal_jobs (expires_at);

CREATE INDEX IF NOT EXISTS idx_default_multimodal_jobs_status
  ON default_multimodal_jobs (status, updated_at);
