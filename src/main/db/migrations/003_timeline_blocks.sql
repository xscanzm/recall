-- 003_timeline_blocks.sql
-- Phase 2 Task 2.1：新增 timeline_blocks 表（doc 19 第 12.1 节 / spec.md 行 1147-1175）
--
-- 用途：存储 TimelineBuilder worker 生成的今日时间轴片段。
-- 同一 date_key 重复生成时由应用层先删除旧 blocks 再写入新 blocks
-- （schema 不设唯一约束，便于按 date_key 批量替换）。

CREATE TABLE IF NOT EXISTS timeline_blocks (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT NOT NULL,
  project_ids_json TEXT NOT NULL DEFAULT '[]',
  project_names_json TEXT NOT NULL DEFAULT '[]',
  highlights_json TEXT NOT NULL DEFAULT '[]',
  generated_tasks_json TEXT NOT NULL DEFAULT '[]',
  generated_decisions_json TEXT NOT NULL DEFAULT '[]',
  reportable INTEGER NOT NULL DEFAULT 0,
  private_risk TEXT NOT NULL DEFAULT 'low',
  source_scene_ids_json TEXT NOT NULL DEFAULT '[]',
  source_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  source_observation_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_blocks_date_key ON timeline_blocks(date_key);
