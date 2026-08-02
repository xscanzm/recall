-- 模型代理按 IP 的每日限流计数器（D1 原子自增）。
--
-- 写入型调用（/api/model/language/* 完成调用、/api/model/multimodal/jobs 提交）在代理前
-- 先执行单条 INSERT ... ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n 原子自增；
-- 状态轮询端点（/api/model/multimodal/jobs/:id/status）不计数。
-- day 按中国标准时间分桶（与 model_daily_stats 一致）。
CREATE TABLE IF NOT EXISTS model_proxy_rate_limits (
  day TEXT NOT NULL,
  ip TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip)
);
