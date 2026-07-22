import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import {
  getDefaultModelInstallationStats,
  getDefaultModelStatsHistory,
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

  prepare(sql: string) {
    const self = this;
    return {
      bind(...args: unknown[]) {
        return { sql, args };
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

function env(overrides: Record<string, unknown> = {}) {
  return {
    STATS: new MemoryKv(),
    RELEASES: {},
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
