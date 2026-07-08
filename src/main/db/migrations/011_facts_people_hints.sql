-- 011_facts_people_hints.sql
-- Linker 输入链路补全：为 facts 表新增 people_hints_json 列
--
-- 背景（2026-07-07 修复）：
-- - ExtractorOutputV2 schema 有 peopleHints 字段（LLM 输出）
-- - Fact 领域模型 / SQL 表 / Repository.create / LinkerWorker.toFactSummary 全部缺这个字段
-- - 导致 LLM 抽取 fact 时正确识别的人名（"hz 蓝佳奇"等）在写入 fact 时被丢弃
-- - Linker 看不到 peopleHints，无法触发 newObjects[type=person]，人物板块永远空
-- - 修复：补 SQL 列 + Fact 模型 + Repository.create / mapRow + LinkerWorker.toFactSummary
--
-- 设计：
-- - JSON 数组存 TEXT（与 project_hint 单值字符串区分；people_hints 是数组）
-- - NULL 表示未抽取（V1 路径写入时为 null）
-- - 兼容已有数据：只 ALTER，不修改任何旧行

ALTER TABLE facts ADD COLUMN people_hints_json TEXT; -- JSON array of strings
