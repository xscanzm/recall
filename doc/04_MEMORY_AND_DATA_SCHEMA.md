# 04. Memory And Data Schema

## 记忆分层

Recall 的记忆不是流水账。必须实现 L0-L3。

```text
L0 Observation: 看见什么
L1 Fact: 发生了什么，有什么可复用事实
L2 Scene: 一段连续工作场景
L3 Memory Object: 长期项目、任务、人物、偏好、决策、知识
```

L0-L3 全部由模型自动生成。用户可以在 UI 中编辑、删除、合并、纠错。

## L0 Observation

L0 是视觉模型对截图 bundle 的结构化观察。

特点：

- 自动生成。
- 可短期保留。
- 不直接作为日报主材料。
- 可以被删除，不影响已沉淀的高层记忆，除非用户选择级联删除。

字段：

```ts
interface Observation {
  id: string;
  captureId: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  urlOrDomain?: string;
  captureReason: string;
  sceneSummary: string;
  visibleContentJson: string;
  detectedEntitiesJson: string;
  possibleIntent: string;
  possibleTasksJson: string;
  possibleDecisionsJson: string;
  sensitivity: "normal" | "possibly_sensitive" | "high_sensitive";
  confidence: number;
  uncertaintiesJson: string;
  screenshotRetention: "none" | "cached" | "deleted" | "expired";
  screenshotPathsJson: string;
  createdAt: string;
}
```

## L1 Fact

L1 是最小可复用事实。

类型：

- `task`
- `decision`
- `project_progress`
- `person`
- `preference`
- `knowledge`
- `risk`
- `question`
- `note`

字段：

```ts
interface Fact {
  id: string;
  type: FactType;
  content: string;
  status?: "open" | "in_progress" | "likely_done" | "done" | "blocked" | "unknown";
  projectId?: string;
  projectHint?: string;
  importance: number;
  confidence: number;
  inferred: boolean;
  evidenceText: string;
  sourceObservationIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
```

## L2 Scene

L2 是一段工作场景，不是机械时间片。

示例：

> 下午围绕 Recall 的 AI pipeline 做产品讨论，明确视觉模型和 LLM 必须通过结构化合约驱动系统。

字段：

```ts
interface Scene {
  id: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  projectId?: string;
  confidence: number;
  factIds: string[];
  observationIds: string[];
  entityNames: string[];
  createdAt: string;
  updatedAt: string;
}
```

## L3 Memory Objects

L3 是长期记忆对象。

### ProjectMemory

```ts
interface ProjectMemory {
  id: string;
  name: string;
  summary: string;
  status: "active" | "paused" | "completed" | "archived";
  lastActiveAt?: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

### TaskMemory

```ts
interface TaskMemory {
  id: string;
  title: string;
  status: "open" | "in_progress" | "likely_done" | "done" | "blocked" | "needs_confirmation";
  projectId?: string;
  summary?: string;
  dueHint?: string;
  priority: number;
  confidence: number;
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

状态说明：

- `open`：模型认为是待办。
- `in_progress`：近期有推进。
- `likely_done`：模型看到完成迹象，但没有用户确认。
- `done`：用户确认或有明确完成证据。
- `blocked`：模型看到阻塞/风险。
- `needs_confirmation`：模型不确定，需要用户看一眼。

### PersonMemory

```ts
interface PersonMemory {
  id: string;
  name: string;
  role?: string;
  organization?: string;
  summary: string;
  relatedProjectIds: string[];
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

### DecisionMemory

```ts
interface DecisionMemory {
  id: string;
  title: string;
  decision: string;
  projectId?: string;
  rationale?: string;
  confidence: number;
  sourceFactIds: string[];
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### PreferenceMemory

```ts
interface PreferenceMemory {
  id: string;
  scope: "product" | "writing" | "ui" | "workflow" | "privacy" | "notification" | "other";
  content: string;
  confidence: number;
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
}
```

## SQLite schema

### observations

```sql
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
```

### facts

```sql
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
```

### scenes

```sql
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
```

### projects

```sql
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
  archived_at TEXT
);
```

### tasks

```sql
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
  deleted_at TEXT
);
```

### people

```sql
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
```

### decisions

```sql
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
  deleted_at TEXT
);
```

### proactive_items

```sql
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
```

### reports

```sql
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  date_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_scene_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### model_configs

```sql
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
```

API Key 不存在 SQLite。存在系统安全存储，key name: `recall:model:<configId>:apiKey`。

### privacy_rules

```sql
CREATE TABLE privacy_rules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### user_feedback

```sql
CREATE TABLE user_feedback (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  feedback_type TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
```

## 索引建议

```sql
CREATE INDEX idx_observations_captured_at ON observations(captured_at);
CREATE INDEX idx_facts_type_created_at ON facts(type, created_at);
CREATE INDEX idx_facts_project_id ON facts(project_id);
CREATE INDEX idx_scenes_start_at ON scenes(start_at);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_proactive_status ON proactive_items(status);
CREATE INDEX idx_reports_type_date ON reports(type, date_key);
```

## 删除和纠错

不要硬删除用户对象，先 soft delete。

用户删除 observation 时：

- 删除关联截图。
- 标记 observation deleted 或直接删除。
- 关联 facts 如果只来源于该 observation，soft delete。
- 关联 scenes/reports 标记需要重新生成。

用户编辑 fact/task/project 时：

- 更新对象。
- 写 user_feedback。
- 不要覆盖 source ids。

