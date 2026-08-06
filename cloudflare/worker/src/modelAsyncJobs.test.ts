import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consumeDefaultMultimodalJobs,
  getDefaultMultimodalJob,
  readUpstreamCompletion,
  submitDefaultMultimodalJob,
  type ModelClientMetadata,
} from "./modelAsyncJobs";

interface JobRow {
  id: string;
  installation_hash: string;
  idempotency_hash: string;
  task_type: string;
  client_version: string;
  status: string;
  input_object_key: string;
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

class AsyncMemoryD1 {
  readonly jobs = new Map<string, JobRow>();

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async <T>() => {
          if (sql.includes("installation_hash = ? AND idempotency_hash = ?")) {
            return [...this.jobs.values()].find((job) =>
              job.installation_hash === String(args[0]) && job.idempotency_hash === String(args[1])) as T ?? null;
          }
          if (sql.includes("id = ? AND installation_hash = ?")) {
            const job = this.jobs.get(String(args[0]));
            return (job?.installation_hash === String(args[1]) ? job : null) as T | null;
          }
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT INTO default_multimodal_jobs")) {
            const [id, installationHash, idempotencyHash, taskType, clientVersion, inputObjectKey, createdAt, updatedAt, expiresAt] = args;
            this.jobs.set(String(id), {
              id: String(id),
              installation_hash: String(installationHash),
              idempotency_hash: String(idempotencyHash),
              task_type: String(taskType),
              client_version: String(clientVersion),
              status: "pending",
              input_object_key: String(inputObjectKey),
              result_json: null,
              error_code: null,
              error_message: null,
              attempts: 0,
              created_at: String(createdAt),
              updated_at: String(updatedAt),
              completed_at: null,
              delivered_at: null,
              expires_at: String(expiresAt),
            });
          }
          return { success: true };
        },
      }),
    };
  }
}

class AsyncMemoryR2 {
  readonly values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

class ConsumerMemoryD1 {
  readonly jobs = new Map<string, JobRow>();

  seed(job: JobRow): void {
    this.jobs.set(job.id, job);
  }

  prepare(sql: string) {
    const jobs = this.jobs;
    return {
      bind(...args: unknown[]) {
        const bound = {
          sql,
          args,
          async first<T>(): Promise<T | null> {
            if (sql.includes("SELECT * FROM default_multimodal_jobs WHERE id = ?")) {
              const job = jobs.get(String(args[0]));
              return (job ?? null) as T | null;
            }
            return null;
          },
          async run() {
            if (sql.includes("SET status = 'running'")) {
              const job = jobs.get(String(args[1]));
              if (job && (job.status === "pending" || job.status === "running")) {
                job.status = "running";
                job.attempts += 1;
              }
            }
            return { success: true };
          },
        };
        return bound;
      },
    };
  }

  async batch(statements: Array<{ sql: string; args: unknown[] }>) {
    for (const statement of statements) {
      if (statement.sql.includes("SET status = 'failed'")) {
        const [errorCode, errorMessage, , , , jobId] = statement.args;
        const job = this.jobs.get(String(jobId));
        if (job && (job.status === "pending" || job.status === "running")) {
          job.status = "failed";
          job.error_code = String(errorCode);
          job.error_message = String(errorMessage);
        }
      }
    }
    return [];
  }
}

class ConsumerMemoryR2 {
  readonly values = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async get(key: string): Promise<{ body: Uint8Array } | null> {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return { body: new TextEncoder().encode(value) };
  }
}

const metadata: ModelClientMetadata = {
  installationId: "123e4567-e89b-42d3-a456-426614174000",
  taskType: "observer_batch",
  clientVersion: "0.4.5",
};

afterEach(() => vi.unstubAllGlobals());

describe("default multimodal async consumer", () => {
  const JOB_ID = "mmj_123e4567-e89b-42d3-a456-426614174000";
  const PAYLOAD_KEY = "default-multimodal-jobs/test.json";

  function seedPendingJob(db: ConsumerMemoryD1): void {
    db.seed({
      id: JOB_ID,
      installation_hash: "installation-hash",
      idempotency_hash: "idempotency-hash",
      task_type: "observer_batch",
      client_version: "0.4.5",
      status: "pending",
      input_object_key: PAYLOAD_KEY,
      result_json: null,
      error_code: null,
      error_message: null,
      attempts: 0,
      created_at: "2026-08-06T00:00:00.000Z",
      updated_at: "2026-08-06T00:00:00.000Z",
      completed_at: null,
      delivered_at: null,
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  }

  function consumerEnv(db: ConsumerMemoryD1, r2: ConsumerMemoryR2): never {
    return {
      MODEL_STATS: db,
      MODEL_JOB_PAYLOADS: r2,
      DEFAULT_MULTIMODAL_API_KEY: "upstream-secret",
    } as never;
  }

  function message(retry: ReturnType<typeof vi.fn>, ack: ReturnType<typeof vi.fn>): never {
    return { body: { version: 1, jobId: JOB_ID }, attempts: 1, retry, ack } as never;
  }

  it("classifies a non-streaming fetch timeout as terminal upstream_timeout without retrying", async () => {
    const db = new ConsumerMemoryD1();
    const r2 = new ConsumerMemoryR2();
    seedPendingJob(db);
    await r2.put(PAYLOAD_KEY, JSON.stringify({
      model: "fixed-model",
      messages: [{ role: "user", content: "hello" }],
    }));

    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      throw new DOMException("timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchImpl);
    const retry = vi.fn();
    const ack = vi.fn();

    await consumeDefaultMultimodalJobs(
      { messages: [message(retry, ack)] } as never,
      consumerEnv(db, r2)
    );

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeDefined();
    expect(retry).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalled();
    const job = db.jobs.get(JOB_ID)!;
    expect(job.status).toBe("failed");
    expect(job.error_code).toBe("upstream_timeout");
    expect(job.error_message).toContain("显式超时");
  });

  it("does not pass a timeout signal to the streaming async fetch", async () => {
    const db = new ConsumerMemoryD1();
    const r2 = new ConsumerMemoryR2();
    seedPendingJob(db);
    await r2.put(PAYLOAD_KEY, JSON.stringify({
      model: "fixed-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }));

    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchImpl);
    const retry = vi.fn();
    const ack = vi.fn();

    await consumeDefaultMultimodalJobs(
      { messages: [message(retry, ack)] } as never,
      consumerEnv(db, r2)
    );

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeUndefined();
    expect(ack).toHaveBeenCalled();
  });
});

describe("default multimodal async jobs", () => {
  it("stores the large request outside D1 and deduplicates queue submission", async () => {
    const db = new AsyncMemoryD1();
    const r2 = new AsyncMemoryR2();
    const send = vi.fn(async () => undefined);
    const env = {
      MODEL_STATS: db,
      MODEL_JOB_PAYLOADS: r2,
      DEFAULT_MULTIMODAL_JOBS: { send },
      MODEL_STATS_HASH_SECRET: "hash-secret",
      DEFAULT_MULTIMODAL_API_KEY: "upstream-secret",
    } as never;

    const first = await submitDefaultMultimodalJob(
      env,
      metadata,
      "observer_batch:batch-1",
      { model: "fixed-model", messages: [{ role: "user", content: "hello" }] }
    );
    const second = await submitDefaultMultimodalJob(
      env,
      metadata,
      "observer_batch:batch-1",
      { model: "fixed-model", messages: [{ role: "user", content: "hello" }] }
    );

    expect(first.status).toBe(202);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(send).toHaveBeenCalledOnce();
    expect(db.jobs).toHaveLength(1);
    const payload = JSON.parse([...r2.values.values()][0]!);
    expect(payload).toMatchObject({
      model: "fixed-model",
    });
    expect(payload.stream).toBeUndefined();
    expect(payload.stream_options).toBeUndefined();
    expect(JSON.stringify([...db.jobs.values()])).not.toContain("hello");
  });

  it("hides jobs from a different installation", async () => {
    const db = new AsyncMemoryD1();
    const env = {
      MODEL_STATS: db,
      MODEL_JOB_PAYLOADS: new AsyncMemoryR2(),
      DEFAULT_MULTIMODAL_JOBS: { send: vi.fn(async () => undefined) },
      MODEL_STATS_HASH_SECRET: "hash-secret",
      DEFAULT_MULTIMODAL_API_KEY: "upstream-secret",
    } as never;
    const created = await submitDefaultMultimodalJob(
      env,
      metadata,
      "observer_batch:batch-2",
      { model: "fixed-model", messages: [{ role: "user", content: "hello" }] }
    );
    const result = await getDefaultMultimodalJob(env, {
      ...metadata,
      installationId: "123e4567-e89b-42d3-a456-426614174001",
    }, String(created.body.jobId));
    expect(result).toEqual({ status: 404, body: { error: "job-not-found" } });
  });

  it("reassembles SSE split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"ok\\":"},"finish_reason":null}]}\n'));
        controller.enqueue(encoder.encode('\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const result = await readUpstreamCompletion(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    expect(result).toMatchObject({
      ok: true,
      completion: { choices: [{ message: { content: '{"ok":true}' } }] },
    });
  });

  it("treats 524 as terminal to avoid duplicate generation", async () => {
    const result = await readUpstreamCompletion(new Response("timeout", { status: 524 }));
    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_timeout",
      retryable: false,
    });
  });
});
