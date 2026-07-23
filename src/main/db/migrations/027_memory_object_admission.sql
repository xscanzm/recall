-- Backend-owned admission state for long-lived projects and people.

ALTER TABLE projects ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'promoted'
  CHECK(admission_status IN ('promoted', 'candidate', 'rejected'));
ALTER TABLE projects ADD COLUMN admission_reason TEXT;
ALTER TABLE projects ADD COLUMN admission_evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN admission_decided_by TEXT NOT NULL DEFAULT 'legacy'
  CHECK(admission_decided_by IN ('legacy', 'auto', 'user'));
ALTER TABLE projects ADD COLUMN admission_rule_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN admission_reviewed_at TEXT;

ALTER TABLE people ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'promoted'
  CHECK(admission_status IN ('promoted', 'candidate', 'rejected'));
ALTER TABLE people ADD COLUMN admission_reason TEXT;
ALTER TABLE people ADD COLUMN admission_evidence_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE people ADD COLUMN admission_decided_by TEXT NOT NULL DEFAULT 'legacy'
  CHECK(admission_decided_by IN ('legacy', 'auto', 'user'));
ALTER TABLE people ADD COLUMN admission_rule_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN admission_reviewed_at TEXT;

CREATE INDEX idx_projects_admission_status ON projects(admission_status, updated_at);
CREATE INDEX idx_people_admission_status ON people(admission_status, updated_at);
