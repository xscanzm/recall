import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MODEL_PROMPT_TEXT_CHARS, ModelGateway } from "./ModelGateway";
import {
  RECALL_DEFAULT_LANGUAGE_CONFIG_ID,
  RECALL_DEFAULT_MULTIMODAL_CONFIG_ID,
} from "./ModelTargets";

const schema = {
  safeParse: (input: unknown) => ({ success: true as const, data: input }),
};

function makeGateway(response: Response | Response[], config: {
  model?: string;
  optionsJson?: string;
} = {}) {
  const responses = Array.isArray(response) ? [...response] : [response];
  vi.stubGlobal("fetch", vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No mocked response remaining");
    return next;
  }));
  const markSucceeded = vi.fn();
  const markFailed = vi.fn();
  const gateway = new ModelGateway({
    settingsService: {
      getModelConfigById: vi.fn(() => ({
        id: "model",
        kind: "multimodal",
        endpoint: "https://example.test/v1",
        model: config.model ?? "test-model",
        enabled: true,
        optionsJson: config.optionsJson ?? "{}",
      })),
      isVerboseModelIO: vi.fn(() => false),
    } as never,
    secretService: { getApiKey: vi.fn(async () => "secret") } as never,
    modelJobRepo: {
      create: vi.fn(() => ({ id: "job-1" })),
      markRunning: vi.fn(),
      markSucceeded,
      markFailed,
    } as never,
  });
  return { gateway, markSucceeded, markFailed };
}

function sseResponse(events: unknown[], includeDone = true): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
    + (includeDone ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function input(streaming = false) {
  return {
    kind: "multimodal" as const,
    configId: "model",
    systemPrompt: "",
    userPrompt: "build timeline",
    jobType: "timeline_builder",
    maxTokens: 8192,
    streaming,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelGateway response diagnostics", () => {
  it("blocks oversized prompt text before network submission", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }));

    const result = await setup.gateway.callMultimodal({
      ...input(),
      userPrompt: "x".repeat(MAX_MODEL_PROMPT_TEXT_CHARS + 1),
    }, schema);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "input_too_large",
      attempts: 0,
      requestCount: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(setup.markFailed).toHaveBeenCalledWith(
      "job-1",
      "input_too_large",
      expect.stringContaining("已在提交前拦截"),
      0,
      null,
      undefined,
      undefined,
      expect.objectContaining({ requestCount: 0 })
    );
  });

  it("uses the expanded default max_tokens for extraction requests", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }));

    const result = await setup.gateway.callMultimodal({ ...input(), maxTokens: undefined }, schema);

    expect(result.ok).toBe(true);
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request.max_tokens).toBe(16_384);
  });

  it("does not send reasoning_effort to generic models", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result.ok).toBe(true);
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request.reasoning_effort).toBeUndefined();
  });

  it("defaults SenseNova flash-lite requests to reasoning_effort none", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }), { model: "SenseTime/sensenova-6.7-flash-lite" });

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result.ok).toBe(true);
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request.reasoning_effort).toBe("none");
  });

  it("preserves an explicit reasoning_effort option for SenseNova", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }), {
      model: "sensenova-6.7-flash-lite",
      optionsJson: JSON.stringify({ reasoning_effort: "low" }),
    });

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result.ok).toBe(true);
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request.reasoning_effort).toBe("low");
  });

  it("applies SenseNova reasoning compatibility to JSON repair requests", async () => {
    const setup = makeGateway([
      Response.json({ choices: [{ message: { content: "not json" }, finish_reason: "stop" }] }),
      Response.json({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }),
    ], { model: "sensenova-6.7-flash-lite" });

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const repairRequest = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(repairRequest.reasoning_effort).toBe("none");
  });

  it("omits response_format for text fallback requests", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
    }));

    const result = await setup.gateway.callMultimodal({ ...input(), responseFormat: "text" }, schema);

    expect(result.ok).toBe(true);
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request.response_format).toBeUndefined();
  });

  it("does not call repair when disableRepair is enabled", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
    }));

    const result = await setup.gateway.callMultimodal({ ...input(), disableRepair: true }, schema);

    expect(result).toMatchObject({ ok: false, errorCode: "invalid_json", attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns output_truncated without attempting JSON repair when finish_reason is length", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"blocks\":[" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1000, completion_tokens: 8192 },
    }));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "output_truncated",
      modelJobId: "job-1",
      attempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(setup.markFailed).toHaveBeenCalledWith(
      "job-1",
      "output_truncated",
      expect.stringContaining("max_tokens=8192"),
      1,
      "{\"blocks\":[",
      undefined,
      undefined,
      expect.objectContaining({
        promptTokens: 1000,
        completionTokens: 8192,
        requestCount: 1,
      })
    );
  });

  it("classifies HTTP 504 as a retryable network error", async () => {
    const setup = makeGateway(Response.json(
      { error: { message: "Gateway timeout" } },
      { status: 504 }
    ));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({ ok: false, errorCode: "network_error", modelJobId: "job-1" });
    expect(result.errorMessage).toContain("HTTP 504");
  });

  it("classifies HTTP 520/524 as a non-retryable upstream timeout", async () => {
    const setup = makeGateway(Response.json(
      { error: { message: "A timeout occurred" } },
      { status: 524 }
    ));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "upstream_timeout",
      requestCount: 1,
    });
    expect(result.errorMessage).toContain("未自动重试");
  });

  it("propagates Retry-After, rate-limit key, and zero-safe request metrics", async () => {
    const setup = makeGateway(Response.json(
      { error: { message: "slow down" } },
      { status: 429, headers: { "Retry-After": "7" } }
    ));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({
      ok: false,
      errorCode: "rate_limited",
      retryAfterMs: 7000,
      rateLimitKey: "model",
      requestCount: 1,
    });
    expect(setup.markFailed).toHaveBeenCalledWith(
      "job-1",
      "rate_limited",
      expect.any(String),
      1,
      null,
      undefined,
      undefined,
      expect.objectContaining({ requestCount: 1 })
    );
  });

  it("classifies a non-JSON HTTP 200 envelope as response_invalid", async () => {
    const setup = makeGateway(new Response("<html>proxy error</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    }));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({ ok: false, errorCode: "response_invalid", modelJobId: "job-1" });
    expect(result.errorMessage).toContain("HTTP 200");
  });

  it("assembles SSE deltas before validating the final JSON", async () => {
    const setup = makeGateway(sseResponse([
      { choices: [{ delta: { content: "{\"ok\":" }, finish_reason: null }] },
      { choices: [{ delta: { content: "true}" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 500_000, completion_tokens: 12 } },
    ]));

    const result = await setup.gateway.callMultimodal(input(true), schema);

    expect(result).toMatchObject({
      ok: true,
      data: { ok: true },
      usage: { promptTokens: 500_000, completionTokens: 12 },
      requestCount: 1,
    });
    const request = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(request).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it("falls back from stream_options to basic streaming when the provider rejects it", async () => {
    const setup = makeGateway([
      Response.json({ error: { message: "stream_options is unsupported" } }, { status: 400 }),
      sseResponse([{ choices: [{ delta: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }]),
    ]);

    const result = await setup.gateway.callMultimodal(input(true), schema);

    expect(result.ok).toBe(true);
    expect(result.requestCount).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    const secondRequest = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].body);
    expect(secondRequest.stream).toBe(true);
    expect(secondRequest.stream_options).toBeUndefined();
  });

  it("falls back to non-streaming only before receiving stream content", async () => {
    const setup = makeGateway([
      Response.json({ error: { message: "stream_options is unsupported" } }, { status: 400 }),
      Response.json({ error: { message: "stream is unsupported" } }, { status: 400 }),
      Response.json({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }),
    ]);

    const result = await setup.gateway.callMultimodal(input(true), schema);

    expect(result.ok).toBe(true);
    expect(result.requestCount).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    const finalRequest = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[2][1].body);
    expect(finalRequest.stream).toBeUndefined();
  });

  it("does not replay a stream after partial content is interrupted", async () => {
    const setup = makeGateway(sseResponse([
      { choices: [{ delta: { content: "{\"ok\":" }, finish_reason: null }] },
    ], false));

    const result = await setup.gateway.callMultimodal(input(true), schema);

    expect(result).toMatchObject({ ok: false, errorCode: "network_error" });
    expect(result.errorMessage).toContain("提前结束");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns both job id fields on success", async () => {
    const setup = makeGateway(Response.json({
      choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 8 },
      },
    }));

    const result = await setup.gateway.callMultimodal(input(), schema);

    expect(result).toMatchObject({
      ok: true,
      jobId: "job-1",
      modelJobId: "job-1",
      requestCount: 1,
      usage: { promptTokens: 12, completionTokens: 5, cachedPromptTokens: 8 },
    });
    expect(setup.markSucceeded).toHaveBeenCalledOnce();
    expect(setup.markSucceeded).toHaveBeenCalledWith(
      "job-1",
      "{\"ok\":true}",
      1,
      undefined,
      undefined,
      expect.objectContaining({
        promptTokens: 12,
        completionTokens: 5,
        cachedPromptTokens: 8,
        requestCount: 1,
      })
    );
  });
});

describe("ModelGateway selected targets", () => {
  it("submits and polls default multimodal batch work without counting polls as model calls", async () => {
    const remoteJobId = "mmj_123e4567-e89b-42d3-a456-426614174000";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(
        { jobId: remoteJobId, status: "pending", retryAfterMs: 500 },
        { status: 202 }
      ))
      .mockResolvedValueOnce(Response.json({
        jobId: remoteJobId,
        status: "succeeded",
        response: {
          choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 8 },
        },
      }));
    const gateway = new ModelGateway({
      settingsService: { isVerboseModelIO: vi.fn(() => false) } as never,
      secretService: { getApiKey: vi.fn() } as never,
      modelJobRepo: {
        create: vi.fn(() => ({ id: "job-default-vision" })),
        markRunning: vi.fn(),
        markSucceeded: vi.fn(),
        markFailed: vi.fn(),
      } as never,
      defaultModelConsentService: { ensureAccepted: vi.fn(async () => true) } as never,
      installationIdentityService: { getId: vi.fn(() => "123e4567-e89b-42d3-a456-426614174000") } as never,
      clientVersion: "0.4.5",
      fetchImpl,
    });

    const result = await gateway.callByConfigId({
      kind: "multimodal",
      configId: RECALL_DEFAULT_MULTIMODAL_CONFIG_ID,
      systemPrompt: "",
      userPrompt: "batch",
      jobType: "observer_batch",
      streaming: true,
      background: { idempotencyKey: "observer_batch:batch-1" },
    }, schema);

    expect(result).toMatchObject({
      ok: true,
      data: { ok: true },
      requestCount: 1,
      usage: { promptTokens: 100, completionTokens: 8 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://recall-update.ppclaw.online/api/model/multimodal/jobs");
    expect(fetchImpl.mock.calls[1][0]).toBe(`https://recall-update.ppclaw.online/api/model/multimodal/jobs/${remoteJobId}`);
    expect((fetchImpl.mock.calls[0][1].headers as Record<string, string>)["X-Recall-Idempotency-Key"])
      .toBe("observer_batch:batch-1");
  });

  it("keeps a user-configured multimodal batch on the direct streaming endpoint", async () => {
    const setup = makeGateway(sseResponse([
      { choices: [{ delta: { content: "{\"ok\":true}" }, finish_reason: "stop" }] },
    ]));

    const result = await setup.gateway.callMultimodal({
      ...input(true),
      background: { idempotencyKey: "observer_batch:batch-1" },
    }, schema);

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
    const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers as Record<string, string>;
    expect(headers["X-Recall-Idempotency-Key"]).toBeUndefined();
  });

  it("uses the Recall proxy without Authorization and preserves headers for repair", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "not json" }, finish_reason: "stop" }] }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }));
    const gateway = new ModelGateway({
      settingsService: { isVerboseModelIO: vi.fn(() => false) } as never,
      secretService: { getApiKey: vi.fn() } as never,
      modelJobRepo: {
        create: vi.fn(() => ({ id: "job-default" })),
        markRunning: vi.fn(),
        markSucceeded: vi.fn(),
        markFailed: vi.fn(),
      } as never,
      defaultModelConsentService: { ensureAccepted: vi.fn(async () => true) } as never,
      installationIdentityService: { getId: vi.fn(() => "123e4567-e89b-42d3-a456-426614174000") } as never,
      clientVersion: "0.4.4",
      fetchImpl,
    });

    const result = await gateway.callByConfigId({
      kind: "language",
      configId: RECALL_DEFAULT_LANGUAGE_CONFIG_ID,
      systemPrompt: "",
      userPrompt: "test",
      jobType: "reporter",
    }, schema);

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe("https://recall-update.ppclaw.online/api/model/language/v1/chat/completions");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers["X-Recall-Installation-Id"]).toBe("123e4567-e89b-42d3-a456-426614174000");
      expect(headers["X-Recall-Task-Type"]).toBe("reporter");
      expect(headers["X-Recall-Client-Version"]).toBe("0.4.4");
    }
  });

  it("reports a selected user configuration failure without switching targets", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: "bad key" } }, { status: 401 }));
    const gateway = new ModelGateway({
      settingsService: {
        getModelConfigById: vi.fn(() => ({
          id: "user-language",
          kind: "language",
          endpoint: "https://user.example/v1",
          model: "user-model",
          enabled: true,
          optionsJson: "{}",
        })),
        isVerboseModelIO: vi.fn(() => false),
      } as never,
      secretService: { getApiKey: vi.fn(async () => "user-key") } as never,
      modelJobRepo: {
        create: vi.fn(() => ({ id: "job-user" })),
        markRunning: vi.fn(),
        markSucceeded: vi.fn(),
        markFailed: vi.fn(),
      } as never,
      fetchImpl,
    });
    const result = await gateway.callByConfigId({
      kind: "language",
      configId: "user-language",
      systemPrompt: "",
      userPrompt: "test",
      jobType: "reporter",
    }, schema);

    expect(result).toMatchObject({ ok: false, errorCode: "auth_error" });
    expect(result.errorMessage).toContain("用户模型配置调用失败");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
