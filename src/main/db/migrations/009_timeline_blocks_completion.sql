-- 009_timeline_blocks_completion.sql
-- Phase 2 Task B4：为 timeline_blocks 表补齐 privateRiskReason 与 confidence 字段
--
-- 来源：spec.md 行 1170-1175
--   TimelineBlock 类型（shared/types.ts）已包含 privateRiskReason? 和 confidence? 字段，
--   但 timeline_blocks 表未持久化这两列，导致 LLM 输出的这两个字段在落库后丢失。
--   本迁移补齐这两列（均可空），Repository 层同步更新读写逻辑。

ALTER TABLE timeline_blocks ADD COLUMN private_risk_reason TEXT;
ALTER TABLE timeline_blocks ADD COLUMN confidence REAL;
