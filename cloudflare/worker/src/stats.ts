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

export type DefaultModelKind = "language" | "multimodal";
export type DefaultModelCallStatus = "success" | "failure";

export interface DailyModelStats {
  date: string;
  totalCalls: number;
  successes: number;
  failures: number;
  languageCalls: number;
  multimodalCalls: number;
  callsByTask: Record<string, number>;
  installationHashes: string[];
}

export interface ModelInstallationStats {
  installationHash: string;
  totalCalls: number;
  successes: number;
  failures: number;
  languageCalls: number;
  multimodalCalls: number;
  callsByTask: Record<string, number>;
  firstSeenAt: string;
  lastSeenAt: string;
  clientVersion: string;
}

export async function hmacInstallationId(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function recordDefaultModelCall(
  stats: D1Database,
  hashSecret: string,
  input: {
    date: string;
    installationId: string;
    kind: DefaultModelKind;
    taskType: string;
    status: DefaultModelCallStatus;
    clientVersion: string;
  }
): Promise<void> {
  const installationHash = await hmacInstallationId(input.installationId, hashSecret);
  await recordDefaultModelCallByHash(stats, {
    date: input.date,
    installationHash,
    kind: input.kind,
    taskType: input.taskType,
    status: input.status,
    clientVersion: input.clientVersion,
  });
}

export async function recordDefaultModelCallByHash(
  stats: D1Database,
  input: {
    date: string;
    installationHash: string;
    kind: DefaultModelKind;
    taskType: string;
    status: DefaultModelCallStatus;
    clientVersion: string;
  }
): Promise<void> {
  await stats.batch(buildDefaultModelCallStatements(stats, input));
}

export function buildDefaultModelCallStatements(
  stats: D1Database,
  input: {
    date: string;
    installationHash: string;
    kind: DefaultModelKind;
    taskType: string;
    status: DefaultModelCallStatus;
    clientVersion: string;
  }
): D1PreparedStatement[] {
  const now = new Date().toISOString();
  const success = input.status === "success" ? 1 : 0;
  const failure = input.status === "failure" ? 1 : 0;
  const language = input.kind === "language" ? 1 : 0;
  const multimodal = input.kind === "multimodal" ? 1 : 0;
  return [
    stats.prepare(
      `INSERT INTO model_daily_stats (date, total_calls, successes, failures, language_calls, multimodal_calls)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         total_calls = total_calls + 1,
         successes = successes + excluded.successes,
         failures = failures + excluded.failures,
         language_calls = language_calls + excluded.language_calls,
         multimodal_calls = multimodal_calls + excluded.multimodal_calls`
    ).bind(input.date, success, failure, language, multimodal),
    stats.prepare(
      `INSERT INTO model_daily_tasks (date, task, calls) VALUES (?, ?, 1)
       ON CONFLICT(date, task) DO UPDATE SET calls = calls + 1`
    ).bind(input.date, input.taskType),
    stats.prepare(
      `INSERT OR IGNORE INTO model_daily_installations (date, installation_hash) VALUES (?, ?)`
    ).bind(input.date, input.installationHash),
    stats.prepare(
      `INSERT INTO model_installations
         (installation_hash, total_calls, successes, failures, language_calls, multimodal_calls, first_seen_at, last_seen_at, client_version)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(installation_hash) DO UPDATE SET
         total_calls = total_calls + 1,
         successes = successes + excluded.successes,
         failures = failures + excluded.failures,
         language_calls = language_calls + excluded.language_calls,
         multimodal_calls = multimodal_calls + excluded.multimodal_calls,
         last_seen_at = excluded.last_seen_at,
         client_version = excluded.client_version`
    ).bind(input.installationHash, success, failure, language, multimodal, now, now, input.clientVersion),
    stats.prepare(
      `INSERT INTO model_installation_tasks (installation_hash, task, calls) VALUES (?, ?, 1)
       ON CONFLICT(installation_hash, task) DO UPDATE SET calls = calls + 1`
    ).bind(input.installationHash, input.taskType),
  ];
}

function emptyDailyModelStats(date: string): DailyModelStats {
  return {
    date,
    totalCalls: 0,
    successes: 0,
    failures: 0,
    languageCalls: 0,
    multimodalCalls: 0,
    callsByTask: {},
    installationHashes: [],
  };
}

export async function getDefaultModelStatsHistory(stats: D1Database): Promise<DailyModelStats[]> {
  const daily = await stats.prepare(
    `SELECT date, total_calls, successes, failures, language_calls, multimodal_calls
     FROM model_daily_stats ORDER BY date`
  ).all<{ date: string; total_calls: number; successes: number; failures: number; language_calls: number; multimodal_calls: number }>();
  const tasks = await stats.prepare(
    `SELECT date, task, calls FROM model_daily_tasks ORDER BY date, task`
  ).all<{ date: string; task: string; calls: number }>();
  const installations = await stats.prepare(
    `SELECT date, installation_hash FROM model_daily_installations ORDER BY date, installation_hash`
  ).all<{ date: string; installation_hash: string }>();
  const byDate = new Map<string, DailyModelStats>();
  for (const row of daily.results) {
    byDate.set(row.date, {
      date: row.date,
      totalCalls: row.total_calls,
      successes: row.successes,
      failures: row.failures,
      languageCalls: row.language_calls,
      multimodalCalls: row.multimodal_calls,
      callsByTask: {},
      installationHashes: [],
    });
  }
  for (const row of tasks.results) {
    const day = byDate.get(row.date) ?? emptyDailyModelStats(row.date);
    day.callsByTask[row.task] = row.calls;
    byDate.set(row.date, day);
  }
  for (const row of installations.results) {
    const day = byDate.get(row.date) ?? emptyDailyModelStats(row.date);
    day.installationHashes.push(row.installation_hash);
    byDate.set(row.date, day);
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export async function getDefaultModelInstallationStats(
  stats: D1Database
): Promise<ModelInstallationStats[]> {
  const installations = await stats.prepare(
    `SELECT installation_hash, total_calls, successes, failures, language_calls, multimodal_calls,
            first_seen_at, last_seen_at, client_version
     FROM model_installations ORDER BY last_seen_at DESC`
  ).all<{
    installation_hash: string; total_calls: number; successes: number; failures: number;
    language_calls: number; multimodal_calls: number; first_seen_at: string; last_seen_at: string; client_version: string;
  }>();
  const tasks = await stats.prepare(
    `SELECT installation_hash, task, calls FROM model_installation_tasks`
  ).all<{ installation_hash: string; task: string; calls: number }>();
  const callsByInstallation = new Map<string, Record<string, number>>();
  for (const row of tasks.results) {
    const calls = callsByInstallation.get(row.installation_hash) ?? {};
    calls[row.task] = row.calls;
    callsByInstallation.set(row.installation_hash, calls);
  }
  return installations.results.map((row) => ({
    installationHash: row.installation_hash,
    totalCalls: row.total_calls,
    successes: row.successes,
    failures: row.failures,
    languageCalls: row.language_calls,
    multimodalCalls: row.multimodal_calls,
    callsByTask: callsByInstallation.get(row.installation_hash) ?? {},
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    clientVersion: row.client_version,
  }));
}
