import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelGateway } from "../ModelGateway";
import { OfflineFixtureTransport } from "./offlineFixtureTransport";

const fixtureSchema = z.object({ facts: z.array(z.string()) });

function setup(scenarios: Parameters<OfflineFixtureTransport["registerScenario"]>[1]) {
  const transport = new OfflineFixtureTransport();
  transport.registerScenario("test-config", scenarios);
  const markSucceeded = vi.fn();
  const markFailed = vi.fn();
  const gateway = new ModelGateway({
    settingsService: {
      getModelConfigById: () => ({
        id: "test-config",
        kind: "multimodal",
        endpoint: "https://offline.fixture",
        model: "fixture-model",
        enabled: true,
        optionsJson: "{}",
      }),
      isVerboseModelIO: () => false,
    } as never,
    secretService: { getApiKey: async () => "fixture-secret" } as never,
    modelJobRepo: {
      create: () => ({ id: "fixture-job" }),
      markRunning: vi.fn(),
      markSucceeded,
      markFailed,
    } as never,
    fetchImpl: transport.forConfig("test-config"),
  });
  return { gateway, transport, markSucceeded, markFailed };
}

function input() {
  return {
    kind: "multimodal" as const,
    configId: "test-config",
    systemPrompt: "Return fixture facts.",
    userPrompt: "Extract facts.",
    jobType: "offline_fixture",
  };
}

describe("OfflineFixtureTransport through ModelGateway", () => {
  it("runs a fixture through HTTP decoding, Zod, metrics, and model-job persistence", async () => {
    const ctx = setup([{
      rawResponse: { facts: ["fact 1", "fact 2"] },
      usage: { promptTokens: 20, completionTokens: 8, cachedPromptTokens: 12 },
    }]);

    const result = await ctx.gateway.callMultimodal(input(), fixtureSchema);

    expect(result).toMatchObject({
      ok: true,
      data: { facts: ["fact 1", "fact 2"] },
      requestCount: 1,
      usage: { promptTokens: 20, completionTokens: 8, cachedPromptTokens: 12 },
    });
    expect(ctx.transport.requests).toHaveLength(1);
    expect(ctx.markSucceeded).toHaveBeenCalledWith(
      "fixture-job",
      JSON.stringify({ facts: ["fact 1", "fact 2"] }),
      1,
      undefined,
      undefined,
      expect.objectContaining({ requestCount: 1, cachedPromptTokens: 12 })
    );
  });

  it("preserves provider Retry-After metadata on an offline 429", async () => {
    const ctx = setup([{
      rawResponse: {},
      httpStatus: 429,
      headers: { "Retry-After": "3" },
    }]);

    const result = await ctx.gateway.callMultimodal(input(), fixtureSchema);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "rate_limited",
      retryAfterMs: 3000,
      rateLimitKey: "test-config",
      requestCount: 1,
    });
    expect(ctx.markFailed).toHaveBeenCalledOnce();
  });

  it("uses the production schema failure path rather than validating inside the fixture helper", async () => {
    const ctx = setup([{ rawResponse: { facts: "not-an-array" } }]);

    const result = await ctx.gateway.callMultimodal(
      { ...input(), disableRepair: true },
      fixtureSchema
    );

    expect(result).toMatchObject({ ok: false, errorCode: "schema_invalid", requestCount: 1 });
    expect(ctx.markFailed).toHaveBeenCalledOnce();
  });
});
