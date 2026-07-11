CREATE TABLE timeline_build_checkpoints (
  date_key TEXT PRIMARY KEY,
  processed_through TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

WITH resolved(block_id, observation_id) AS (
  SELECT tb.id, direct.value FROM timeline_blocks tb, json_each(tb.source_observation_ids_json) direct
  UNION
  SELECT tb.id, scene_observation.value FROM timeline_blocks tb
    JOIN json_each(tb.source_scene_ids_json) scene_source JOIN scenes s ON s.id = scene_source.value
    JOIN json_each(s.observation_ids_json) scene_observation
  UNION
  SELECT tb.id, fact_observation.value FROM timeline_blocks tb
    JOIN json_each(tb.source_fact_ids_json) fact_source JOIN facts f ON f.id = fact_source.value
    JOIN json_each(f.source_observation_ids_json) fact_observation
  UNION
  SELECT tb.id, episode_observation.value FROM timeline_blocks tb
    JOIN json_each(tb.source_fact_ids_json) fact_source JOIN facts f ON f.id = fact_source.value
    JOIN json_each(f.source_episode_ids_json) episode_source JOIN scenes s ON s.id = episode_source.value
    JOIN json_each(s.observation_ids_json) episode_observation
), bounds AS (
  SELECT resolved.block_id, MIN(o.captured_at) AS start_at, MAX(o.captured_at) AS end_at
  FROM resolved JOIN observations o ON o.id = resolved.observation_id GROUP BY resolved.block_id
)
UPDATE timeline_blocks
SET start_at = (SELECT start_at FROM bounds WHERE block_id = timeline_blocks.id),
    end_at = (SELECT end_at FROM bounds WHERE block_id = timeline_blocks.id),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (SELECT block_id FROM bounds);

WITH resolved(block_id) AS (
  SELECT tb.id FROM timeline_blocks tb JOIN json_each(tb.source_observation_ids_json) x JOIN observations o ON o.id = x.value
  UNION
  SELECT tb.id FROM timeline_blocks tb JOIN json_each(tb.source_scene_ids_json) x JOIN scenes s ON s.id = x.value
    JOIN json_each(s.observation_ids_json) y JOIN observations o ON o.id = y.value
  UNION
  SELECT tb.id FROM timeline_blocks tb JOIN json_each(tb.source_fact_ids_json) x JOIN facts f ON f.id = x.value
    JOIN json_each(f.source_observation_ids_json) y JOIN observations o ON o.id = y.value
  UNION
  SELECT tb.id FROM timeline_blocks tb JOIN json_each(tb.source_fact_ids_json) x JOIN facts f ON f.id = x.value
    JOIN json_each(f.source_episode_ids_json) e JOIN scenes s ON s.id = e.value
    JOIN json_each(s.observation_ids_json) y JOIN observations o ON o.id = y.value
)
DELETE FROM timeline_blocks WHERE id NOT IN (SELECT block_id FROM resolved);

-- Continue incremental processing from the latest verified user-activity time.
-- This prevents the first post-upgrade build from regenerating the whole day.
INSERT INTO timeline_build_checkpoints (date_key, processed_through, updated_at)
SELECT date_key, MAX(end_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM timeline_blocks
GROUP BY date_key
HAVING MAX(end_at) IS NOT NULL;
