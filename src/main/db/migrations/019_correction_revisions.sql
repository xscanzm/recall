-- Durable correction history and projection invalidation work queue.
CREATE TABLE correction_revisions (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('fact', 'scene', 'task', 'project', 'person', 'decision', 'reminder')),
  target_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_correction_revisions_target
  ON correction_revisions(target_type, target_id, created_at DESC);

CREATE TABLE projection_invalidations (
  id TEXT PRIMARY KEY,
  projection_type TEXT NOT NULL CHECK (projection_type IN ('timeline', 'report', 'search', 'l3')),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX idx_projection_invalidations_pending
  ON projection_invalidations(projection_type, target_type, target_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX idx_projection_invalidations_status_created
  ON projection_invalidations(status, created_at);
