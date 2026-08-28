import {
  buildDefaultModelCallStatements,
  hmacInstallationId,
} from "./stats";
import { UPSTREAM_FETCH_TIMEOUT_MS } from "./index";

export interface ModelClientMetadata {
  installationId: string;
  taskType: string;
  clientVersion: string;
}

export interface AsyncHandlerResult {
  status: number;
  body: Record<string, unknown>;
}

interface AsyncJobRow {
  id: string;
  installation_hash: string;
  idempotency_hash: string;
  task_type: string;
  client_version: string;
  status: "pending" | "running" | "succeeded" | "failed";
  input_object_key: string | null;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  expires_at: string;
}

interface OpenAiCompletion {
  choices: Array<{
    message: { role: "assistant"; content: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: OpenAiCompletion["usage"];
  error?: { message?: string };
}

interface UpstreamResult {
  ok: boolean;
  completion?: OpenAiCompletion;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  retryDelaySeconds?: number;
}

const JOB_TTL_MS = 2 * 60 * 60_000;
const DELIVERED_TTL_MS = 10 * 60_000;
const MAX_RESULT_JSON_CHARS = 1_500_000;
const PAYLOAD_PREFIX = "default-multimodal-jobs/";
const MAX_QUEUE_ATTEMPTS = 3;

export async function submitDefaultMultimodalJob(
  env: Env,
  metadata: ModelClientMetadata,
  idempotencyKey: string,
  sanitizedBody: Record<string, unknown>
): Promise<AsyncHandlerResult> {
  const secret = env.MODEL_STATS_HASH_SECRET?.trim();
  if (!secret || !env.DEFAULT_MULTIMODAL_API_KEY?.trim()) {
    return { status: 503, body: { error: "capability-unavailable" } };
  }

  const installationHash = await hmacInstallationId(metadata.installationId, secret);
  const idempotencyHash = await sha256Hex(
    `${installationHash}:${metadata.taskType}:${idempotencyKey}`
  );
  const existing = await findByIdempotency(env.MODEL_STATS, installationHash, idempotencyHash);
  if (existing && existing.expires_at > new Date().toISOString()) {
    return queuedResponse(existing);
  }

  const jobId = `mmj_${crypto.randomUUID()}`;
  const inputObjectKey = `${PAYLOAD_PREFIX}${jobId}.json`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  const body = { ...sanitizedBody };

  await env.MODEL_JOB_PAYLOADS.put(inputObjectKey, JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { expiresAt },
  });

  try {
    await env.MODEL_STATS.prepare(
      `INSERT INTO default_multimodal_jobs
       (id, installation_hash, idempotency_hash, task_type, client_version, status,
        input_object_key, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(
      jobId,
      installationHash,
      idempotencyHash,
      metadata.taskType,
      metadata.clientVersion,
      inputObjectKey,
      now,
      now,
      expiresAt
    ).run();
  } catch (error) {
    await env.MODEL_JOB_PAYLOADS.delete(inputObjectKey);
    const raced = await findByIdempotency(env.MODEL_STATS, installationHash, idempotencyHash);
    if (raced) return queuedResponse(raced);
    throw error;
  }

  try {
    await env.DEFAULT_MULTIMODAL_JOBS.send({ version: 1, jobId });
  } catch (error) {
    await Promise.all([
      env.MODEL_JOB_PAYLOADS.delete(inputObjectKey),
      env.MODEL_STATS.prepare("DELETE FROM default_multimodal_jobs WHERE id = ?").bind(jobId).run(),
    ]);
    console.error(JSON.stringify({
      event: "default_multimodal_enqueue_failed",
      jobId,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { status: 503, body: { error: "queue-unavailable" } };
  }

  return {
    status: 202,
    body: { jobId, status: "pending", retryAfterMs: 2_000 },
  };
}

export async function getDefaultMultimodalJob(
  env: Env,
  metadata: ModelClientMetadata,
  jobId: string
): Promise<AsyncHandlerResult> {
  const secret = env.MODEL_STATS_HASH_SECRET?.trim();
  if (!secret) return { status: 503, body: { error: "capability-unavailable" } };
  const installationHash = await hmacInstallationId(metadata.installationId, secret);
  const job = await env.MODEL_STATS.prepare(
    `SELECT * FROM default_multimodal_jobs
     WHERE id = ? AND installation_hash = ? AND expires_at > ?`
  ).bind(jobId, installationHash, new Date().toISOString()).first<AsyncJobRow>();
  if (!job) return { status: 404, body: { error: "job-not-found" } };

  if (job.status === "succeeded") {
    let response: unknown;
    try {
      response = JSON.parse(job.result_json ?? "");
    } catch {
      return { status: 500, body: { error: "job-result-invalid" } };
    }
    const deliveredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DELIVERED_TTL_MS).toISOString();
    await env.MODEL_STATS.prepare(
      `UPDATE default_multimodal_jobs
       SET delivered_at = COALESCE(delivered_at, ?), expires_at = MIN(expires_at, ?), updated_at = ?
       WHERE id = ?`
    ).bind(deliveredAt, expiresAt, deliveredAt, job.id).run();
    return { status: 200, body: { jobId: job.id, status: job.status, response } };
  }
  if (job.status === "failed") {
    return {
      status: 200,
      body: {
        jobId: job.id,
        status: job.status,
        errorCode: job.error_code ?? "unknown_error",
        errorMessage: job.error_message ?? "默认多模态任务失败",
      },
    };
  }
  return {
    status: 202,
    body: { jobId: job.id, status: job.status, retryAfterMs: 2_000 },
  };
}

export async function consumeDefaultMultimodalJobs(
  batch: MessageBatch<DefaultMultimodalQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await consumeOne(message, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: "default_multimodal_consumer_failed",
        jobId: message.body?.jobId,
        attempts: message.attempts,
        error: error instanceof Error ? error.message : String(error),
      }));
      if (message.attempts < MAX_QUEUE_ATTEMPTS) {
        await markPending(env.MODEL_STATS, message.body?.jobId);
        message.retry({ delaySeconds: 30 });
      } else {
        await finalizeFailure(
          env,
          message.body?.jobId,
          "network_error",
          "默认多模态任务执行失败，请稍后手动重试"
        );
        message.ack();
      }
    }
  }
}

async function consumeOne(
  message: Message<DefaultMultimodalQueueMessage>,
  env: Env
): Promise<void> {
  const jobId = message.body?.version === 1 ? message.body.jobId : "";
  if (!jobId) {
    message.ack();
    return;
  }
  const job = await getJobById(env.MODEL_STATS, jobId);
  if (!job || job.status === "succeeded" || job.status === "failed") {
    message.ack();
    return;
  }
  if (job.expires_at <= new Date().toISOString()) {
    await finalizeFailure(env, job.id, "upstream_timeout", "默认多模态任务已过期");
    message.ack();
    return;
  }

  const now = new Date().toISOString();
  await env.MODEL_STATS.prepare(
    `UPDATE default_multimodal_jobs
     SET status = 'running', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'running')`
  ).bind(now, job.id).run();

  const inputObject = job.input_object_key
    ? await env.MODEL_JOB_PAYLOADS.get(job.input_object_key)
    : null;
  if (!inputObject) {
    await finalizeFailure(env, job.id, "response_invalid", "异步任务输入已丢失");
    message.ack();
    return;
  }

  let requestBody: Record<string, unknown>;
  try {
    requestBody = await new Response(inputObject.body).json() as Record<string, unknown>;
  } catch (error) {
    await finalizeFailure(
      env,
      job.id,
      "response_invalid",
      `异步任务输入不是有效 JSON: ${safeErrorMessage(error)}`
    );
    message.ack();
    return;
  }

  const upstreamApiKey = env.DEFAULT_MULTIMODAL_API_KEY?.trim();
  if (!upstreamApiKey) {
    await finalizeFailure(env, job.id, "auth_error", "Recall 默认多模态服务暂时不可用");
    message.ack();
    return;
  }

  const endpoint = `${(env.DEFAULT_MULTIMODAL_API_URL?.trim() || "https://api.ppclaw.online")
    .replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/chat/completions`;
  let result: UpstreamResult;
  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${upstreamApiKey}`,
        "Content-Type": "application/json",
        Accept: requestBody.stream === true ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(requestBody),
      ...(requestBody.stream === true ? {} : { signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS) }),
    });
    result = await readUpstreamCompletion(upstream);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      result = {
        ok: false,
        errorCode: "upstream_timeout",
        errorMessage: "上游代理超时（显式超时）",
        retryable: false,
      };
    } else {
      result = {
        ok: false,
        errorCode: "network_error",
        errorMessage: `上游网络错误: ${safeErrorMessage(error)}`,
        retryable: true,
        retryDelaySeconds: 30,
      };
    }
  }

  if (result.ok && result.completion) {
    const resultJson = JSON.stringify(result.completion);
    if (resultJson.length > MAX_RESULT_JSON_CHARS) {
      await finalizeFailure(env, job.id, "response_invalid", "模型响应超过异步结果存储上限");
    } else {
      await finalizeSuccess(env, job, resultJson);
    }
    await deletePayload(env, job.input_object_key);
    message.ack();
    return;
  }

  if (result.retryable && message.attempts < MAX_QUEUE_ATTEMPTS) {
    await markPending(env.MODEL_STATS, job.id);
    message.retry({ delaySeconds: result.retryDelaySeconds ?? 30 });
    return;
  }

  await finalizeFailure(
    env,
    job.id,
    result.errorCode ?? "unknown_error",
    result.errorMessage ?? "默认多模态任务失败"
  );
  await deletePayload(env, job.input_object_key);
  message.ack();
}

export async function cleanupExpiredDefaultMultimodalJobs(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const expired = await env.MODEL_STATS.prepare(
    `SELECT id, input_object_key FROM default_multimodal_jobs
     WHERE expires_at <= ? ORDER BY expires_at LIMIT 100`
  ).bind(now).all<{ id: string; input_object_key: string | null }>();
  const objectKeys = expired.results
    .map((row) => row.input_object_key)
    .filter((key): key is string => Boolean(key));
  if (objectKeys.length > 0) await env.MODEL_JOB_PAYLOADS.delete(objectKeys);
  if (expired.results.length > 0) {
    const ids = expired.results.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    await env.MODEL_STATS.prepare(
      `DELETE FROM default_multimodal_jobs WHERE id IN (${placeholders})`
    ).bind(...ids).run();
  }

  const orphaned = await env.MODEL_JOB_PAYLOADS.list({
    prefix: PAYLOAD_PREFIX,
    limit: 100,
    include: ["customMetadata"],
  });
  const staleKeys = orphaned.objects
    .filter((object) => {
      const expiresAt = object.customMetadata?.expiresAt;
      return typeof expiresAt === "string" && expiresAt <= now;
    })
    .map((object) => object.key);
  if (staleKeys.length > 0) await env.MODEL_JOB_PAYLOADS.delete(staleKeys);
}

export async function readUpstreamCompletion(response: Response): Promise<UpstreamResult> {
  if (!response.ok) {
    const status = response.status;
    const message = await readBoundedError(response);
    if (status === 520 || status === 524) {
      return {
        ok: false,
        errorCode: "upstream_timeout",
        errorMessage: `上游代理超时 (HTTP ${status})，为避免重复生成未自动重试`,
        retryable: false,
      };
    }
    if (status === 401 || status === 403) {
      return { ok: false, errorCode: "auth_error", errorMessage: `上游鉴权失败 (HTTP ${status})` };
    }
    if (status === 429) {
      return {
        ok: false,
        errorCode: "rate_limited",
        // 保留上游响应体（截断、已脱敏）：429 的真实原因可能来自中转渠道、
        // 上游模型限流或 Cloudflare 边缘规则，丢弃响应体会导致无法定位。
        errorMessage: message
          ? `上游请求被限流 (HTTP 429): ${message.slice(0, 300)}`
          : "上游请求被限流 (HTTP 429)",
        retryable: true,
        // 上游无 Retry-After 头时默认等 90s：饱和队列需要更长冷却，
        // 30s 的密集重试会加剧 "Server is busy" 风暴。
        retryDelaySeconds: retryDelaySeconds(response.headers.get("retry-after"), 90),
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        errorCode: "network_error",
        errorMessage: `上游服务错误 (HTTP ${status}): ${message}`,
        retryable: true,
        retryDelaySeconds: 30,
      };
    }
    return {
      ok: false,
      errorCode: "unknown_error",
      errorMessage: `上游请求错误 (HTTP ${status}): ${message}`,
    };
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    try {
      const completion = await response.json<OpenAiCompletion>();
      if (!completion.choices?.length) throw new Error("响应缺少 choices");
      return { ok: true, completion };
    } catch (error) {
      return { ok: false, errorCode: "response_invalid", errorMessage: safeErrorMessage(error) };
    }
  }
  if (!response.body) {
    return { ok: false, errorCode: "response_invalid", errorMessage: "流式响应缺少 body" };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null | undefined;
  let usage: OpenAiCompletion["usage"];
  let sawDone = false;
  while (true) {
    const read = await reader.read();
    buffer += decoder.decode(read.value, { stream: !read.done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    if (read.done && buffer.trim()) {
      events.push(buffer);
      buffer = "";
    }
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          sawDone = true;
          break;
        }
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          return {
            ok: false,
            errorCode: "response_invalid",
            errorMessage: "上游 SSE 数据不是有效 JSON",
          };
        }
        if (chunk.error) {
          return {
            ok: false,
            errorCode: "response_invalid",
            errorMessage: chunk.error.message?.slice(0, 500) || "上游流式响应报错",
          };
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      if (sawDone) break;
    }
    if (sawDone || read.done) break;
  }
  if (!sawDone && !finishReason) {
    return {
      ok: false,
      errorCode: content ? "response_invalid" : "network_error",
      errorMessage: `上游流式响应提前结束（已接收 ${content.length} 字符）`,
      retryable: content.length === 0,
      retryDelaySeconds: 30,
    };
  }
  return {
    ok: true,
    completion: {
      choices: [{
        message: { role: "assistant", content },
        finish_reason: finishReason ?? "stop",
      }],
      ...(usage ? { usage } : {}),
    },
  };
}

async function finalizeSuccess(env: Env, job: AsyncJobRow, resultJson: string): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  await env.MODEL_STATS.batch([
    env.MODEL_STATS.prepare(
      `UPDATE default_multimodal_jobs
       SET status = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL,
           input_object_key = NULL, completed_at = ?, updated_at = ?, expires_at = ?
       WHERE id = ? AND status = 'running'`
    ).bind(resultJson, now, now, expiresAt, job.id),
    ...buildDefaultModelCallStatements(env.MODEL_STATS, {
      date: chinaDateKey(),
      installationHash: job.installation_hash,
      kind: "multimodal",
      taskType: job.task_type,
      status: "success",
      clientVersion: job.client_version,
    }),
  ]);
}

async function finalizeFailure(
  env: Env,
  jobId: string,
  errorCode: string,
  errorMessage: string
): Promise<void> {
  if (!jobId) return;
  const job = await getJobById(env.MODEL_STATS, jobId);
  if (!job || job.status === "succeeded" || job.status === "failed") return;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
  await env.MODEL_STATS.batch([
    env.MODEL_STATS.prepare(
      `UPDATE default_multimodal_jobs
       SET status = 'failed', result_json = NULL, error_code = ?, error_message = ?,
           input_object_key = NULL, completed_at = ?, updated_at = ?, expires_at = ?
       WHERE id = ? AND status IN ('pending', 'running')`
    ).bind(errorCode, errorMessage.slice(0, 1_000), now, now, expiresAt, job.id),
    ...buildDefaultModelCallStatements(env.MODEL_STATS, {
      date: chinaDateKey(),
      installationHash: job.installation_hash,
      kind: "multimodal",
      taskType: job.task_type,
      status: "failure",
      clientVersion: job.client_version,
    }),
  ]);
  await deletePayload(env, job.input_object_key);
}

async function getJobById(db: D1Database, jobId: string): Promise<AsyncJobRow | null> {
  return db.prepare("SELECT * FROM default_multimodal_jobs WHERE id = ?")
    .bind(jobId).first<AsyncJobRow>();
}

async function findByIdempotency(
  db: D1Database,
  installationHash: string,
  idempotencyHash: string
): Promise<AsyncJobRow | null> {
  return db.prepare(
    `SELECT * FROM default_multimodal_jobs
     WHERE installation_hash = ? AND idempotency_hash = ?`
  ).bind(installationHash, idempotencyHash).first<AsyncJobRow>();
}

async function markPending(db: D1Database, jobId: string): Promise<void> {
  if (!jobId) return;
  await db.prepare(
    "UPDATE default_multimodal_jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'running'"
  ).bind(new Date().toISOString(), jobId).run();
}

async function deletePayload(env: Env, key: string | null): Promise<void> {
  if (!key) return;
  try {
    await env.MODEL_JOB_PAYLOADS.delete(key);
  } catch (error) {
    console.error(JSON.stringify({
      event: "default_multimodal_payload_delete_failed",
      key,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

function queuedResponse(job: AsyncJobRow): AsyncHandlerResult {
  if (job.status === "succeeded" || job.status === "failed") {
    return { status: 200, body: { jobId: job.id, status: job.status } };
  }
  return { status: 202, body: { jobId: job.id, status: job.status, retryAfterMs: 2_000 } };
}

function retryDelaySeconds(value: string | null, fallback = 30): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(300, Math.max(1, Math.round(seconds)))
    : fallback;
}

async function readBoundedError(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500).replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
  } catch {
    return `HTTP ${response.status}`;
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500).replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function chinaDateKey(): string {
  return new Date(Date.now() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
