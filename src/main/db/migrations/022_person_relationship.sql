-- 022_person_relationship.sql
-- 人物关系字段：用户与该人物的关系（如"同事""客户""朋友"）
-- 仅由用户手动编辑，LLM 不自动抽取
ALTER TABLE people ADD COLUMN relationship TEXT;
