// 模型代理按 IP 的每日限流：D1 原子计数器。
//
// 与信息图代理的 KV read-modify-write 计数（takeInfographicRateLimit）不同，
// 这里用单条 `INSERT ... ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n` 原子自增：
// KV 的 get→put 两步在并发下会互相覆盖（极端并发可绕过限额），
// D1 单语句原子执行不存在该问题，自增与超限判断在同一语句内完成。

export const MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT = 200;
export const MODEL_PROXY_RETRY_AFTER_SECONDS = 86400;

/**
 * 限流键里的 IP 归一化：
 * - IPv4 原样返回；
 * - IPv6 按 /64 前缀归一（取前 64 位，即前 4 个 16 位段，其余归零），
 *   避免同一前缀下的不同主机被拆成多个计数器；
 * - 空值/缺失回退 "unknown"。
 */
export function normalizeIpForRateLimit(ip: string): string {
  const trimmed = (ip ?? "").trim();
  if (!trimmed) return "unknown";
  if (!trimmed.includes(":")) return trimmed.slice(0, 80); // IPv4
  const withoutZone = trimmed.includes("%")
    ? trimmed.slice(0, trimmed.indexOf("%"))
    : trimmed;
  const groups = withoutZone.toLowerCase().split(":");
  const head = groups.slice(0, 4).map((group) => (group === "" ? "0" : group));
  while (head.length < 4) head.push("0");
  return `${head.join(":")}::/64`;
}

/** 解析 MODEL_PROXY_DAILY_LIMIT_PER_IP；未配置或非法值回退默认 200，且至少为 1。 */
export function resolveModelProxyDailyLimit(raw: string | undefined): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(value) || value < 1) {
    return MODEL_PROXY_DAILY_LIMIT_PER_IP_DEFAULT;
  }
  return value;
}

/** 与 index.ts 的 currentDateKey 一致：按中国标准时间分桶。 */
function chinaDateKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * D1 原子自增并判断是否超限（先自增再比较）。
 * 第 1..limit 次调用返回 true，第 limit+1 次起返回 false。
 */
export async function takeModelProxyRateLimit(
  stats: D1Database,
  ip: string,
  limit: number
): Promise<boolean> {
  const row = await stats.prepare(
    `INSERT INTO model_proxy_rate_limits (day, ip, n) VALUES (?, ?, 1)
     ON CONFLICT(day, ip) DO UPDATE SET n = n + 1
     RETURNING n`
  ).bind(chinaDateKey(), ip).first<{ n: number }>();
  return (row?.n ?? 1) <= limit;
}
