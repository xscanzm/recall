-- 002_scene_task_decision_ids.sql
-- scenes 表新增 task_ids_json 和 decision_ids_json 字段
--
-- 背景：
-- - SceneBuilderOutputSchema 已要求模型输出 taskIds / decisionIds
-- - 但 001_initial_schema.sql 的 scenes 表未持久化这两个字段
-- - 本 migration 通过 ALTER TABLE 增量添加列，保留 migration 历史可追溯
--
-- 约束：
-- - 使用 ALTER TABLE（不修改 001）
-- - 默认值 '[]' 保证旧数据兼容
-- - 不修改其他表

ALTER TABLE scenes ADD COLUMN task_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scenes ADD COLUMN decision_ids_json TEXT NOT NULL DEFAULT '[]';
