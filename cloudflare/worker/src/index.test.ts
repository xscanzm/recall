import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  getDefaultModelInstallationStats,
  getDefaultModelStatsHistory,
  hmacInstallationId,
  recordDefaultModelCall,
} from "./stats";

class MemoryKv {
  readonly values = new Map<string, string>();

  async get(key: string, type?: string): Promise<unknown> {
    const value = this.values.get(key) ?? null;
    return type === "json" && value ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async list(input: { prefix?: string }): Promise<unknown> {
    const prefix = input.prefix ?? "";
    return {
      keys: [...this.values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    };
  }
}

class MemoryD1 {
  readonly daily = new Map<string, { total_calls: number; successes: number; failures: number; language_calls: number; multimodal_calls: number }>();
  readonly dailyTasks = new Map<string, number>();
  readonly dailyInstallations = new Set<string>();
  readonly installations = new Map<string, { total_calls: number; successes: number; failures: number; language_calls: number; multimodal_calls: number; first_seen_at: string; last_seen_at: string; client_version: string }>();
  readonly installationTasks = new Map<string, number>();
  readonly rateLimits = new Map<string, number>();
  readonly jobs = new Map<string, Record<string, unknown>>();

  prepare(sql: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- 下面的 async 方法是对象字面量方法，不共享外层 this
    const self = this;
    return {
      bind(...args: unknown[]) {
        return {
          sql,
          args,
          async first<T>(): Promise<T | null> {
            if (sql.includes("model_proxy_rate_limits")) {
              // 等价于 D1 的原子自增：同步读改写由 JS 单线程串行化，无丢失
              const [day, ip] = args as [string, string];
              const key = `${String(day)}\u0000${String(ip)}`;
              const n = (self.rateLimits.get(key) ?? 0) + 1;
              self.rateLimits.set(key, n);
              return { n } as T;
            }
            if (sql.includes("FROM default_multimodal_jobs")) {
              const [jobId, installationHash, now] = args as [string, string, string];
              const job = self.jobs.get(jobId);
              if (!job || job.installation_hash !== installationHash || String(job.expires_at) <= String(now)) return null;
              return job as T;
            }
            return null;
          },
          async run() {
            if (sql.includes("default_multimodal_jobs") && sql.includes("SET delivered_at")) {
              const job = self.jobs.get(String(args[0]));
              if (job) job.delivered_at = String(args[0]);
            }
            if (sql.includes("DELETE FROM default_multimodal_jobs")) {
              self.jobs.delete(String(args[0]));
            }
            return { success: true };
          },
        };
      },
      async all<T>() {
        if (sql.includes("FROM model_daily_stats")) {
          return { results: [...self.daily.entries()].map(([date, value]) => ({ date, ...value })) as T[] };
        }
        if (sql.includes("FROM model_daily_tasks")) {
          return { results: [...self.dailyTasks.entries()].map(([key, calls]) => { const [date, task] = key.split("\u0000"); return { date, task, calls }; }) as T[] };
        }
        if (sql.includes("FROM model_daily_installations")) {
          return { results: [...self.dailyInstallations].map((key) => { const [date, installation_hash] = key.split("\u0000"); return { date, installation_hash }; }) as T[] };
        }
        if (sql.includes("FROM model_installations")) {
          return { results: [...self.installations.entries()].map(([installation_hash, value]) => ({ installation_hash, ...value })) as T[] };
        }
        if (sql.includes("FROM model_installation_tasks")) {
          return { results: [...self.installationTasks.entries()].map(([key, calls]) => { const [installation_hash, task] = key.split("\u0000"); return { installation_hash, task, calls }; }) as T[] };
        }
        return { results: [] as T[] };
      },
    };
  }

  async batch(statements: Array<{ sql: string; args: unknown[] }>) {
    for (const statement of statements) {
      const [first, second, third, fourth, fifth, sixth, seventh, eighth] = statement.args;
      if (statement.sql.includes("model_daily_stats")) {
        const date = String(first);
        const current = this.daily.get(date) ?? { total_calls: 0, successes: 0, failures: 0, language_calls: 0, multimodal_calls: 0 };
        current.total_calls += 1; current.successes += Number(second); current.failures += Number(third); current.language_calls += Number(fourth); current.multimodal_calls += Number(fifth); this.daily.set(date, current);
      } else if (statement.sql.includes("model_daily_tasks")) {
        const key = `${String(first)}\u0000${String(second)}`; this.dailyTasks.set(key, (this.dailyTasks.get(key) ?? 0) + 1);
      } else if (statement.sql.includes("model_daily_installations")) {
        this.dailyInstallations.add(`${String(first)}\u0000${String(second)}`);
      } else if (statement.sql.includes("model_installations")) {
        const hash = String(first); const current = this.installations.get(hash) ?? { total_calls: 0, successes: 0, failures: 0, language_calls: 0, multimodal_calls: 0, first_seen_at: String(sixth), last_seen_at: String(seventh), client_version: String(eighth) };
        current.total_calls += 1; current.successes += Number(second); current.failures += Number(third); current.language_calls += Number(fourth); current.multimodal_calls += Number(fifth); current.last_seen_at = String(seventh); current.client_version = String(eighth); this.installations.set(hash, current);
      } else if (statement.sql.includes("model_installation_tasks")) {
        const key = `${String(first)}\u0000${String(second)}`; this.installationTasks.set(key, (this.installationTasks.get(key) ?? 0) + 1);
      }
    }
    return [];
  }
}

class MemoryBucket {
  constructor(private readonly manifest: string) {}

  async get(key: string): Promise<unknown> {
    if (key !== "manifest.json") return null;
    return { text: async () => this.manifest };
  }
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    STATS: new MemoryKv(),
    RELEASES: {},
    MODEL_STATS: new MemoryD1(),
    DEFAULT_LANGUAGE_API_KEY: "worker-secret",
    DEFAULT_LANGUAGE_API_URL: "https://upstream.example",
    DEFAULT_LANGUAGE_MODEL: "fixed-language-model",
    DEFAULT_MULTIMODAL_API_KEY: "worker-vision-secret",
    DEFAULT_MULTIMODAL_API_URL: "https://upstream.example",
    DEFAULT_MULTIMODAL_MODEL: "fixed-vision-model",
    ...overrides,
  } as never;
}

function modelRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`https://recall-update.ppclaw.online${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Recall-Installation-Id": "123e4567-e89b-42d3-a456-426614174000",
      "X-Recall-Task-Type": "reporter",
      "X-Recall-Client-Version": "0.4.4",
    },
    body: JSON.stringify(body),
  });
}

function modelRequestWithIp(path: string, body: Record<string, unknown>, ip: string): Request {
  const request = modelRequest(path, body);
  request.headers.set("CF-Connecting-IP", ip);
  return request;
}

function statusPollRequest(jobId: string, ip: string): Request {
  return new Request(`https://recall-update.ppclaw.online/api/model/multimodal/jobs/${jobId}`, {
    headers: {
      "X-Recall-Installation-Id": "123e4567-e89b-42d3-a456-426614174000",
      "X-Recall-Task-Type": "vision",
      "X-Recall-Client-Version": "0.4.4",
      "CF-Connecting-IP": ip,
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("default model proxy", () => {
  it("injects the fixed model and Worker secret while streaming the response", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    vi.stubGlobal("fetch", fetchImpl);
    const response = await worker.fetch(modelRequest(
      "/api/model/language/v1/chat/completions",
      { model: "client-controlled", messages: [{ role: "user", content: "hello" }], stream: true }
    ), env(), { waitUntil: vi.fn() } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe("data: [DONE]\n\n");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://upstream.example/v1/chat/completions");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer worker-secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "fixed-language-model", stream: true });
  });

  it("fails clearly when the corresponding Worker Secret is absent", async () => {
    const response = await worker.fetch(modelRequest(
      "/api/model/language/v1/chat/completions",
      { messages: [{ role: "user", content: "hello" }] }
    ), env({ DEFAULT_LANGUAGE_API_KEY: undefined }), { waitUntil: vi.fn() } as never);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "capability-unavailable" });
  });
});

describe("update artifact selection", () => {
  const manifest = JSON.stringify({
    version: "0.5.8",
    downloadUrl: "/download/Recall-0.5.8-setup.exe",
    sha256: "a".repeat(64),
    releaseNotes: "notes",
    publishedAt: "2026-07-31T00:00:00.000Z",
    platforms: {
      win: { downloadUrl: "/download/Recall-0.5.8-setup.exe", sha256: "a".repeat(64) },
      mac: { downloadUrl: "/download/Recall-0.5.8-mac-arm64.dmg", sha256: "b".repeat(64) },
      macArm64: { downloadUrl: "/download/Recall-0.5.8-mac-arm64.dmg", sha256: "b".repeat(64) },
      macX64: { downloadUrl: "/download/Recall-0.5.8-mac-x64.dmg", sha256: "c".repeat(64) },
    },
  });

  it.each([
    ["arm64", "/download/Recall-0.5.8-mac-arm64.dmg", "b".repeat(64)],
    ["x64", "/download/Recall-0.5.8-mac-x64.dmg", "c".repeat(64)],
  ])("selects the %s macOS artifact", async (arch, downloadUrl, sha256) => {
    const response = await worker.fetch(
      new Request(`https://recall-update.ppclaw.online/api/check?currentVersion=0.5.7&platform=darwin&arch=${arch}`),
      env({ RELEASES: new MemoryBucket(manifest) }) as never,
      { waitUntil: vi.fn() } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ downloadUrl, sha256 });
  });
});

describe("default model statistics", () => {
  it("stores only HMAC installation hashes and aggregates calls", async () => {
    const kv = new MemoryD1();
    const base = {
      date: "2026-07-22",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "language" as const,
      taskType: "reporter",
      clientVersion: "0.4.4",
    };
    await recordDefaultModelCall(kv as never, "hash-secret", { ...base, status: "success" });
    await recordDefaultModelCall(kv as never, "hash-secret", { ...base, status: "failure" });

    expect(JSON.stringify(kv)).not.toContain(base.installationId);
    const [day] = await getDefaultModelStatsHistory(kv as never);
    expect(day).toMatchObject({ totalCalls: 2, successes: 1, failures: 1, languageCalls: 2 });
    expect(day.installationHashes).toHaveLength(1);
    const [installation] = await getDefaultModelInstallationStats(kv as never);
    expect(installation).toMatchObject({ totalCalls: 2, failures: 1, clientVersion: "0.4.4" });
  });

  it("increments concurrent calls without read-modify-write loss", async () => {
    const d1 = new MemoryD1();
    const base = { date: "2026-07-22", installationId: "123e4567-e89b-42d3-a456-426614174000", kind: "language" as const, taskType: "reporter", clientVersion: "0.4.4" };
    await Promise.all(Array.from({ length: 50 }, () => recordDefaultModelCall(d1 as never, "hash-secret", { ...base, status: "success" })));
    const [day] = await getDefaultModelStatsHistory(d1 as never);
    expect(day.totalCalls).toBe(50);
    const [installation] = await getDefaultModelInstallationStats(d1 as never);
    expect(installation.totalCalls).toBe(50);
  });
});

const COMPLETION_BODY = { messages: [{ role: "user", content: "hello" }] };
const TEST_INSTALLATION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TEST_JOB_ID = "mmj_00000000-0000-4000-8000-000000000000";
const RATE_LIMITED_IP = "203.0.113.7";

function stubUpstream(okBody = "ok"): ReturnType<typeof vi.fn> {
  const fetchImpl = vi.fn(async () => new Response(okBody, { status: 200 }));
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("model proxy per-IP rate limit (D1 atomic counter)", () => {
  it("allows the first 200 daily calls and rejects the 201st with 429 + Retry-After, without hitting upstream", async () => {
    const fetchImpl = stubUpstream();
    const d1 = new MemoryD1();
    const callEnv = env({ MODEL_STATS: d1 }) as never;
    for (let i = 0; i < 200; i += 1) {
      const response = await worker.fetch(
        modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, RATE_LIMITED_IP),
        callEnv,
        { waitUntil: vi.fn() } as never,
      );
      expect(response.status).toBe(200);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(200);

    const blocked = await worker.fetch(
      modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, RATE_LIMITED_IP),
      callEnv,
      { waitUntil: vi.fn() } as never,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("86400");
    await expect(blocked.json()).resolves.toEqual({ error: "rate-limited" });
    expect(fetchImpl).toHaveBeenCalledTimes(200);
    expect([...d1.rateLimits.values()]).toEqual([201]);
  });

  it("passes 50 sequential calls from the same IP (normal session unaffected)", async () => {
    stubUpstream();
    const d1 = new MemoryD1();
    const callEnv = env({ MODEL_STATS: d1 }) as never;
    for (let i = 0; i < 50; i += 1) {
      const response = await worker.fetch(
        modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, RATE_LIMITED_IP),
        callEnv,
        { waitUntil: vi.fn() } as never,
      );
      expect(response.status).toBe(200);
    }
    expect([...d1.rateLimits.values()]).toEqual([50]);
  });

  it("counts multimodal job submissions on the same shared per-IP counter", async () => {
    stubUpstream();
    const d1 = new MemoryD1();
    const callEnv = env({ MODEL_STATS: d1, MODEL_STATS_HASH_SECRET: "hash-secret" }) as never;
    for (let i = 0; i < 200; i += 1) {
      await worker.fetch(
        modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, RATE_LIMITED_IP),
        callEnv,
        { waitUntil: vi.fn() } as never,
      );
    }
    const blocked = await worker.fetch(
      modelRequestWithIp("/api/model/multimodal/jobs", COMPLETION_BODY, RATE_LIMITED_IP),
      callEnv,
      { waitUntil: vi.fn() } as never,
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("86400");
    await expect(blocked.json()).resolves.toEqual({ error: "rate-limited" });
  });

  it("shares the budget across IPv6 addresses within the same /64", async () => {
    stubUpstream();
    const d1 = new MemoryD1();
    const callEnv = env({ MODEL_STATS: d1, MODEL_PROXY_DAILY_LIMIT_PER_IP: "1" }) as never;
    const first = await worker.fetch(
      modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, "2001:db8:85a3:0:0:8a2e:370:7334"),
      callEnv,
      { waitUntil: vi.fn() } as never,
    );
    expect(first.status).toBe(200);
    const sibling = await worker.fetch(
      modelRequestWithIp("/api/model/language/v1/chat/completions", COMPLETION_BODY, "2001:db8:85a3:0:1111:2222:3333:4444"),
      callEnv,
      { waitUntil: vi.fn() } as never,
    );
    expect(sibling.status).toBe(429);
  });

  it("does not count status polling against the limit (1000th poll from the same IP still passes)", async () => {
    const d1 = new MemoryD1();
    const installationHash = await hmacInstallationId(TEST_INSTALLATION_ID, "hash-secret");
    d1.jobs.set(TEST_JOB_ID, {
      id: TEST_JOB_ID,
      installation_hash: installationHash,
      status: "running",
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    const pollEnv = env({
      MODEL_STATS: d1,
      MODEL_STATS_HASH_SECRET: "hash-secret",
      MODEL_PROXY_DAILY_LIMIT_PER_IP: "1",
    }) as never;
    for (let i = 0; i < 1000; i += 1) {
      const response = await worker.fetch(statusPollRequest(TEST_JOB_ID, RATE_LIMITED_IP), pollEnv, {} as never);
      expect(response.status).not.toBe(429);
    }
    expect(d1.rateLimits.size).toBe(0);
  });

  it("a complete async job poll sequence never trips the limit", async () => {
    const d1 = new MemoryD1();
    const installationHash = await hmacInstallationId(TEST_INSTALLATION_ID, "hash-secret");
    d1.jobs.set(TEST_JOB_ID, {
      id: TEST_JOB_ID,
      installation_hash: installationHash,
      status: "running",
      result_json: null,
      error_code: null,
      error_message: null,
      delivered_at: null,
      expires_at: "2999-01-01T00:00:00.000Z",
    });
    const pollEnv = env({ MODEL_STATS: d1, MODEL_STATS_HASH_SECRET: "hash-secret" }) as never;
    for (let i = 0; i < 60; i += 1) {
      const response = await worker.fetch(statusPollRequest(TEST_JOB_ID, RATE_LIMITED_IP), pollEnv, {} as never);
      expect(response.status).toBe(202);
    }
    d1.jobs.set(TEST_JOB_ID, {
      ...d1.jobs.get(TEST_JOB_ID),
      status: "succeeded",
      result_json: JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }),
    });
    const final = await worker.fetch(statusPollRequest(TEST_JOB_ID, RATE_LIMITED_IP), pollEnv, {} as never);
    expect(final.status).toBe(200);
    await expect(final.json()).resolves.toMatchObject({ status: "succeeded" });
    expect(d1.rateLimits.size).toBe(0);
  });
});

function statsRequest(path: string, authorization?: string): Request {
  return new Request(`https://recall-update.ppclaw.online${path}`, {
    headers: authorization ? { Authorization: authorization } : {},
  });
}

function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

describe("stats read authorization", () => {
  const readEnv = (token?: string) =>
    env({ STATS_READ_TOKEN: token, MODEL_STATS: new MemoryD1() });

  it("accepts the configured bearer token", async () => {
    const response = await worker.fetch(
      statsRequest("/api/metrics/daily?date=2026-07-22", "Bearer read-token"),
      readEnv("read-token") as never,
      {} as never,
    );
    expect(response.status).toBe(200);
  });

  it("hides the endpoint as 404 when the token is wrong or absent", async () => {
    for (const authorization of [undefined, "Bearer wrong", "Bearer ", "Basic cmVhZDp0b2tlbg=="]) {
      const response = await worker.fetch(
        statsRequest("/api/metrics/daily", authorization),
        readEnv("read-token") as never,
        {} as never,
      );
      expect(response.status).toBe(404);
    }
  });

  it("denies everything when no token is configured", async () => {
    // 没配密钥不等于不设防：不能退化成任何人都能读。
    for (const token of [undefined, "", "   "]) {
      const response = await worker.fetch(
        statsRequest("/api/metrics/daily", "Bearer read-token"),
        readEnv(token) as never,
        {} as never,
      );
      expect(response.status).toBe(404);
    }
  });
});

describe("stats admin authorization", () => {
  const adminEnv = () =>
    env({
      STATS_ADMIN_USERNAME: "ops",
      STATS_ADMIN_PASSWORD: "s3cret",
      MODEL_STATS: new MemoryD1(),
    });

  it("accepts the configured basic credentials", async () => {
    const response = await worker.fetch(
      statsRequest("/admin/stats", basic("ops", "s3cret")),
      adminEnv() as never,
      {} as never,
    );
    expect(response.status).toBe(200);
  });

  it("rejects a wrong username, a wrong password, and a wrong both", async () => {
    // 三种都必须是同一个 401：响应上不能区分"哪一半错了"。
    for (const authorization of [
      basic("nope", "s3cret"),
      basic("ops", "nope"),
      basic("nope", "nope"),
    ]) {
      const response = await worker.fetch(
        statsRequest("/admin/stats", authorization),
        adminEnv() as never,
        {} as never,
      );
      expect(response.status).toBe(401);
    }
  });

  it("rejects malformed or missing authorization headers", async () => {
    for (const authorization of [
      undefined,
      "Bearer s3cret",
      "Basic not-valid-base64!!",
      `Basic ${btoa("no-separator")}`,
    ]) {
      const response = await worker.fetch(
        statsRequest("/admin/stats", authorization),
        adminEnv() as never,
        {} as never,
      );
      expect(response.status).toBe(401);
    }
  });

  it("denies access when admin credentials are not configured", async () => {
    const response = await worker.fetch(
      statsRequest("/admin/stats", basic("ops", "s3cret")),
      env({ MODEL_STATS: new MemoryD1() }) as never,
      {} as never,
    );
    expect(response.status).toBe(401);
  });

  it("does not accept a credential pair that only shares a prefix", async () => {
    for (const authorization of [basic("op", "s3cret"), basic("ops", "s3cre"), basic("ops", "s3crett")]) {
      const response = await worker.fetch(
        statsRequest("/admin/stats", authorization),
        adminEnv() as never,
        {} as never,
      );
      expect(response.status).toBe(401);
    }
  });
});
