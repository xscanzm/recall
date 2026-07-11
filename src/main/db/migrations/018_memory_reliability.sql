-- 018_memory_reliability.sql
-- Durable batch stage checkpoints and idempotent memory derivations.

ALTER TABLE capture_batches ADD COLUMN observer_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE capture_batches ADD COLUMN episode_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE capture_batches ADD COLUMN atom_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE capture_batches ADD COLUMN linker_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE capture_batches ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE facts ADD COLUMN source_episode_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE facts ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE facts ADD COLUMN generation_path TEXT;
ALTER TABLE facts ADD COLUMN generation_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE facts ADD COLUMN derivation_key TEXT;

ALTER TABLE scenes ADD COLUMN derivation_key TEXT;
ALTER TABLE scenes ADD COLUMN derivation_version INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX idx_facts_derivation_key
  ON facts(derivation_key) WHERE derivation_key IS NOT NULL;
CREATE UNIQUE INDEX idx_scenes_derivation_key
  ON scenes(derivation_key) WHERE derivation_key IS NOT NULL;

-- Existing duplicate edges carry the same natural relationship. Keep the oldest row.
DELETE FROM memory_edges
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM memory_edges
  GROUP BY from_type, from_id, to_type, to_id, relation_type
);

CREATE UNIQUE INDEX idx_memory_edges_natural_key
  ON memory_edges(from_type, from_id, to_type, to_id, relation_type);
