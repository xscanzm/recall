-- 006_unfinished_threads.sql
-- Phase 2 Task 2.7：新增 unfinished_threads 表（doc 20 第 6 节 / spec.md 行 813-821）
--
-- 用途：存储 Judge worker V2 输出的待收尾事项（unfinishedThreads）。
-- 每个 thread 必须有来源（sourceFactIds / sourceTimelineBlockIds）。
-- 同一 date_key 重复生成时由应用层先删除旧 threads 再写入新 threads
-- （schema 不设唯一约束，便于按 date_key 批量替换，与 timeline_blocks 一致）。
--
-- 字段说明：
-- - priority：枚举 'high' / 'medium' / 'low'（与 proactive_items.priority 数值不同）
-- - status：'open' | 'done' | 'snoozed' | 'ignored'
-- - project_name：可选，关联项目名称（未关联时 NULL）
-- - last_seen_at：可选，最后被 Judge 观察到的时间
-- - date_key：YYYY-MM-DD，用于按天替换与查询
-- - confidence：[0, 1]，LLM 输出置信度

CREATE TABLE IF NOT EXISTS unfinished_threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggested_next_action TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  project_name TEXT,
  last_seen_at TEXT,
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_timeline_block_ids_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'open',
  date_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_unfinished_threads_date_key ON unfinished_threads(date_key);
CREATE INDEX IF NOT EXISTS idx_unfinished_threads_status ON unfinished_threads(status);
