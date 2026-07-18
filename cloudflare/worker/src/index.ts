// Recall 桌面端更新分发 Worker 主入口
// 同时提供信息图代理，避免把共享图像服务密钥编译进桌面客户端。

import { compareVersions } from "./version";
import { readManifest, type UpdateManifest } from "./manifest";
import { recordPing } from "./stats";

/**
 * Worker 环境变量与绑定
 */
export interface Env {
  /** R2 存储桶：保存 manifest.json 与安装包 */
  RELEASES: R2Bucket;
  /** KV 命名空间：保存客户端版本检查统计 */
  STATS: KVNamespace;
  /** 信息图服务密钥，仅通过 wrangler secret put 注入 */
  INFOGRAPHIC_API_KEY?: string;
  /** 信息图上游地址，可通过 vars 覆盖 */
  INFOGRAPHIC_API_URL?: string;
  /** 信息图模型，可通过 vars 覆盖 */
  INFOGRAPHIC_MODEL?: string;
  /** 信息图尺寸，可通过 vars 覆盖 */
  INFOGRAPHIC_SIZE?: string;
}

/** CORS 允许的方法 */
const CORS_ALLOWED_METHODS = "GET, POST, OPTIONS";
/** CORS 允许的请求头 */
const CORS_ALLOWED_HEADERS = "Content-Type, X-Client-Version";

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

/**
 * 从请求中提取客户端版本号
 * - 优先读取 X-Client-Version 请求头
 * - 否则读取 ?version= 查询参数
 */
function extractVersion(request: Request, url: URL): string | null {
  const headerVersion = request.headers.get("X-Client-Version");
  if (headerVersion) return headerVersion.trim();
  const queryVersion = url.searchParams.get("version");
  if (queryVersion) return queryVersion.trim();
  return null;
}

const DEFAULT_INFOGRAPHIC_API_URL = "https://api.ppclaw.online/v1/images/generations";
const DEFAULT_INFOGRAPHIC_MODEL = "sensenova-u1-fast";
const DEFAULT_INFOGRAPHIC_SIZE = "2752x1536";
const INFOGRAPHIC_MAX_PROMPT_LENGTH = 30_000;
const INFOGRAPHIC_DAILY_REQUEST_LIMIT = 100;
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
  if (!(await takeInfographicRateLimit(request, env))) {
    return jsonResponse({ error: "rate-limited" }, 429);
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

async function takeInfographicRateLimit(request: Request, env: Env): Promise<boolean> {
  const ip = (request.headers.get("CF-Connecting-IP") ?? "unknown").slice(0, 80);
  const day = new Date().toISOString().slice(0, 10);
  const key = `infographic:${day}:${ip}`;
  const current = Number.parseInt((await env.STATS.get(key)) ?? "0", 10) || 0;
  if (current >= INFOGRAPHIC_DAILY_REQUEST_LIMIT) return false;
  // KV 是最终一致的，极端并发时可能略超出上限，但可阻断普通滥用。
  await env.STATS.put(key, String(current + 1), { expirationTtl: 172_800 });
  return true;
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

      // ─── POST /api/infographic/generate ────────────────
      // 只代理固定的信息图模型；上游密钥永不返回给客户端。
      if (path === "/api/infographic/generate") {
        if (method !== "POST") {
          return jsonResponse({ error: "method-not-allowed" }, 405);
        }
        return handleInfographicGeneration(request, env);
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

      // ─── GET /api/check?currentVersion=x.y.z ─────────
      // 对比版本，返回是否有更新及更新详情
      if (path === "/api/check") {
        const currentVersion = url.searchParams.get("currentVersion");
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

        const cmp = compareVersions(currentVersion, manifest.version);
        const hasUpdate = cmp < 0;
        return jsonResponse({
          hasUpdate,
          currentVersion,
          latestVersion: manifest.version,
          downloadUrl: manifest.downloadUrl,
          sha256: manifest.sha256,
          releaseNotes: manifest.releaseNotes,
          publishedAt: manifest.publishedAt,
        });
      }

      // ─── GET /api/ping ───────────────────────────────
      // 记录一次版本检查；用 ctx.waitUntil 异步写入不阻塞响应
      if (path === "/api/ping") {
        const version = extractVersion(request, url);
        if (!version) {
          return jsonResponse(
            { error: "missing-version", message: "需提供 X-Client-Version 头或 ?version=" },
            400
          );
        }
        // 异步写入统计，立即返回响应
        ctx.waitUntil(recordPing(env.STATS, version));
        return jsonResponse({ ok: true });
      }

      // ─── GET /download/latest ──────────────────────
      // 读取 manifest，302 重定向到最新版安装包（供网站下载按钮使用，始终指向最新版）
      if (path === "/download/latest") {
        const manifest = await readManifest(env.RELEASES);
        if (manifest === null) {
          return jsonResponse({ error: "no manifest" }, 404);
        }
        // manifest.downloadUrl 是相对路径（如 "/download/Recall-0.2.1-setup.exe"），构造绝对 URL
        const location = new URL(manifest.downloadUrl, url.origin).href;
        return withCors(
          new Response(null, {
            status: 302,
            headers: {
              Location: location,
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
};
