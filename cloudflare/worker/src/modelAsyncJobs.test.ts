import { describe, expect, it, vi } from "vitest";
import {
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

const metadata: ModelClientMetadata = {
  installationId: "123e4567-e89b-42d3-a456-426614174000",
  taskType: "observer_batch",
  clientVersion: "0.4.5",
};

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
      stream: true,
      stream_options: { include_usage: true },
    });
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
