-- 移除模型代理按 IP 的每日限流（0004 引入）。
-- 该限流（默认 200 次/天/IP）在桌面端造成大量 429（rate_limited），
-- 用户已确认彻底移除服务端限流；表结构一并清理。
DROP TABLE IF EXISTS model_proxy_rate_limits;
