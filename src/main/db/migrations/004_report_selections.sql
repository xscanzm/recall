-- 004_report_selections.sql
-- Phase 2 Task 2.1：新增 report_selections 表（doc 19 第 12.2 节 / spec.md 行 1177-1193）
--
-- 用途：记录每次生成工作日报/周报时，用户勾选或系统预选的 timeline_block ids。
-- 工作日报必须记录 selected timeline block ids（spec 行 1193）。

CREATE TABLE IF NOT EXISTS report_selections (
  id TEXT PRIMARY KEY,
  date_key TEXT NOT NULL,
  report_type TEXT NOT NULL,
  selected_timeline_block_ids_json TEXT NOT NULL DEFAULT '[]',
  excluded_timeline_block_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_selections_date_type ON report_selections(date_key, report_type);
