// Recall 桌面端更新分发 Worker 主入口
// 同时提供信息图代理，避免把共享图像服务密钥编译进桌面客户端。

import { compareVersions } from "./version";
import { readManifest } from "./manifest";
import {
  getDailyDistributionStats,
  getDistributionStatsHistory,
  recordDistributionMetric,
  type DailyDistributionStats,
  getDefaultModelInstallationStats,
  getDefaultModelStatsHistory,
  recordDefaultModelCall,
  type DailyModelStats,
  type ModelInstallationStats,
} from "./stats";
import {
  cleanupExpiredDefaultMultimodalJobs,
  consumeDefaultMultimodalJobs,
  getDefaultMultimodalJob,
  submitDefaultMultimodalJob,
  type ModelClientMetadata,
} from "./modelAsyncJobs";

/** CORS 允许的方法 */
const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
/** CORS 允许的请求头 */
const CORS_ALLOWED_HEADERS = "Authorization, Content-Type, X-Client-Version, X-Recall-Installation-Id, X-Recall-Task-Type, X-Recall-Client-Version, X-Recall-Idempotency-Key";
const WEBSITE_ORIGIN = "https://recall.ppclaw.online";
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CHINA_TIME_OFFSET_MS = 8 * 60 * 60 * 1000;
const MODEL_PROXY_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MODEL_TASK_TYPE_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,79}$/i;
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_IDEMPOTENCY_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/i;
const ASYNC_MODEL_JOB_ID_PATTERN = /^mmj_[0-9a-f-]{36}$/i;

/**
 * 给响应附加 CORS 头
 */
function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  // 桌面端无 Origin，浏览器有 Origin —— 允许所有
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", CORS_ALLOWED_METHODS);
  headers.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * 构造 JSON 响应（统一 Content-Type 与 Cache-Control）
 */
function jsonResponse(body: unknown, status: number = 200): Response {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
  return withCors(response);
}

function currentDateKey(): string {
  // Worker 运行时使用 UTC；分发统计面向中文运营，按中国标准时间分桶。
  return new Date(Date.now() + CHINA_TIME_OFFSET_MS).toISOString().slice(0, 10);
}

function isWebsiteRequest(request: Request): boolean {
  return request.headers.get("Origin") === WEBSITE_ORIGIN;
}

/**
 * 常数时间字符串比较。
 *
 * 直接用 === 比较密钥会在不匹配的第一个字节就返回，比较耗时随「猜对的前缀长度」
 * 变化，理论上可被逐字节爆破。这里先各自 SHA-256 成定长摘要再逐字节异或累加：
 * - 定长：耗时不泄漏原始长度；
 * - 全量遍历：不提前 return，耗时不泄漏第一个差异位置。
 */
async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

async function isStatsReadAuthorized(request: Request, env: Env): Promise<boolean> {
  const token = env.STATS_READ_TOKEN?.trim();
  if (!token) return false;
  const provided = request.headers.get("Authorization");
  if (!provided) return false;
  return constantTimeEquals(provided, `Bearer ${token}`);
}

async function isStatsAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  const username = env.STATS_ADMIN_USERNAME?.trim();
  const password = env.STATS_ADMIN_PASSWORD;
  const authorization = request.headers.get("Authorization");
  if (!username || !password || !authorization?.startsWith("Basic ")) return false;

  let credentials: string;
  try {
    credentials = atob(authorization.slice("Basic ".length));
  } catch {
    return false;
  }
  const separator = credentials.indexOf(":");
  if (separator === -1) return false;

  // 两个比较都要跑完再合并结果：用 && 会在用户名错时直接短路，
  // 泄漏「用户名是否猜对」这一位信息。
  const [userMatches, passwordMatches] = await Promise.all([
    constantTimeEquals(credentials.slice(0, separator), username),
    constantTimeEquals(credentials.slice(separator + 1), password),
  ]);
  return userMatches && passwordMatches;
}

function statsLoginRequired(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Recall Stats", charset="UTF-8"',
    },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function sumMetricValues(values: Record<string, number>): number {
  return Object.values(values).reduce((sum, value) => sum + value, 0);
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function emptyDailyStats(date: string): DailyDistributionStats {
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

function mergeMetricValues(target: Record<string, number>, source: Record<string, number>): void {
  for (const [version, count] of Object.entries(source)) {
    target[version] = (target[version] ?? 0) + count;
  }
}

function aggregateDailyStats(days: DailyDistributionStats[]): DailyDistributionStats {
  const result = emptyDailyStats("all");
  for (const day of days) {
    result.websiteVisits += day.websiteVisits;
    result.websiteDownloadStarts += day.websiteDownloadStarts;
    mergeMetricValues(result.packageDownloadsByVersion, day.packageDownloadsByVersion);
    mergeMetricValues(result.directPackageDownloadsByVersion, day.directPackageDownloadsByVersion);
    mergeMetricValues(result.updateChecksByVersion, day.updateChecksByVersion);
    mergeMetricValues(result.updatesAvailableByVersion, day.updatesAvailableByVersion);
  }
  return result;
}

function fillDateRange(
  history: DailyDistributionStats[],
  startDate: string,
  endDate: string
): DailyDistributionStats[] {
  const existing = new Map(history.map((day) => [day.date, day]));
  const days: DailyDistributionStats[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
    days.push(existing.get(date) ?? emptyDailyStats(date));
  }
  return days;
}

type StatsRange = "7" | "30" | "all";

function selectedRange(value: string | null): StatsRange {
  return value === "30" || value === "all" ? value : "7";
}

function renderVersionRows(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([left], [right]) => right.localeCompare(left));
  if (entries.length === 0) {
    return '<tr><td colspan="2" class="empty">暂无数据</td></tr>';
  }
  return entries
    .map(([version, count]) => `<tr><td>${escapeHtml(version)}</td><td>${count}</td></tr>`)
    .join("");
}

function renderTrendChart(days: DailyDistributionStats[]): string {
  const width = 960;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 42, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...days.flatMap((day) => [day.websiteVisits, day.websiteDownloadStarts]));
  const step = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(12, step * 0.32));
  const labelsEvery = days.length > 30 ? Math.ceil(days.length / 8) : Math.max(1, Math.ceil(days.length / 7));
  const bars = days
    .map((day, index) => {
      const center = padding.left + step * index + step / 2;
      const visitHeight = (day.websiteVisits / maximum) * plotHeight;
      const downloadHeight = (day.websiteDownloadStarts / maximum) * plotHeight;
      const label = index % labelsEvery === 0 || index === days.length - 1
        ? `<text x="${center}" y="${height - 14}" text-anchor="middle">${escapeHtml(day.date.slice(5))}</text>`
        : "";
      return `<rect x="${center - barWidth - 1}" y="${padding.top + plotHeight - visitHeight}" width="${barWidth}" height="${visitHeight}" fill="#1d6b58" /><rect x="${center + 1}" y="${padding.top + plotHeight - downloadHeight}" width="${barWidth}" height="${downloadHeight}" fill="#c6782a" />${label}`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日官网访问和下载点击趋势"><line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#b9c5c0" /><line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#b9c5c0" /><text x="${padding.left - 8}" y="${padding.top + 5}" text-anchor="end">${maximum}</text><text x="${padding.left - 8}" y="${padding.top + plotHeight}" text-anchor="end">0</text>${bars}</svg>`;
}

function emptyModelStats(date: string): DailyModelStats {
  return { date, totalCalls: 0, successes: 0, failures: 0, languageCalls: 0, multimodalCalls: 0, callsByTask: {}, installationHashes: [] };
}

function fillModelDateRange(history: DailyModelStats[], startDate: string, endDate: string): DailyModelStats[] {
  const existing = new Map(history.map((day) => [day.date, day]));
  const days: DailyModelStats[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) {
    days.push(existing.get(date) ?? emptyModelStats(date));
  }
  return days;
}

function aggregateModelStats(days: DailyModelStats[]): DailyModelStats {
  const result = emptyModelStats("all");
  const installations = new Set<string>();
  for (const day of days) {
    result.totalCalls += day.totalCalls;
    result.successes += day.successes;
    result.failures += day.failures;
    result.languageCalls += day.languageCalls;
    result.multimodalCalls += day.multimodalCalls;
    mergeMetricValues(result.callsByTask, day.callsByTask);
    for (const hash of day.installationHashes) installations.add(hash);
  }
  result.installationHashes = [...installations];
  return result;
}

function renderModelTaskRows(values: Record<string, number>): string {
  const entries = Object.entries(values).sort((left, right) => right[1] - left[1]);
  if (entries.length === 0) return '<tr><td colspan="2" class="empty">暂无数据</td></tr>';
  return entries.map(([task, count]) => `<tr><td>${escapeHtml(task)}</td><td>${count}</td></tr>`).join("");
}

function renderInstallationRows(values: ModelInstallationStats[]): string {
  if (values.length === 0) return '<tr><td colspan="5" class="empty">暂无数据</td></tr>';
  return values.slice(0, 100).map((item) => {
    const lastSeenAt = new Date(item.lastSeenAt);
    const chinaTime = Number.isNaN(lastSeenAt.getTime())
      ? item.lastSeenAt
      : new Date(lastSeenAt.getTime() + CHINA_TIME_OFFSET_MS).toISOString().slice(0, 16).replace("T", " ");
    return `<tr><td><code>${escapeHtml(item.installationHash.slice(0, 12))}</code></td><td>${escapeHtml(item.clientVersion)}</td><td>${item.totalCalls}</td><td>${item.failures}</td><td>${escapeHtml(chinaTime)}</td></tr>`;
  }).join("");
}

function renderModelTrendChart(days: DailyModelStats[]): string {
  const width = 960;
  const height = 260;
  const padding = { top: 18, right: 18, bottom: 42, left: 42 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(1, ...days.flatMap((day) => [day.totalCalls, day.installationHashes.length]));
  const step = plotWidth / Math.max(days.length, 1);
  const barWidth = Math.max(2, Math.min(12, step * 0.32));
  const labelsEvery = days.length > 30 ? Math.ceil(days.length / 8) : Math.max(1, Math.ceil(days.length / 7));
  const bars = days.map((day, index) => {
    const center = padding.left + step * index + step / 2;
    const callsHeight = (day.totalCalls / maximum) * plotHeight;
    const devicesHeight = (day.installationHashes.length / maximum) * plotHeight;
    const label = index % labelsEvery === 0 || index === days.length - 1 ? `<text x="${center}" y="${height - 14}" text-anchor="middle">${escapeHtml(day.date.slice(5))}</text>` : "";
    return `<rect x="${center - barWidth - 1}" y="${padding.top + plotHeight - callsHeight}" width="${barWidth}" height="${callsHeight}" fill="#1d6b58" /><rect x="${center + 1}" y="${padding.top + plotHeight - devicesHeight}" width="${barWidth}" height="${devicesHeight}" fill="#a4553f" />${label}`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日默认模型调用和活跃安装趋势"><line x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${width - padding.right}" y2="${padding.top + plotHeight}" stroke="#b9c5c0" /><line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" stroke="#b9c5c0" /><text x="${padding.left - 8}" y="${padding.top + 5}" text-anchor="end">${maximum}</text><text x="${padding.left - 8}" y="${padding.top + plotHeight}" text-anchor="end">0</text>${bars}</svg>`;
}

function statsPageResponse(
  history: DailyDistributionStats[],
  modelHistory: DailyModelStats[],
  installationStats: ModelInstallationStats[],
  endDate: string,
  range: StatsRange
): Response {
  const allStats = aggregateDailyStats(history);
  const firstDate = history[0]?.date ?? endDate;
  const startDate = range === "all" ? firstDate : shiftDate(endDate, -(Number(range) - 1));
  const visibleDays = fillDateRange(history, startDate, endDate);
  const stats = aggregateDailyStats(visibleDays);
  const websitePackageDownloads = sumMetricValues(stats.packageDownloadsByVersion);
  const directPackageDownloads = sumMetricValues(stats.directPackageDownloadsByVersion);
  const updateChecks = sumMetricValues(stats.updateChecksByVersion);
  const updatesAvailable = sumMetricValues(stats.updatesAvailableByVersion);
  const rangeLabel = range === "all" ? "全部历史" : `近 ${range} 天`;
  const modelFirstDate = modelHistory[0]?.date ?? endDate;
  const modelStartDate = range === "all" ? modelFirstDate : startDate;
  const visibleModelDays = fillModelDateRange(modelHistory, modelStartDate, endDate);
  const modelStats = aggregateModelStats(visibleModelDays);
  const visibleInstallations = installationStats.filter((item) => {
    const timestamp = new Date(item.lastSeenAt).getTime();
    const date = Number.isNaN(timestamp)
      ? ""
      : new Date(timestamp + CHINA_TIME_OFFSET_MS).toISOString().slice(0, 10);
    return date >= modelStartDate && date <= endDate;
  });

  return new Response(
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Recall 数据台</title>
    <style>
      :root { color: #172029; background: #f5f7f6; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { width: min(1080px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
      header { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 32px; }
      h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: 0; }
      header p { margin: 8px 0 0; color: #60706d; }
      form { display: flex; align-items: center; gap: 8px; }
      input, button { height: 36px; border: 1px solid #c8d1cd; border-radius: 4px; background: #fff; color: inherit; padding: 0 10px; font: inherit; }
      button { background: #1d6b58; border-color: #1d6b58; color: #fff; cursor: pointer; }
      .totals { margin: 0 0 20px; color: #60706d; font-size: 14px; }
      .totals b { color: #172029; margin-right: 18px; }
      .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 24px 0 12px; }
      .range-tabs { display: inline-flex; border: 1px solid #c8d1cd; border-radius: 4px; overflow: hidden; }
      .range-tabs a { padding: 8px 12px; border-right: 1px solid #c8d1cd; color: #46524f; text-decoration: none; font-size: 14px; }
      .range-tabs a:last-child { border-right: 0; }
      .range-tabs a.active { background: #1d6b58; color: #fff; }
      .summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border: 1px solid #d8dfdc; background: #fff; }
      .summary.model { grid-template-columns: repeat(6, minmax(0, 1fr)); }
      .metric { padding: 20px; border-right: 1px solid #d8dfdc; min-height: 112px; }
      .metric:last-child { border-right: 0; }
      .metric span { display: block; color: #60706d; font-size: 13px; }
      .metric strong { display: block; margin-top: 14px; font-size: 30px; font-weight: 700; }
      .section { margin-top: 28px; }
      h2 { margin: 0 0 12px; font-size: 17px; }
      .tables { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
      table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d8dfdc; }
      th, td { padding: 12px 14px; border-bottom: 1px solid #e7ece9; text-align: left; font-size: 14px; }
      th { color: #60706d; font-weight: 600; background: #fafcfb; }
      tr:last-child td { border-bottom: 0; }
      td:last-child, th:last-child { text-align: right; }
      .empty { color: #87938f; text-align: center !important; }
      .chart { overflow-x: auto; border: 1px solid #d8dfdc; background: #fff; padding: 14px 10px 4px; }
      svg { min-width: 620px; display: block; width: 100%; }
      svg text { fill: #71807c; font-size: 11px; }
      .legend { display: flex; gap: 16px; margin: 0 0 8px 8px; color: #60706d; font-size: 13px; }
      .legend i { display: inline-block; width: 9px; height: 9px; margin-right: 5px; }
      .legend .visit { background: #1d6b58; } .legend .download { background: #c6782a; }
      .legend .model-call { background: #1d6b58; } .legend .installation { background: #a4553f; }
      code { font-family: Consolas, monospace; font-size: 12px; }
      footer { margin-top: 28px; color: #71807c; font-size: 12px; }
      @media (max-width: 760px) { main { width: min(100% - 24px, 1080px); padding-top: 28px; } header { align-items: start; flex-direction: column; } .toolbar { align-items: start; flex-direction: column; } .summary, .summary.model { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric:nth-child(2) { border-right: 0; } .metric:nth-child(n + 3) { border-top: 1px solid #d8dfdc; } .tables { grid-template-columns: 1fr; overflow-x: auto; } }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div><h1>Recall 数据台</h1><p>截至 ${escapeHtml(endDate)} · 北京时间</p></div>
        <form method="get"><input type="hidden" name="range" value="${range}" /><input type="date" name="date" value="${escapeHtml(endDate)}" /><button type="submit">查看</button></form>
      </header>
      <p class="totals">全部累计：<b>访问 ${allStats.websiteVisits}</b><b>点击下载 ${allStats.websiteDownloadStarts}</b><b>官网安装包 ${sumMetricValues(allStats.packageDownloadsByVersion)}</b></p>
      <div class="toolbar"><h2>${rangeLabel}</h2><nav class="range-tabs" aria-label="统计范围"><a class="${range === "7" ? "active" : ""}" href="?date=${encodeURIComponent(endDate)}&range=7">7 天</a><a class="${range === "30" ? "active" : ""}" href="?date=${encodeURIComponent(endDate)}&range=30">30 天</a><a class="${range === "all" ? "active" : ""}" href="?date=${encodeURIComponent(endDate)}&range=all">全部历史</a></nav></div>
      <section class="summary" aria-label="选定时段汇总">
        <div class="metric"><span>官网访问</span><strong>${stats.websiteVisits}</strong></div>
        <div class="metric"><span>点击下载</span><strong>${stats.websiteDownloadStarts}</strong></div>
        <div class="metric"><span>官网安装包请求</span><strong>${websitePackageDownloads}</strong></div>
        <div class="metric"><span>直接安装包请求</span><strong>${directPackageDownloads}</strong></div>
        <div class="metric"><span>更新检查</span><strong>${updateChecks}</strong></div>
        <div class="metric"><span>发现可更新</span><strong>${updatesAvailable}</strong></div>
      </section>
      <section class="section"><h2>每日趋势</h2><div class="chart"><p class="legend"><span><i class="visit"></i>官网访问</span><span><i class="download"></i>点击下载</span></p>${renderTrendChart(visibleDays)}</div></section>
      <section class="section"><h2>按版本</h2><div class="tables">
        <table><thead><tr><th>官网安装包版本</th><th>请求数</th></tr></thead><tbody>${renderVersionRows(stats.packageDownloadsByVersion)}</tbody></table>
        <table><thead><tr><th>直接安装包版本</th><th>请求数</th></tr></thead><tbody>${renderVersionRows(stats.directPackageDownloadsByVersion)}</tbody></table>
        <table><thead><tr><th>更新检查版本</th><th>请求数</th></tr></thead><tbody>${renderVersionRows(stats.updateChecksByVersion)}</tbody></table>
        <table><thead><tr><th>可更新至版本</th><th>请求数</th></tr></thead><tbody>${renderVersionRows(stats.updatesAvailableByVersion)}</tbody></table>
      </div></section>
      <section class="section"><h2>Recall 默认模型服务</h2>
        <div class="summary model">
          <div class="metric"><span>总调用</span><strong>${modelStats.totalCalls}</strong></div>
          <div class="metric"><span>成功</span><strong>${modelStats.successes}</strong></div>
          <div class="metric"><span>失败</span><strong>${modelStats.failures}</strong></div>
          <div class="metric"><span>语言模型</span><strong>${modelStats.languageCalls}</strong></div>
          <div class="metric"><span>多模态模型</span><strong>${modelStats.multimodalCalls}</strong></div>
          <div class="metric"><span>活跃安装</span><strong>${modelStats.installationHashes.length}</strong></div>
        </div>
      </section>
      <section class="section"><h2>默认模型每日趋势</h2><div class="chart"><p class="legend"><span><i class="model-call"></i>调用</span><span><i class="installation"></i>活跃安装</span></p>${renderModelTrendChart(visibleModelDays)}</div></section>
      <section class="section"><h2>默认模型明细</h2><div class="tables">
        <table><thead><tr><th>任务类型</th><th>调用数</th></tr></thead><tbody>${renderModelTaskRows(modelStats.callsByTask)}</tbody></table>
        <table><thead><tr><th>安装标识</th><th>版本</th><th>调用</th><th>失败</th><th>最近调用</th></tr></thead><tbody>${renderInstallationRows(visibleInstallations)}</tbody></table>
      </div></section>
      <footer>分发数字是请求聚合统计，不代表独立用户。默认模型仅统计经过 Recall 代理的调用；“活跃安装”按匿名安装标识去重，用户自配 Key 的直连调用完全不上报。</footer>
    </main>
  </body>
</html>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  );
}

type ModelProxyKind = "language" | "multimodal";

async function readJsonBodyBounded(request: Request, maxBytes: number): Promise<unknown> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("request-too-large");
  }
  if (!request.body) throw new Error("invalid-json");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("request-too-large");
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(joined));
  } catch {
    throw new Error("invalid-json");
  }
}

function isValidMessageContent(value: unknown): boolean {
  if (typeof value === "string") return value.length <= 1_000_000;
  if (!Array.isArray(value) || value.length > 64) return false;
  return value.every((part) => {
    if (!part || typeof part !== "object") return false;
    const item = part as Record<string, unknown>;
    if (item.type === "text") return typeof item.text === "string" && item.text.length <= 1_000_000;
    if (item.type !== "image_url" || !item.image_url || typeof item.image_url !== "object") return false;
    const imageUrl = (item.image_url as Record<string, unknown>).url;
    return typeof imageUrl === "string"
      && imageUrl.length <= MODEL_PROXY_MAX_BODY_BYTES
      && (imageUrl.startsWith("data:image/") || imageUrl.startsWith("https://"));
  });
}

function sanitizeModelProxyBody(value: unknown, fixedModel: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 64) return null;
  const messages = input.messages.map((message) => {
    if (!message || typeof message !== "object") return null;
    const item = message as Record<string, unknown>;
    if (!["system", "user", "assistant"].includes(String(item.role))) return null;
    if (!isValidMessageContent(item.content)) return null;
    return { role: item.role, content: item.content };
  });
  if (messages.some((message) => message === null)) return null;

  const output: Record<string, unknown> = { model: fixedModel, messages };
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== "number" || input.temperature < 0 || input.temperature > 2) return null;
    output.temperature = input.temperature;
  }
  if (input.max_tokens !== undefined) {
    if (!Number.isInteger(input.max_tokens) || Number(input.max_tokens) < 1 || Number(input.max_tokens) > 65_536) return null;
    output.max_tokens = input.max_tokens;
  }
  if (input.response_format !== undefined) {
    if (
      !input.response_format
      || typeof input.response_format !== "object"
      || (input.response_format as Record<string, unknown>).type !== "json_object"
    ) return null;
    output.response_format = { type: "json_object" };
  }
  if (input.stream !== undefined) {
    if (typeof input.stream !== "boolean") return null;
    output.stream = input.stream;
  }
  if (input.stream_options !== undefined) {
    if (
      !input.stream_options
      || typeof input.stream_options !== "object"
      || (input.stream_options as Record<string, unknown>).include_usage !== true
    ) return null;
    output.stream_options = { include_usage: true };
  }
  if (input.reasoning_effort !== undefined) {
    if (!["none", "low", "medium", "high"].includes(String(input.reasoning_effort))) return null;
    output.reasoning_effort = input.reasoning_effort;
  }
  return output;
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Cache-Control", "no-store");
  return withCors(new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  }));
}

function readModelClientMetadata(request: Request): ModelClientMetadata | null {
  const installationId = request.headers.get("X-Recall-Installation-Id")?.trim() ?? "";
  const taskType = request.headers.get("X-Recall-Task-Type")?.trim() ?? "";
  const clientVersion = (request.headers.get("X-Recall-Client-Version")?.trim() || "unknown").slice(0, 40);
  if (!INSTALLATION_ID_PATTERN.test(installationId) || !MODEL_TASK_TYPE_PATTERN.test(taskType)) {
    return null;
  }
  return { installationId, taskType, clientVersion };
}

async function handleDefaultModelProxy(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  kind: ModelProxyKind
): Promise<Response> {
  if (env.MODEL_PROXY_ENABLED?.trim().toLowerCase() === "false") {
    return jsonResponse({ error: "capability-disabled" }, 503);
  }
  const metadata = readModelClientMetadata(request);
  if (!metadata) {
    return jsonResponse({ error: "invalid-client-metadata" }, 400);
  }
  const { installationId, taskType, clientVersion } = metadata;

  const apiUrl = (kind === "language" ? env.DEFAULT_LANGUAGE_API_URL : env.DEFAULT_MULTIMODAL_API_URL)?.trim()
    || "https://api.ppclaw.online";
  const model = (kind === "language" ? env.DEFAULT_LANGUAGE_MODEL : env.DEFAULT_MULTIMODAL_MODEL)?.trim()
    || (kind === "language" ? "deepseek-v4-flash" : "sensenova-6.7-flash-lite");
  const apiKey = (kind === "language" ? env.DEFAULT_LANGUAGE_API_KEY : env.DEFAULT_MULTIMODAL_API_KEY)?.trim();
  if (!apiKey) return jsonResponse({ error: "capability-unavailable" }, 503);

  let parsed: unknown;
  try {
    parsed = await readJsonBodyBounded(request, MODEL_PROXY_MAX_BODY_BYTES);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "invalid-request" }, 400);
  }
  const body = sanitizeModelProxyBody(parsed, model);
  if (!body) return jsonResponse({ error: "invalid-request" }, 400);

  const endpoint = `${apiUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
  const record = (status: "success" | "failure") => {
    const secret = env.MODEL_STATS_HASH_SECRET?.trim();
    if (!secret) return;
    ctx.waitUntil(recordDefaultModelCall(env.MODEL_STATS, secret, {
      date: currentDateKey(),
      installationId,
      kind,
      taskType,
      status,
      clientVersion,
    }).catch((error) => {
      console.error("default model statistics write failed", error instanceof Error ? error.message : String(error));
    }));
  };

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: body.stream === true ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });
    record(upstream.ok ? "success" : "failure");
    return proxyResponse(upstream);
  } catch {
    record("failure");
    return jsonResponse({ error: "upstream-unreachable" }, 502);
  }
}

async function handleDefaultMultimodalJobSubmit(request: Request, env: Env): Promise<Response> {
  if (env.MODEL_PROXY_ENABLED?.trim().toLowerCase() === "false") {
    return jsonResponse({ error: "capability-disabled" }, 503);
  }
  const metadata = readModelClientMetadata(request);
  if (!metadata) return jsonResponse({ error: "invalid-client-metadata" }, 400);
  const idempotencyKey = request.headers.get("X-Recall-Idempotency-Key")?.trim() ?? "";
  if (!MODEL_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonResponse({ error: "invalid-idempotency-key" }, 400);
  }
  const model = env.DEFAULT_MULTIMODAL_MODEL?.trim() || "sensenova-6.7-flash-lite";
  let parsed: unknown;
  try {
    parsed = await readJsonBodyBounded(request, MODEL_PROXY_MAX_BODY_BYTES);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "invalid-request" }, 400);
  }
  const body = sanitizeModelProxyBody(parsed, model);
  if (!body) return jsonResponse({ error: "invalid-request" }, 400);
  const result = await submitDefaultMultimodalJob(env, metadata, idempotencyKey, body);
  return jsonResponse(result.body, result.status);
}

async function handleDefaultMultimodalJobStatus(
  request: Request,
  env: Env,
  jobId: string
): Promise<Response> {
  const metadata = readModelClientMetadata(request);
  if (!metadata) return jsonResponse({ error: "invalid-client-metadata" }, 400);
  if (!ASYNC_MODEL_JOB_ID_PATTERN.test(jobId)) {
    return jsonResponse({ error: "job-not-found" }, 404);
  }
  const result = await getDefaultMultimodalJob(env, metadata, jobId);
  return jsonResponse(result.body, result.status);
}

const DEFAULT_INFOGRAPHIC_API_URL = "https://api.ppclaw.online/v1/images/generations";
const DEFAULT_INFOGRAPHIC_MODEL = "sensenova-u1-fast";
const DEFAULT_INFOGRAPHIC_SIZE = "2752x1536";
const INFOGRAPHIC_MAX_PROMPT_LENGTH = 30_000;
const INFOGRAPHIC_TYPES = new Set(["personal", "work", "daily", "weekly", "monthly"]);

function isImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function extractImageUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { url?: unknown; data?: unknown };
  if (isImageUrl(body.url)) return body.url;
  if (Array.isArray(body.data)) {
    const first = body.data[0];
    if (first && typeof first === "object" && isImageUrl((first as { url?: unknown }).url)) {
      return (first as { url: string }).url;
    }
  }
  return null;
}

async function handleInfographicGeneration(request: Request, env: Env): Promise<Response> {
  if (!env.INFOGRAPHIC_API_KEY?.trim()) {
    return jsonResponse({ error: "capability-unavailable" }, 503);
  }
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > INFOGRAPHIC_MAX_PROMPT_LENGTH * 2) {
    return jsonResponse({ error: "request-too-large" }, 413);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: "invalid-json" }, 400);
  }

  if (!input || typeof input !== "object") {
    return jsonResponse({ error: "invalid-request" }, 400);
  }
  const body = input as { prompt?: unknown; reportType?: unknown };
  if (
    typeof body.prompt !== "string" ||
    body.prompt.trim().length === 0 ||
    body.prompt.length > INFOGRAPHIC_MAX_PROMPT_LENGTH ||
    (body.reportType !== undefined &&
      (typeof body.reportType !== "string" || !INFOGRAPHIC_TYPES.has(body.reportType)))
  ) {
    return jsonResponse({ error: "invalid-request" }, 400);
  }

  const endpoint = env.INFOGRAPHIC_API_URL?.trim() || DEFAULT_INFOGRAPHIC_API_URL;
  const model = env.INFOGRAPHIC_MODEL?.trim() || DEFAULT_INFOGRAPHIC_MODEL;
  const size = env.INFOGRAPHIC_SIZE?.trim() || DEFAULT_INFOGRAPHIC_SIZE;

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.INFOGRAPHIC_API_KEY.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: body.prompt,
        size,
        n: 1,
      }),
    });
  } catch {
    return jsonResponse({ error: "upstream-unreachable" }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse({ error: "upstream-failed", status: upstream.status }, 502);
  }

  let responseBody: unknown;
  try {
    responseBody = await upstream.json();
  } catch {
    return jsonResponse({ error: "upstream-invalid-response" }, 502);
  }
  const imageUrl = extractImageUrl(responseBody);
  if (!imageUrl) {
    return jsonResponse({ error: "upstream-missing-image" }, 502);
  }
  return jsonResponse({ url: imageUrl });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    try {
      // ─── OPTIONS 预检：返回 204 ──────────────────────
      if (method === "OPTIONS") {
        return withCors(
          new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Max-Age": "86400",
            },
          })
        );
      }

      // ─── POST /api/model/{language|multimodal}/v1/chat/completions ───
      // 固定上游与模型，默认服务 Key 只存在于 Worker Secret。
      if (path === "/api/model/language/v1/chat/completions") {
        if (method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
        return handleDefaultModelProxy(request, env, ctx, "language");
      }
      if (path === "/api/model/multimodal/v1/chat/completions") {
        if (method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
        return handleDefaultModelProxy(request, env, ctx, "multimodal");
      }
      if (path === "/api/model/multimodal/jobs") {
        if (method !== "POST") return jsonResponse({ error: "method-not-allowed" }, 405);
        return handleDefaultMultimodalJobSubmit(request, env);
      }
      if (path.startsWith("/api/model/multimodal/jobs/")) {
        if (method !== "GET") return jsonResponse({ error: "method-not-allowed" }, 405);
        return handleDefaultMultimodalJobStatus(
          request,
          env,
          path.slice("/api/model/multimodal/jobs/".length)
        );
      }

      // ─── POST /api/infographic/generate ────────────────
      // 只代理固定的信息图模型；上游密钥永不返回给客户端。
      if (path === "/api/infographic/generate") {
        if (method !== "POST") {
          return jsonResponse({ error: "method-not-allowed" }, 405);
        }
        return handleInfographicGeneration(request, env);
      }

      // ─── POST /api/metrics/website-visit ─────────────
      // 官网仅上报一次空请求，用于聚合访问量；不接收任何用户或页面内容。
      if (path === "/api/metrics/website-visit") {
        if (method !== "POST") {
          return jsonResponse({ error: "method-not-allowed" }, 405);
        }
        if (!isWebsiteRequest(request)) {
          return jsonResponse({ error: "forbidden" }, 403);
        }
        await recordDistributionMetric(env.STATS, currentDateKey(), "website_visit");
        return jsonResponse({ ok: true }, 202);
      }

      // ─── 路由：仅支持 GET ─────────────────────────────
      if (method !== "GET") {
        return jsonResponse({ error: "method-not-allowed" }, 405);
      }

      // ─── GET /api/latest ──────────────────────────────
      // 返回最新版本 manifest JSON；不存在返回 404 + { error }
      if (path === "/api/latest") {
        const manifest = await readManifest(env.RELEASES);
        if (manifest === null) {
          return jsonResponse({ error: "no manifest" }, 404);
        }
        return jsonResponse(manifest);
      }

      // ─── GET /api/check?currentVersion=x.y.z&platform=win|mac&arch=arm64|x64 ─
      // 对比版本，返回是否有更新及更新详情
      // platform 参数可选：客户端传 platform=darwin 时优先返回 mac 产物
      if (path === "/api/check") {
        const currentVersion = url.searchParams.get("currentVersion");
        const platform = url.searchParams.get("platform");
        const arch = url.searchParams.get("arch");
        const manifest = await readManifest(env.RELEASES);

        // manifest 不存在时按无更新返回
        if (manifest === null) {
          const fallbackVersion = currentVersion ?? "0.0.0";
          return jsonResponse({
            hasUpdate: false,
            currentVersion: fallbackVersion,
            latestVersion: fallbackVersion,
            downloadUrl: "",
            sha256: "",
            releaseNotes: "",
            publishedAt: "",
          });
        }

        // 必须提供 currentVersion
        if (!currentVersion) {
          return jsonResponse(
            { error: "missing-currentVersion", message: "查询参数 currentVersion 必填" },
            400
          );
        }

        // 按平台选择产物：mac 客户端传 platform=darwin 时用 mac 产物，否则回退顶层（Windows）
        const isMacClient = platform === "darwin" || platform === "mac";
        const platformArtifact = isMacClient
          ? (arch === "x64"
            ? (manifest.platforms?.macX64 ?? manifest.platforms?.mac ?? null)
            : arch === "arm64"
              ? (manifest.platforms?.macArm64 ?? manifest.platforms?.mac ?? null)
              : (manifest.platforms?.mac ?? manifest.platforms?.macArm64 ?? null))
          : (manifest.platforms?.win ?? null);
        const downloadUrl = platformArtifact?.downloadUrl ?? manifest.downloadUrl;
        const sha256 = platformArtifact?.sha256 ?? manifest.sha256;

        const cmp = compareVersions(currentVersion, manifest.version);
        const hasUpdate = cmp < 0;
        const date = currentDateKey();
        ctx.waitUntil(recordDistributionMetric(env.STATS, date, "update_check", currentVersion));
        if (hasUpdate) {
          ctx.waitUntil(recordDistributionMetric(env.STATS, date, "update_available", manifest.version));
        }
        return jsonResponse({
          hasUpdate,
          currentVersion,
          latestVersion: manifest.version,
          downloadUrl,
          sha256,
          releaseNotes: manifest.releaseNotes,
          publishedAt: manifest.publishedAt,
        });
      }

      // ─── GET /api/metrics/daily?date=YYYY-MM-DD ─────
      // 运营端读取已聚合的统计；必须配置并提供独立密钥。
      if (path === "/api/metrics/daily") {
        if (!(await isStatsReadAuthorized(request, env))) {
          return jsonResponse({ error: "not-found" }, 404);
        }
        const date = url.searchParams.get("date") ?? currentDateKey();
        if (!DATE_KEY_PATTERN.test(date)) {
          return jsonResponse({ error: "invalid-date" }, 400);
        }
        return jsonResponse(await getDailyDistributionStats(env.STATS, date));
      }

      // ─── GET /admin/stats?date=YYYY-MM-DD ───────────
      // 运营数据页使用浏览器标准 Basic Auth，不写 Cookie 或账号信息。
      if (path === "/admin/stats") {
        if (!(await isStatsAdminAuthorized(request, env))) {
          return statsLoginRequired();
        }
        const endDate = url.searchParams.get("date") ?? currentDateKey();
        if (!DATE_KEY_PATTERN.test(endDate)) {
          return jsonResponse({ error: "invalid-date" }, 400);
        }
        const range = selectedRange(url.searchParams.get("range"));
        const [distributionHistory, modelHistory, installationStats] = await Promise.all([
          getDistributionStatsHistory(env.STATS),
          getDefaultModelStatsHistory(env.MODEL_STATS),
          getDefaultModelInstallationStats(env.MODEL_STATS),
        ]);
        return statsPageResponse(distributionHistory, modelHistory, installationStats, endDate, range);
      }

      // ─── GET /download/latest ──────────────────────
      // 读取 manifest，302 重定向到最新版安装包（供网站下载按钮使用，始终指向最新版）
      if (path === "/download/latest") {
        const manifest = await readManifest(env.RELEASES);
        if (manifest === null) {
          return jsonResponse({ error: "no manifest" }, 404);
        }
        const date = currentDateKey();
        ctx.waitUntil(recordDistributionMetric(env.STATS, date, "website_download_start"));
        // 为最终安装包请求标记官网来源，不影响客户端更新使用的直接下载 URL。
        const locationUrl = new URL(manifest.downloadUrl, url.origin);
        locationUrl.searchParams.set("source", "website");
        return withCors(
          new Response(null, {
            status: 302,
            headers: {
              Location: locationUrl.href,
              "Cache-Control": "no-store",
            },
          })
        );
      }

      // ─── GET /download/:filename ────────────────────
      // 从 R2 流式返回安装包，支持 Range
      if (path.startsWith("/download/")) {
        const filename = path.slice("/download/".length);
        if (!filename) {
          return jsonResponse({ error: "not found" }, 404);
        }
        const obj = await env.RELEASES.get(filename, {
          range: request.headers,
        });
        if (obj === null) {
          return jsonResponse({ error: "not found" }, 404);
        }

        // Range 请求会被下载器重试/切片，不计为新的安装包请求。
        if (!request.headers.has("Range")) {
          const metric = url.searchParams.get("source") === "website"
            ? "package_download"
            : "direct_package_download";
          ctx.waitUntil(recordDistributionMetric(env.STATS, currentDateKey(), metric, filename));
        }

        const headers = new Headers();
        headers.set("Content-Type", "application/octet-stream");
        headers.set(
          "Content-Disposition",
          `attachment; filename="${filename}"`
        );
        // 透传 R2 写入大小与 Range 相关头
        obj.writeHttpMetadata(headers);
        if (obj.range) {
          // R2Range 是联合类型：
          //   { offset: number; length?: number } |
          //   { offset?: number; length: number } |
          //   { suffix: number }
          if ("suffix" in obj.range) {
            // 后缀范围请求：最后 N 字节
            const suffix = obj.range.suffix;
            const start = obj.size - suffix;
            headers.set(
              "Content-Range",
              `bytes ${start}-${obj.size - 1}/${obj.size}`
            );
            headers.set("Content-Length", String(suffix));
          } else {
            // 普通范围请求：offset 起始（缺省 0），length 字节（缺省到末尾）
            const offset = obj.range.offset ?? 0;
            const length = obj.range.length ?? obj.size - offset;
            headers.set(
              "Content-Range",
              `bytes ${offset}-${offset + length - 1}/${obj.size}`
            );
            headers.set("Content-Length", String(length));
          }
          return withCors(
            new Response(obj.body, { status: 206, headers })
          );
        }
        headers.set("Content-Length", String(obj.size));
        // 安装包较大，允许缓存（R2 不变对象）；但桌面端通常无缓存需求
        headers.set("Cache-Control", "public, max-age=3600");
        return withCors(new Response(obj.body, { status: 200, headers }));
      }

      // ─── 其他路径：404 ───────────────────────────────
      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      // 兜底：所有异常捕获后返回 500
      const message =
        err instanceof Error ? err.message : "unknown error";
      return jsonResponse(
        { error: "internal", message: message.slice(0, 200) },
        500
      );
    }
  },

  async queue(
    batch: MessageBatch<DefaultMultimodalQueueMessage>,
    env: Env
  ): Promise<void> {
    await consumeDefaultMultimodalJobs(batch, env);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(cleanupExpiredDefaultMultimodalJobs(env));
  },
} satisfies ExportedHandler<Env, DefaultMultimodalQueueMessage>;
