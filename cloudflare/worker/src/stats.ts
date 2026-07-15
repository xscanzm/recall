// 客户端版本检查统计：按版本+日期分桶 KV 计数

/**
 * 记录一次客户端版本检查请求
 * - 主键：stats:{version}:{YYYY-MM-DD} → 递增计数
 * - 同时更新 stats:summary 聚合 JSON：按版本汇总
 *
 * 简化实现：使用 read-modify-write，并发冲突容忍 occasional 丢失。
 * 真正高并发场景可换用 Durable Object 或 Analytics Engine。
 *
 * @param stats KV 命名空间（绑定名 STATS）
 * @param version 客户端上报的版本号
 */
export async function recordPing(
  stats: KVNamespace,
  version: string
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD（UTC）
  const dailyKey = `stats:${version}:${date}`;
  const summaryKey = "stats:summary";

  // 并发读取两个 key 的当前值
  const [dailyRaw, summaryRaw] = await Promise.all([
    stats.get(dailyKey),
    stats.get(summaryKey),
  ]);

  // 递增日计数
  const dailyCount = (dailyRaw ? parseInt(dailyRaw, 10) : 0) + 1;
  // 更新汇总（按版本汇总）
  let summary: Record<string, number> = {};
  if (summaryRaw) {
    try {
      summary = JSON.parse(summaryRaw) as Record<string, number>;
    } catch {
      summary = {};
    }
  }
  summary[version] = (summary[version] ?? 0) + 1;

  // 并发写回
  await Promise.all([
    stats.put(dailyKey, String(dailyCount)),
    stats.put(summaryKey, JSON.stringify(summary)),
  ]);
}

/**
 * 读取汇总统计（按版本汇总的总检查次数）
 *
 * @param stats KV 命名空间（绑定名 STATS）
 * @returns 版本号 → 检查次数 的映射；无数据时返回空对象
 */
export async function getStatsSummary(
  stats: KVNamespace
): Promise<Record<string, number>> {
  const raw = await stats.get("stats:summary");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
}
