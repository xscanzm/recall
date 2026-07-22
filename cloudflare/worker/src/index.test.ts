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
    const kv = new MemoryKv();
    const base = {
      date: "2026-07-22",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      kind: "language" as const,
      taskType: "reporter",
      clientVersion: "0.4.4",
    };
    await recordDefaultModelCall(kv as never, "hash-secret", { ...base, status: "success" });
    await recordDefaultModelCall(kv as never, "hash-secret", { ...base, status: "failure" });

    expect([...kv.values.keys()].join("\n")).not.toContain(base.installationId);
    const [day] = await getDefaultModelStatsHistory(kv as never);
    expect(day).toMatchObject({ totalCalls: 2, successes: 1, failures: 1, languageCalls: 2 });
    expect(day.installationHashes).toHaveLength(1);
    const [installation] = await getDefaultModelInstallationStats(kv as never);
    expect(installation).toMatchObject({ totalCalls: 2, failures: 1, clientVersion: "0.4.4" });
  });
});
