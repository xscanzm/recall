-- 010_reports_project_id.sql
-- 为 reports 表添加 project_id 列，用于历史报告按项目过滤
--
-- reports.type 字段在 001_initial_schema.sql 中已定义为 TEXT NOT NULL，
-- 本迁移新增 project_id 列（可空），用于存储报告关联的项目 ID。
--
-- 兼容性：
--   - 旧数据 project_id 为 NULL，不影响现有查询
--   - 新数据可在生成报告时传入 projectId，写入 project_id 列
--   - 历史报告 Tab 的项目过滤器基于此列进行精确匹配

ALTER TABLE reports ADD COLUMN project_id TEXT;
