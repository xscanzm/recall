-- 014_model_jobs_debug_fields.sql
-- 调试开关与管道检查器：给 model_jobs 表新增调试字段
--
-- 用途：
-- - raw_input_json：完整 prompt 文本上下文（系统提示 + user message 文本，不含图片 base64）
--   仅在用户开启「调试模式 + 记录完整模型输入输出」时写入，超长截断到 64KB
-- - debug_events_json：JSON 数组，记录各层（L0/L1/L2/L3/proactive）的丢弃/跳过事件
--   仅在用户开启「调试模式」时写入
--
-- 兼容性：两列均可空，默认 NULL，旧数据不受影响，model_jobs 仍正常记录 status/errorCode/outputJson

ALTER TABLE model_jobs ADD COLUMN raw_input_json TEXT;
ALTER TABLE model_jobs ADD COLUMN debug_events_json TEXT;
