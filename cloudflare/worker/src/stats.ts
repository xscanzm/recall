// 分发统计：只记录官网/下载/更新服务的聚合请求数，不包含客户端身份或内容。

export interface DailyDistributionStats {
  date: string;
  websiteVisits: number;
  websiteDownloadStarts: number;
  packageDownloadsByVersion: Record<string, number>;
  directPackageDownloadsByVersion: Record<string, number>;
  updateChecksByVersion: Record<string, number>;
  updatesAvailableByVersion: Record<string, number>;
}

type DistributionMetric =
  | "website_visit"
  | "website_download_start"
  | "package_download"
  | "direct_package_download"
  | "update_check"
  | "update_available";

const METRICS_PREFIX = "distribution:v1";

function metricKey(date: string, metric: DistributionMetric, version?: string): string {
  const suffix = version ? `:${encodeURIComponent(version)}` : "";
  return `${METRICS_PREFIX}:${date}:${metric}${suffix}`;
}

function emptyDailyDistributionStats(date: string): DailyDistributionStats {
  return {
    date,
    websiteVisits: 0,
    websiteDownloadStarts: 0,
    packageDownloadsByVersion: {},
    directPackageDownloadsByVersion: {},
    updateChecksByVersion: {},
    updatesAvailableByVersion: {},
  };
}

function incrementVersionMetric(target: Record<string, number>, version: string, count: number): void {
  target[version] = (target[version] ?? 0) + count;
}

function applyMetric(
  result: DailyDistributionStats,
  metric: DistributionMetric,
  version: string | undefined,
  value: number
): void {
  switch (metric) {
    case "website_visit":
      result.websiteVisits += value;
      break;
    case "website_download_start":
      result.websiteDownloadStarts += value;
      break;
    case "package_download":
      if (version) incrementVersionMetric(result.packageDownloadsByVersion, version, value);
      break;
    case "direct_package_download":
      if (version) incrementVersionMetric(result.directPackageDownloadsByVersion, version, value);
      break;
    case "update_check":
      if (version) incrementVersionMetric(result.updateChecksByVersion, version, value);
      break;
    case "update_available":
      if (version) incrementVersionMetric(result.updatesAvailableByVersion, version, value);
      break;
  }
}

/**
 * 记录一个聚合分发事件。
 *
 * KV 不提供原子自增；Recall 当前的早期流量下允许极端并发时出现少量低估。
 */
export async function recordDistributionMetric(
  stats: KVNamespace,
  date: string,
  metric: DistributionMetric,
  version?: string
): Promise<void> {
  const key = metricKey(date, metric, version);
  const current = Number.parseInt((await stats.get(key)) ?? "0", 10) || 0;
  await stats.put(key, String(current + 1));
}

/**
 * 读取某日的聚合分发统计。只扫描该日期的指标键，不会读取任何用户数据。
 */
export async function getDailyDistributionStats(
  stats: KVNamespace,
  date: string
): Promise<DailyDistributionStats> {
  const result = emptyDailyDistributionStats(date);
  const prefix = `${METRICS_PREFIX}:${date}:`;
  const listed = await stats.list({ prefix });
  const values = await Promise.all(
    listed.keys.map(async ({ name }) => ({
      name,
      value: Number.parseInt((await stats.get(name)) ?? "0", 10) || 0,
    }))
  );

  for (const { name, value } of values) {
    const suffix = name.slice(prefix.length);
    const separator = suffix.indexOf(":");
    const metric = (separator === -1 ? suffix : suffix.slice(0, separator)) as DistributionMetric;
    const encodedVersion = separator === -1 ? undefined : suffix.slice(separator + 1);
    const version = encodedVersion ? decodeURIComponent(encodedVersion) : undefined;

    applyMetric(result, metric, version, value);
  }

  return result;
}

/**
 * 读取全部已有分发统计并按日期重组。
 *
 * KV list 会分页返回；必须遍历至 list_complete 才能支持完整历史数据。
 */
export async function getDistributionStatsHistory(
  stats: KVNamespace
): Promise<DailyDistributionStats[]> {
  const keys: KVNamespaceListKey<unknown>[] = [];
  let cursor: string | undefined;

  do {
    const page = await stats.list({ prefix: `${METRICS_PREFIX}:`, cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const days = new Map<string, DailyDistributionStats>();
  for (let index = 0; index < keys.length; index += 50) {
    const batch = keys.slice(index, index + 50);
    const values = await Promise.all(
      batch.map(async ({ name }) => ({
        name,
        value: Number.parseInt((await stats.get(name)) ?? "0", 10) || 0,
      }))
    );

    for (const { name, value } of values) {
      const match = new RegExp(
        `^${METRICS_PREFIX.replace(/[:]/g, "\\:")}:(\\d{4}-\\d{2}-\\d{2}):([^:]+)(?::(.+))?$`
      ).exec(name);
      if (!match) continue;

      const [, date, metricName, encodedVersion] = match;
      const metric = metricName as DistributionMetric;
      if (![
        "website_visit",
        "website_download_start",
        "package_download",
        "direct_package_download",
        "update_check",
        "update_available",
      ].includes(metric)) {
        continue;
      }

      const day = days.get(date) ?? emptyDailyDistributionStats(date);
      const version = encodedVersion ? decodeURIComponent(encodedVersion) : undefined;
      applyMetric(day, metric, version, value);
      days.set(date, day);
    }
  }

  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}
