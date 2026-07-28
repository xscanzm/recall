-- 029_memory_embeddings.sql
-- Vector embedding store for structured memory objects (facts, scenes, tasks, projects, decisions, people, reports).

CREATE TABLE IF NOT EXISTS memory_embeddings (
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model_updated ON memory_embeddings(model_version, updated_at);

-- Durable indexing queue. generation changes whenever an object is enqueued again,
-- so an older in-flight embedding result cannot overwrite newer content.
CREATE TABLE IF NOT EXISTS memory_embedding_queue (
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  operation TEXT NOT NULL DEFAULT 'upsert' CHECK (operation IN ('upsert', 'delete')),
  generation INTEGER NOT NULL DEFAULT 1,
  enqueued_at TEXT NOT NULL,
  PRIMARY KEY (object_type, object_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_queue_enqueued
  ON memory_embedding_queue(enqueued_at, object_type, object_id);

-- Queue all existing active objects. The indexer drains this table in pages.
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'fact', id, 'upsert', 1, updated_at FROM facts WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'scene', id, 'upsert', 1, updated_at FROM scenes WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'task', id, 'upsert', 1, updated_at FROM tasks WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'project', id, 'upsert', 1, updated_at FROM projects WHERE archived_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'decision', id, 'upsert', 1, updated_at FROM decisions WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'person', id, 'upsert', 1, updated_at FROM people WHERE deleted_at IS NULL;
INSERT OR IGNORE INTO memory_embedding_queue SELECT 'report', id, 'upsert', 1, updated_at FROM reports;

-- Active INSERT/UPDATE operations enqueue an upsert. Soft delete/archive and hard
-- delete remove both the vector and queued work synchronously in the source write.
CREATE TRIGGER memory_embedding_facts_ai AFTER INSERT ON facts WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('fact', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_facts_au AFTER UPDATE ON facts BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'fact' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'fact' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'fact', new.id, 'upsert', 1, new.updated_at WHERE new.deleted_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_facts_ad AFTER DELETE ON facts BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'fact' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'fact' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_scenes_ai AFTER INSERT ON scenes WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('scene', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_scenes_au AFTER UPDATE ON scenes BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'scene' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'scene' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'scene', new.id, 'upsert', 1, new.updated_at WHERE new.deleted_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_scenes_ad AFTER DELETE ON scenes BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'scene' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'scene' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_tasks_ai AFTER INSERT ON tasks WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('task', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'task' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'task' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'task', new.id, 'upsert', 1, new.updated_at WHERE new.deleted_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_tasks_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'task' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'task' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_projects_ai AFTER INSERT ON projects WHEN new.archived_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('project', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_projects_au AFTER UPDATE ON projects BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'project' AND object_id = new.id AND new.archived_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'project' AND object_id = new.id AND new.archived_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'project', new.id, 'upsert', 1, new.updated_at WHERE new.archived_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_projects_ad AFTER DELETE ON projects BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'project' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'project' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_decisions_ai AFTER INSERT ON decisions WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('decision', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_decisions_au AFTER UPDATE ON decisions BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'decision' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'decision' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'decision', new.id, 'upsert', 1, new.updated_at WHERE new.deleted_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_decisions_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'decision' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'decision' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_people_ai AFTER INSERT ON people WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_embedding_queue VALUES ('person', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_people_au AFTER UPDATE ON people BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'person' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  DELETE FROM memory_embedding_queue WHERE object_type = 'person' AND object_id = new.id AND new.deleted_at IS NOT NULL;
  INSERT INTO memory_embedding_queue SELECT 'person', new.id, 'upsert', 1, new.updated_at WHERE new.deleted_at IS NULL
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_people_ad AFTER DELETE ON people BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'person' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'person' AND object_id = old.id;
END;

CREATE TRIGGER memory_embedding_reports_ai AFTER INSERT ON reports BEGIN
  INSERT INTO memory_embedding_queue VALUES ('report', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_reports_au AFTER UPDATE ON reports BEGIN
  INSERT INTO memory_embedding_queue VALUES ('report', new.id, 'upsert', 1, new.updated_at)
  ON CONFLICT(object_type, object_id) DO UPDATE SET operation = 'upsert', generation = generation + 1, enqueued_at = excluded.enqueued_at;
END;
CREATE TRIGGER memory_embedding_reports_ad AFTER DELETE ON reports BEGIN
  DELETE FROM memory_embeddings WHERE object_type = 'report' AND object_id = old.id;
  DELETE FROM memory_embedding_queue WHERE object_type = 'report' AND object_id = old.id;
END;
