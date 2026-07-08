-- 008_observations_facts_v2_fields.sql
-- Phase 2 体验升级：为 observations 和 facts 表新增 V2 体验字段
--
-- 来源：doc 20 第 3-4 节 / spec.md Phase 2
--   - ObserverOutputV2 新增 userFacingSummary / likelyWorkPurpose / privacyRisk / reportableSignal
--   - ExtractorFactV2 新增 displayUse / reportable / privateRisk / userValue
--
-- 所有新增列均为可空（NULL），保证已有数据与 V1 写入路径不受影响。
-- JSON 字段（display_use）以 TEXT 存储，Repository 层做 stringify/parse。

-- ============================================================================
-- observations 表 V2 字段
-- ============================================================================
ALTER TABLE observations ADD COLUMN user_facing_summary TEXT;
ALTER TABLE observations ADD COLUMN likely_work_purpose TEXT;
ALTER TABLE observations ADD COLUMN privacy_risk TEXT;
ALTER TABLE observations ADD COLUMN reportable_signal TEXT;

-- ============================================================================
-- facts 表 V2 字段
-- ============================================================================
ALTER TABLE facts ADD COLUMN display_use TEXT;       -- JSON array
ALTER TABLE facts ADD COLUMN reportable INTEGER;     -- boolean 0/1
ALTER TABLE facts ADD COLUMN private_risk TEXT;
ALTER TABLE facts ADD COLUMN user_value TEXT;
