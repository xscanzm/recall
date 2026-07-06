-- 001_initial_schema.sql
-- 初始 schema：13 张表 + 8 个索引
-- 来自 04_MEMORY_AND_DATA_SCHEMA.md 与 06_TECHNICAL_ARCHITECTURE.md
--
-- 重要约束：
-- - API Key 不进 SQLite（model_configs 表不含 api_key 字段）
-- - soft delete 字段：facts/scenes/projects/tasks/people/decisions 含 deleted_at
-- - JSON 字段以 _json 后缀，存 TEXT，Repository 层做 stringify/parse

-- ============================================================================
-- L0: observations（原始观察记录）
-- ============================================================================
CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  app_name TEXT NOT NULL,
  window_title TEXT NOT NULL,
  url_or_domain TEXT,
  capture_reason TEXT NOT NULL,
  scene_summary TEXT NOT NULL,
  visible_content_json TEXT NOT NULL DEFAULT '[]',
  detected_entities_json TEXT NOT NULL DEFAULT '[]',
  possible_intent TEXT,
  possible_tasks_json TEXT NOT NULL DEFAULT '[]',
  possible_decisions_json TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  uncertainties_json TEXT NOT NULL DEFAULT '[]',
  screenshot_retention TEXT NOT NULL,
  screenshot_paths_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- ============================================================================
-- L1: facts（结构化事实）
-- ============================================================================
CREATE TABLE facts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT,
  project_id TEXT,
  project_hint TEXT,
  importance REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  inferred INTEGER NOT NULL DEFAULT 0,
  evidence_text TEXT,
  source_observation_ids_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ============================================================================
-- L2: scenes（场景聚合）
-- ============================================================================
CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  project_id TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  fact_ids_json TEXT NOT NULL DEFAULT '[]',
  observation_ids_json TEXT NOT NULL DEFAULT '[]',
  entity_names_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ============================================================================
-- L3: projects（项目）
-- ============================================================================
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  last_active_at TEXT,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_scene_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  -- 003 字段：标记仅由被删 facts 支撑的对象
  -- orphan_status: 'ok' / 'needs_review' / 'source_deleted'
  orphan_status TEXT
);

-- ============================================================================
-- L3: tasks（任务）
-- ============================================================================
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  project_id TEXT,
  summary TEXT,
  due_hint TEXT,
  priority REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT,
  -- 003 字段：标记仅由被删 facts 支撑的对象
  -- orphan_status: 'ok' / 'needs_review' / 'source_deleted'
  orphan_status TEXT
);

-- ============================================================================
-- L3: people（人物）
-- ============================================================================
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  organization TEXT,
  summary TEXT NOT NULL DEFAULT '',
  related_project_ids_json TEXT NOT NULL DEFAULT '[]',
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- ============================================================================
-- L3: decisions（决策）
-- ============================================================================
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  project_id TEXT,
  rationale TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  -- 003 字段：标记仅由被删 facts 支撑的对象
  -- orphan_status: 'ok' / 'needs_review' / 'source_deleted'
  orphan_status TEXT
);

-- ============================================================================
-- proactive_items（主动提醒项）
-- ============================================================================
CREATE TABLE proactive_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority REAL NOT NULL DEFAULT 0,
  surface TEXT NOT NULL,
  requires_user_confirmation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_scene_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- reports（报告：daily/weekly/retrospective）
-- ============================================================================
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  date_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_scene_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 003 字段：标记报告引用被删 facts/scenes 后需要重新生成
  -- is_stale: 0 = 正常, 1 = 需要重新生成
  is_stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  stale_at TEXT
);

-- ============================================================================
-- model_configs（模型配置，API Key 不在此表）
-- ============================================================================
CREATE TABLE model_configs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- privacy_rules（隐私规则）
-- ============================================================================
CREATE TABLE privacy_rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- user_feedback（用户反馈）
-- ============================================================================
CREATE TABLE user_feedback (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

-- ============================================================================
-- model_jobs（模型任务记录）
-- ============================================================================
CREATE TABLE model_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 索引（8 个）
-- ============================================================================
CREATE INDEX idx_observations_captured_at ON observations(captured_at);
CREATE INDEX idx_facts_type_created_at ON facts(type, created_at);
CREATE INDEX idx_facts_project_id ON facts(project_id);
CREATE INDEX idx_scenes_start_at ON scenes(start_at);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_proactive_status ON proactive_items(status);
CREATE INDEX idx_reports_type_date ON reports(type, date_key);
