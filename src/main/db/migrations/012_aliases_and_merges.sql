-- 012_aliases_and_merges.sql
-- 人物 / 项目 / 任务 / 决策的别名映射（aliases）+ 合并审计表
--
-- 背景：
-- - 大模型抽取时可能把同一个人识别成 N 个名字（如「陈章」「陈章（耀石锂电 hr）」「耀石锂电 hr」）
-- - 项目同理（「外包薪酬核算」「工资计算」「耀石锂电（薪资核算）」「耀石锂电」）
-- - 手动合并（cascadeMark.mergeObjects）后，需要把 from.name 记录到 to.aliases，
--   下次 Extractor / Linker prompt 注入 aliases 段，避免重复生成同义对象
--
-- 设计：
-- - aliases_json：JSON 字符串数组（TEXT，存 NULL 表示无别名）
--   - people / projects 两表加
--   - tasks / decisions MVP 不加（按需后续）
-- - object_merges：审计表，记录每次合并的 from/to/source/user
--   - 用于追溯历史、可能的撤销（虽然当前不提供撤销）
--   - 不参与业务逻辑查询

-- ============================================================================
-- 1) people.aliases_json
-- ============================================================================

ALTER TABLE people ADD COLUMN aliases_json TEXT;

-- ============================================================================
-- 2) projects.aliases_json
-- ============================================================================

ALTER TABLE projects ADD COLUMN aliases_json TEXT;

-- ============================================================================
-- 3) object_merges（合并审计表）
-- ============================================================================

CREATE TABLE object_merges (
  id TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,           -- 'project' / 'task' / 'person' / 'decision'
  from_id TEXT NOT NULL,               -- 被合并的来源对象 id
  from_name TEXT NOT NULL,             -- 合并时的来源名字（冗余，便于审计 / 别名学习）
  to_id TEXT NOT NULL,                 -- 合并到的目标对象 id
  to_name TEXT NOT NULL,               -- 合并时的目标名字
  source TEXT NOT NULL,                -- 'user_manual' / 'linker_suggestion'
  reason TEXT,                         -- 用户填的备注 / Linker 的合并理由
  rewritten_facts_count INTEGER NOT NULL DEFAULT 0,  -- 合并时被改写 projectHint/projectId 的 fact 数量
  rewritten_scenes_count INTEGER NOT NULL DEFAULT 0, -- 合并时被改写 entityNames 的 scene 数量
  created_at TEXT NOT NULL
);

CREATE INDEX idx_object_merges_to ON object_merges(to_id, object_type);
CREATE INDEX idx_object_merges_created_at ON object_merges(created_at);
