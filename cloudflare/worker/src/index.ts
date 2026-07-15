// Recall 桌面端更新分发 Worker 主入口
// 提供 4 个端点：/api/latest, /api/check, /api/ping, /download/:filename

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
}

/** CORS 允许的方法 */
const CORS_ALLOWED_METHODS = "GET, OPTIONS";
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
