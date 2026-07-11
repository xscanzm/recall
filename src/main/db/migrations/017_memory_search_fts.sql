-- Unified FTS5 index for the searchable memory types.
-- unicode61 tokenizes Unicode text but does not perform Chinese word segmentation.
CREATE VIRTUAL TABLE memory_search_fts USING fts5(
  object_id UNINDEXED,
  object_type UNINDEXED,
  title,
  summary,
  keywords,
  created_at UNINDEXED,
  project_id UNINDEXED,
  source_type UNINDEXED,
  source_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO memory_search_fts SELECT id, 'fact', content, COALESCE(evidence_text, ''), COALESCE(project_hint, '') || ' ' || COALESCE(tags_json, '') || ' ' || COALESCE(people_hints_json, ''), created_at, project_id, 'observation', json_extract(source_observation_ids_json, '$[0]') FROM facts WHERE deleted_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'scene', title, summary, COALESCE(entity_names_json, ''), created_at, project_id, 'scene', id FROM scenes WHERE deleted_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'task', title, COALESCE(summary, ''), COALESCE(due_hint, ''), created_at, project_id, 'fact', json_extract(source_fact_ids_json, '$[0]') FROM tasks WHERE deleted_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'project', name, summary, COALESCE(aliases_json, ''), created_at, id, 'project', id FROM projects WHERE archived_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'decision', title, decision || ' ' || COALESCE(rationale, ''), '', created_at, project_id, 'fact', json_extract(source_fact_ids_json, '$[0]') FROM decisions WHERE deleted_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'person', name, COALESCE(role, '') || ' ' || COALESCE(organization, '') || ' ' || summary, COALESCE(aliases_json, ''), created_at, NULL, 'fact', json_extract(source_fact_ids_json, '$[0]') FROM people WHERE deleted_at IS NULL;
INSERT INTO memory_search_fts SELECT id, 'report', title, content_json, type || ' ' || date_key, created_at, project_id, 'report', id FROM reports;

CREATE TRIGGER memory_search_facts_ai AFTER INSERT ON facts WHEN new.deleted_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'fact', new.content, COALESCE(new.evidence_text, ''), COALESCE(new.project_hint, '') || ' ' || COALESCE(new.tags_json, '') || ' ' || COALESCE(new.people_hints_json, ''), new.created_at, new.project_id, 'observation', json_extract(new.source_observation_ids_json, '$[0]')); END;
CREATE TRIGGER memory_search_facts_au AFTER UPDATE ON facts BEGIN DELETE FROM memory_search_fts WHERE object_type = 'fact' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'fact', new.content, COALESCE(new.evidence_text, ''), COALESCE(new.project_hint, '') || ' ' || COALESCE(new.tags_json, '') || ' ' || COALESCE(new.people_hints_json, ''), new.created_at, new.project_id, 'observation', json_extract(new.source_observation_ids_json, '$[0]') WHERE new.deleted_at IS NULL; END;
CREATE TRIGGER memory_search_facts_ad AFTER DELETE ON facts BEGIN DELETE FROM memory_search_fts WHERE object_type = 'fact' AND object_id = old.id; END;

CREATE TRIGGER memory_search_scenes_ai AFTER INSERT ON scenes WHEN new.deleted_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'scene', new.title, new.summary, COALESCE(new.entity_names_json, ''), new.created_at, new.project_id, 'scene', new.id); END;
CREATE TRIGGER memory_search_scenes_au AFTER UPDATE ON scenes BEGIN DELETE FROM memory_search_fts WHERE object_type = 'scene' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'scene', new.title, new.summary, COALESCE(new.entity_names_json, ''), new.created_at, new.project_id, 'scene', new.id WHERE new.deleted_at IS NULL; END;
CREATE TRIGGER memory_search_scenes_ad AFTER DELETE ON scenes BEGIN DELETE FROM memory_search_fts WHERE object_type = 'scene' AND object_id = old.id; END;

CREATE TRIGGER memory_search_tasks_ai AFTER INSERT ON tasks WHEN new.deleted_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'task', new.title, COALESCE(new.summary, ''), COALESCE(new.due_hint, ''), new.created_at, new.project_id, 'fact', json_extract(new.source_fact_ids_json, '$[0]')); END;
CREATE TRIGGER memory_search_tasks_au AFTER UPDATE ON tasks BEGIN DELETE FROM memory_search_fts WHERE object_type = 'task' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'task', new.title, COALESCE(new.summary, ''), COALESCE(new.due_hint, ''), new.created_at, new.project_id, 'fact', json_extract(new.source_fact_ids_json, '$[0]') WHERE new.deleted_at IS NULL; END;
CREATE TRIGGER memory_search_tasks_ad AFTER DELETE ON tasks BEGIN DELETE FROM memory_search_fts WHERE object_type = 'task' AND object_id = old.id; END;

CREATE TRIGGER memory_search_projects_ai AFTER INSERT ON projects WHEN new.archived_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'project', new.name, new.summary, COALESCE(new.aliases_json, ''), new.created_at, new.id, 'project', new.id); END;
CREATE TRIGGER memory_search_projects_au AFTER UPDATE ON projects BEGIN DELETE FROM memory_search_fts WHERE object_type = 'project' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'project', new.name, new.summary, COALESCE(new.aliases_json, ''), new.created_at, new.id, 'project', new.id WHERE new.archived_at IS NULL; END;
CREATE TRIGGER memory_search_projects_ad AFTER DELETE ON projects BEGIN DELETE FROM memory_search_fts WHERE object_type = 'project' AND object_id = old.id; END;

CREATE TRIGGER memory_search_decisions_ai AFTER INSERT ON decisions WHEN new.deleted_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'decision', new.title, new.decision || ' ' || COALESCE(new.rationale, ''), '', new.created_at, new.project_id, 'fact', json_extract(new.source_fact_ids_json, '$[0]')); END;
CREATE TRIGGER memory_search_decisions_au AFTER UPDATE ON decisions BEGIN DELETE FROM memory_search_fts WHERE object_type = 'decision' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'decision', new.title, new.decision || ' ' || COALESCE(new.rationale, ''), '', new.created_at, new.project_id, 'fact', json_extract(new.source_fact_ids_json, '$[0]') WHERE new.deleted_at IS NULL; END;
CREATE TRIGGER memory_search_decisions_ad AFTER DELETE ON decisions BEGIN DELETE FROM memory_search_fts WHERE object_type = 'decision' AND object_id = old.id; END;

CREATE TRIGGER memory_search_people_ai AFTER INSERT ON people WHEN new.deleted_at IS NULL BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'person', new.name, COALESCE(new.role, '') || ' ' || COALESCE(new.organization, '') || ' ' || new.summary, COALESCE(new.aliases_json, ''), new.created_at, NULL, 'fact', json_extract(new.source_fact_ids_json, '$[0]')); END;
CREATE TRIGGER memory_search_people_au AFTER UPDATE ON people BEGIN DELETE FROM memory_search_fts WHERE object_type = 'person' AND object_id = old.id; INSERT INTO memory_search_fts SELECT new.id, 'person', new.name, COALESCE(new.role, '') || ' ' || COALESCE(new.organization, '') || ' ' || new.summary, COALESCE(new.aliases_json, ''), new.created_at, NULL, 'fact', json_extract(new.source_fact_ids_json, '$[0]') WHERE new.deleted_at IS NULL; END;
CREATE TRIGGER memory_search_people_ad AFTER DELETE ON people BEGIN DELETE FROM memory_search_fts WHERE object_type = 'person' AND object_id = old.id; END;

CREATE TRIGGER memory_search_reports_ai AFTER INSERT ON reports BEGIN INSERT INTO memory_search_fts VALUES (new.id, 'report', new.title, new.content_json, new.type || ' ' || new.date_key, new.created_at, new.project_id, 'report', new.id); END;
CREATE TRIGGER memory_search_reports_au AFTER UPDATE ON reports BEGIN DELETE FROM memory_search_fts WHERE object_type = 'report' AND object_id = old.id; INSERT INTO memory_search_fts VALUES (new.id, 'report', new.title, new.content_json, new.type || ' ' || new.date_key, new.created_at, new.project_id, 'report', new.id); END;
CREATE TRIGGER memory_search_reports_ad AFTER DELETE ON reports BEGIN DELETE FROM memory_search_fts WHERE object_type = 'report' AND object_id = old.id; END;
