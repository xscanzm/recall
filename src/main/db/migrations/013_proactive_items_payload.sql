-- 013_proactive_items_payload.sql
-- proactive_items 增加 payload_json 字段，用于存放类型相关自定义数据
--
-- 背景：
-- - Linker 输出的 mergeSuggestions 写入 proactive_items（type='merge_suggestion'）
-- - 需要存 from/to 详细信息：{objectType, fromId, toId, fromName, toName, reason, confidence}
-- - 不破坏已有字段，payload_json 可空，仅特定 type 写入

ALTER TABLE proactive_items ADD COLUMN payload_json TEXT;

-- 创建索引：便于按 type 列表（如 merge_suggestion）
CREATE INDEX IF NOT EXISTS idx_proactive_type_status ON proactive_items(type, status);
