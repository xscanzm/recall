// src/main/services/ModelGateway.ts
// 模型网关（来自 06_TECHNICAL_ARCHITECTURE.md / spec.md M2）
//
// 职责：
// - 读取模型配置（model_configs）
// - 从 SecretService 获取 API Key
// - 统一调用 OpenAI-compatible endpoint（chat completions API）
// - 支持 vision 和 language 两类模型
// - 处理超时（默认 60s）、网络错误、鉴权错误、限流
// - 第一版只做：endpoint、api key、model、temperature、max tokens、extra options JSON
// - 不做复杂 provider plugin
//
// 错误处理流程（来自 03 文档）：
// 1. 设置超时（AbortController + setTimeout，默认 60s）
// 2. 要求 JSON 输出（response_format: { type: "json_object" }）
// 3. 发送请求并处理 HTTP/网络/超时错误
// 4. JSON parse
// 5. zod schema 校验
// 6. 校验失败最多调用一次 JSON repair
// 7. 仍失败记录 model_job.status=failed
// 8. 不把无效输出写入正式表
//
// 失败状态码（来自 03 文档）：
// - timeout / network_error / auth_error / rate_limited
// - invalid_json / schema_invalid / safety_blocked / unknown_error
//
// 安全约束：
// - API Key 不进 prompt
// - API Key 不进日志
// - API Key 不进 SQLite
// - 完整模型输入输出不进日志（除非用户开启开发调试）
// - 连接测试失败时不显示 key

import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelConfig } from "../../shared/types";
import type { SettingsService } from "./SettingsService";
import type { SecretService } from "./SecretService";
import type {
  ModelJobErrorCode,
  ModelJobMetrics,
  ModelJobRepository,
} from "../db/repositories/ModelJobRepository";
import {
  COMMON_SYSTEM_PROMPT,
  JSON_REPAIR_PROMPT_TEMPLATE,
} from "../models/prompts";
import { zodToDescription } from "./zodToDescription";
import { logger } from "./Logger";
import { parseRetryAfterMs } from "./ModelJobQueue";
import type { DefaultModelConsentService } from "./DefaultModelConsentService";
import type { InstallationIdentityService } from "./InstallationIdentityService";
import {
  createRecallDefaultModelConfig,
  isRecallDefaultConfigId,
  RECALL_DEFAULT_MULTIMODAL_CONFIG_ID,
  type ModelTaskKind,
} from "./ModelTargets";

/**
 * 模型种类
 */
export type ModelKind = "vision" | "language" | "multimodal";

/**
 * 默认超时（毫秒）
 *
 * 取 120 秒（原 60s）：
 * - 视觉模型处理截图需要较长时间，60s 容易超时
 * - language 模型 deepseek-v4-flash 是 reasoning 模型，会消耗额外 reasoning_tokens
 * - 单独的视觉调用可由调用方通过 ModelCallInput.temperature/maxTokens 间接影响耗时
 */
export const DEFAULT_TIMEOUT_MS = 120_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const STREAM_TOTAL_TIMEOUT_MS = 10 * 60_000;
const ASYNC_MODEL_MIN_TOTAL_TIMEOUT_MS = 10 * 60_000;
const ASYNC_MODEL_POLL_REQUEST_TIMEOUT_MS = 30_000;
const ASYNC_MODEL_DEFAULT_POLL_MS = 2_000;

/**
 * 默认温度
 */
export const DEFAULT_TEMPERATURE = 0.3;

/**
 * 默认 max tokens。
 *
 * 结构化抽取任务可能同时返回关联、场景、判断和待办等多个数组，
 * 较小上限容易在 JSON 完成前触发 output_truncated；16384 给默认调用留出足够空间。
 */
export const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Final text-only request guard. Worker-level budgets should be much smaller;
 * this prevents accidental multi-megabyte prompts from reaching any provider.
 */
export const MAX_MODEL_PROMPT_TEXT_CHARS = 500_000;

/**
 * zod schema 接口（兼容 z.ZodType）
 */
export interface ZodSchemaLike<T> {
  safeParse: (input: unknown) => { success: true; data: T } | { success: false; error: { message: string } };
}

/**
 * 调用输入
 */
export interface ModelCallInput {
  /** 模型种类 */
  kind: ModelKind;
  /** 模型配置 id（从 model_configs 读取） */
  configId: string;
  /** 系统提示（自动拼接 COMMON_SYSTEM_PROMPT） */
  systemPrompt: string;
  /** 用户提示（纯文本） */
  userPrompt: string;
  /** 图片本地路径列表（仅 vision 模型使用） */
  imagePaths?: string[];
  /** 任务类型（用于 model_job.type 记录，如 vision_observation / extractor / linker） */
  jobType: string;
  /** 任务输入 JSON（用于 model_job.input_json 记录，调用方负责脱敏） */
  jobInputJson?: string;
  /** 温度（覆盖配置 options） */
  temperature?: number;
  /** max tokens（覆盖配置 options） */
  maxTokens?: number;
  /**
   * 单次调用超时覆盖（毫秒）。未指定时使用实例默认超时（120s）。
   * 批次模式（默认 6 帧多图）需要 180s，普通模式保持 120s。
   */
  timeoutMs?: number;
  /** 使用 OpenAI-compatible SSE 流式响应；适合长输出任务 */
  streaming?: boolean;
  /** Recall 默认多模态长任务使用异步提交；幂等键必须稳定对应同一逻辑批次。 */
  background?: { idempotencyKey: string };
  responseFormat?: "json" | "text";
  disableRepair?: boolean;
}

/**
 * 调用结果
 */
export interface ModelCallResult<T> {
  ok: boolean;
  data?: T;
  /** 失败错误码 */
  errorCode?: ModelJobErrorCode;
  /** 失败错误信息（不含 API Key） */
  errorMessage?: string;
  /** model_job id（用于追踪） */
  jobId?: string;
  /** 队列层使用的兼容字段 */
  modelJobId?: string;
  /** 尝试次数 */
  attempts?: number;
  /** usage 信息 */
  usage?: ModelUsage;
  /** Actual HTTP calls made by this gateway invocation, including compatibility fallbacks and repair. */
  requestCount?: number;
  /** Provider-directed delay for a rate-limited response. */
  retryAfterMs?: number | null;
  /** Stable key used by ModelJobQueue to isolate endpoint cooldowns. */
  rateLimitKey?: string;
  latencyMs?: number;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
}

/**
 * 测试连接输入
 */
export interface TestConnectionInput {
  kind: ModelKind;
  endpoint: string;
  model: string;
  apiKey: string;
}

/**
 * 测试连接结果
 */
export interface TestConnectionResult {
  ok: boolean;
  errorCode?: ModelJobErrorCode;
  errorMessage?: string;
}

/**
 * OpenAI chat completion 响应结构（仅取需要的字段）
 */
interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

interface ChatCompletionStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string };
}

interface ModelHttpResult {
  ok: boolean;
  content?: string;
  finishReason?: string;
  usage?: ModelUsage;
  errorCode?: ModelJobErrorCode;
  errorMessage?: string;
  receivedContent?: boolean;
  requestCount: number;
  retryAfterMs?: number | null;
}

/**
 * OpenAI chat completion 错误响应结构
 */
interface ChatCompletionErrorBody {
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
}

/**
 * ModelGateway 构造参数
 */
export interface ModelGatewayDeps {
  settingsService: SettingsService;
  secretService: SecretService;
  modelJobRepo: ModelJobRepository;
  /** 超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** Test seam for a fully offline OpenAI-compatible transport. */
  fetchImpl?: typeof fetch;
  defaultModelConsentService?: DefaultModelConsentService;
  installationIdentityService?: InstallationIdentityService;
  clientVersion?: string;
}

interface AsyncModelJobEnvelope {
  jobId?: string;
  status?: "pending" | "running" | "succeeded" | "failed";
  retryAfterMs?: number;
  response?: ChatCompletionResponse;
  errorCode?: ModelJobErrorCode;
  errorMessage?: string;
  error?: string;
}

/**
 * ModelGateway：统一调用 OpenAI-compatible endpoint
 *
 * 调用流程：
 * 1. 读取 model_config（SettingsService.getModelConfigById）
 * 2. 从 SecretService 获取 API Key（recall:model:<configId>:apiKey）
 * 3. 构造 OpenAI-compatible chat completion 请求
 * 4. 设置 60s 超时（AbortController）
 * 5. 发送请求
 * 6. 处理 HTTP/网络/超时错误
 * 7. JSON parse
 * 8. zod schema 校验
 * 9. 失败时调用一次 JSON repair
 * 10. 仍失败记录 model_job.status=failed
 * 11. 成功记录 model_job.status=succeeded
 */
export class ModelGateway {
  private readonly settingsService: SettingsService;
  private readonly secretService: SecretService;
  private readonly modelJobRepo: ModelJobRepository;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultModelConsentService?: DefaultModelConsentService;
  private readonly installationIdentityService?: InstallationIdentityService;
  private readonly clientVersion: string;

  constructor(deps: ModelGatewayDeps) {
    this.settingsService = deps.settingsService;
    this.secretService = deps.secretService;
    this.modelJobRepo = deps.modelJobRepo;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.defaultModelConsentService = deps.defaultModelConsentService;
    this.installationIdentityService = deps.installationIdentityService;
    this.clientVersion = deps.clientVersion ?? "unknown";
  }

  async resolveConfigId(taskKind: ModelTaskKind): Promise<string | null> {
    return this.settingsService.resolveModelConfigId(taskKind);
  }

  async callByConfigId<T>(
    input: ModelCallInput,
    schema: ZodSchemaLike<T>
  ): Promise<ModelCallResult<T>> {
    const config = createRecallDefaultModelConfig(input.configId)
      ?? this.settingsService.getModelConfigById(input.configId);
    if (!config) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `未找到模型配置: ${input.configId}`,
        requestCount: 0,
        rateLimitKey: input.configId,
      };
    }
    return this.callInternal({ ...input, kind: config.kind }, schema);
  }

  /**
   * 调用 vision 模型（图片 + 文本）
   *
   * @param input 调用输入
   * @param schema 输出 schema（zod）
   */
  async callVision<T>(
    input: ModelCallInput,
    schema: ZodSchemaLike<T>
  ): Promise<ModelCallResult<T>> {
    if (input.kind !== "vision") {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: "callVision 只接受 kind=vision 的调用",
        requestCount: 0,
        rateLimitKey: input.configId,
      };
    }
    if (!input.imagePaths || input.imagePaths.length === 0) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: "vision 调用必须提供至少一张图片",
        requestCount: 0,
        rateLimitKey: input.configId,
      };
    }
    return this.callInternal<T>(input, schema);
  }

  /**
   * 调用 language 模型（纯文本）
   *
   * @param input 调用输入
   * @param schema 输出 schema（zod）
   */
  async callLanguage<T>(
    input: ModelCallInput,
    schema: ZodSchemaLike<T>
  ): Promise<ModelCallResult<T>> {
    if (input.kind !== "language") {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: "callLanguage 只接受 kind=language 的调用",
        requestCount: 0,
        rateLimitKey: input.configId,
      };
    }
    return this.callInternal<T>(input, schema);
  }

  /**
   * 调用 multimodal 模型（可同时处理图片 + 文本，也可纯文本）
   *
   * 统一替代 callVision 和 callLanguage：
   * - 提供 imagePaths 时走 content 数组（与 vision 一致）
   * - 不提供 imagePaths 时走纯文本（与 language 一致）
   *
   * @param input 调用输入（kind 必须为 "multimodal"）
   * @param schema 输出 schema（zod）
   */
  async callMultimodal<T>(
    input: ModelCallInput,
    schema: ZodSchemaLike<T>
  ): Promise<ModelCallResult<T>> {
    if (input.kind !== "multimodal") {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: "callMultimodal 只接受 kind=multimodal 的调用",
        requestCount: 0,
        rateLimitKey: input.configId,
      };
    }
    return this.callInternal<T>(input, schema);
  }

  /**
   * 测试连接（不写 model_job，仅做一次最小调用）
   *
   * 安全约束：
   * - 失败时不显示完整 API Key
   * - 不写日志
   */
  async testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
    const endpoint = normalizeEndpoint(input.endpoint);
    const url = `${endpoint}/v1/chat/completions`;

    const body: Record<string, unknown> = {
      model: input.model,
      messages: [
        { role: "system", content: COMMON_SYSTEM_PROMPT },
        { role: "user", content: "请回复 OK" },
      ],
      temperature: 0,
      max_tokens: 16,
    };

    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(input.apiKey),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errInfo = await extractErrorBody(response);
        return {
          ok: false,
          ...mapHttpErrorToCode(response.status, errInfo),
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (!data.choices || data.choices.length === 0) {
        return {
          ok: false,
          errorCode: "unknown_error",
          errorMessage: "响应缺少 choices 字段",
        };
      }
      return { ok: true };
    } catch (err) {
      const mapped = mapFetchError(err);
      return mapped;
    }
  }

  // ----------------------------------------------------------------
  // 内部实现
  // ----------------------------------------------------------------

  /**
   * 内部统一调用流程
   */
  private async callInternal<T>(
    input: ModelCallInput,
    schema: ZodSchemaLike<T>
  ): Promise<ModelCallResult<T>> {
    const startedAt = Date.now();
    const rateLimitKey = input.configId;
    // 1. 读取用户配置，或构造固定的 Recall 默认代理配置。
    const recallDefault = isRecallDefaultConfigId(input.configId);
    const config = recallDefault
      ? createRecallDefaultModelConfig(input.configId)
      : this.settingsService.getModelConfigById(input.configId);
    if (!config) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `未找到模型配置: ${input.configId}`,
        requestCount: 0,
        rateLimitKey,
        latencyMs: Date.now() - startedAt,
      };
    }
    if (config.kind !== input.kind) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `模型配置 kind 不匹配: 期望 ${input.kind}，实际 ${config.kind}`,
        requestCount: 0,
        rateLimitKey,
        latencyMs: Date.now() - startedAt,
      };
    }
    if (!config.enabled) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `模型配置已禁用: ${input.configId}`,
        requestCount: 0,
        rateLimitKey,
        latencyMs: Date.now() - startedAt,
      };
    }

    // 2. 用户配置读取本机 Key；Recall 默认代理只带匿名安装标识，不带上游 Key。
    let requestHeaders: Record<string, string>;
    if (recallDefault) {
      const accepted = await this.defaultModelConsentService?.ensureAccepted();
      if (!accepted) {
        return {
          ok: false,
          errorCode: "auth_error",
          errorMessage: "未同意使用 Recall 默认模型服务，请在设置中选择模型服务。",
          requestCount: 0,
          rateLimitKey,
          latencyMs: Date.now() - startedAt,
        };
      }
      const installationId = this.installationIdentityService?.getId();
      if (!installationId) {
        return {
          ok: false,
          errorCode: "unknown_error",
          errorMessage: "Recall 默认模型服务初始化失败：无法读取安装标识。",
          requestCount: 0,
          rateLimitKey,
          latencyMs: Date.now() - startedAt,
        };
      }
      requestHeaders = buildRecallDefaultHeaders(
        installationId,
        input.jobType,
        this.clientVersion
      );
    } else {
      const apiKey = await this.secretService.getApiKey(input.configId);
      if (!apiKey) {
        return {
          ok: false,
          errorCode: "auth_error",
          errorMessage: `用户模型配置缺少 API Key（configId=${input.configId}）`,
          requestCount: 0,
          rateLimitKey,
          latencyMs: Date.now() - startedAt,
        };
      }
      requestHeaders = buildHeaders(apiKey);
    }

    // 3. 解析 options_json
    const extraOptions = safeParseOptionsJson(config.optionsJson);

    // 4. 创建 model_job 记录（status=pending）
    const jobInputJson = input.jobInputJson ?? "{}";
    const job = this.modelJobRepo.create({
      type: input.jobType,
      inputJson: jobInputJson,
    });
    this.modelJobRepo.markRunning(job.id);

    // 5. 构造请求
    const endpoint = normalizeEndpoint(config.endpoint);
    const url = `${endpoint}/v1/chat/completions`;
    const useAsyncDefaultMultimodal = recallDefault
      && input.configId === RECALL_DEFAULT_MULTIMODAL_CONFIG_ID
      && Boolean(input.background?.idempotencyKey);
    const asyncUrl = `${endpoint}/jobs`;
    const temperature = input.temperature ?? numericOption(extraOptions.temperature) ?? DEFAULT_TEMPERATURE;
    const maxTokens = input.maxTokens ?? numericOption(extraOptions.max_tokens) ?? DEFAULT_MAX_TOKENS;

    const promptTextChars = COMMON_SYSTEM_PROMPT.length + 2
      + input.systemPrompt.length
      + input.userPrompt.length;
    if (promptTextChars > MAX_MODEL_PROMPT_TEXT_CHARS) {
      const errorMessage =
        `模型输入文本 ${promptTextChars} 字符超过本地安全上限 ${MAX_MODEL_PROMPT_TEXT_CHARS}，已在提交前拦截`;
      this.modelJobRepo.markFailed(
        job.id,
        "input_too_large",
        errorMessage,
        0,
        null,
        undefined,
        undefined,
        { requestCount: 0, latencyMs: Date.now() - startedAt }
      );
      return {
        ok: false,
        errorCode: "input_too_large",
        errorMessage,
        jobId: job.id,
        modelJobId: job.id,
        attempts: 0,
        requestCount: 0,
        rateLimitKey,
        latencyMs: Date.now() - startedAt,
      };
    }

    const messages = buildMessages({
      kind: input.kind,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      imagePaths: input.imagePaths,
    });

    // 调试模式：记录完整 prompt 文本上下文（不含图片 base64），供 DebugPage 查看
    const rawInputJsonForDebug =
      logger.isDevDebugEnabled() && this.settingsService.isVerboseModelIO()
        ? buildRawInputJsonForDebug(messages)
        : undefined;

    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (input.responseFormat !== "text") requestBody.response_format = { type: "json_object" };
    if (input.streaming) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }
    // 合并 extra options（除 temperature/max_tokens 外的字段）
    for (const [k, v] of Object.entries(extraOptions)) {
      if (k !== "temperature" && k !== "max_tokens" && !Object.hasOwn(requestBody, k)) {
        requestBody[k] = v;
      }
    }
    applyModelCompatibilityOptions(requestBody, config.model, extraOptions);

    let attempts = 0;
    let lastErrorCode: ModelJobErrorCode | undefined;
    let lastErrorMessage: string | undefined;
    let rawOutput = "";
    let hasRawOutput = false;
    let usage: ModelUsage | undefined;
    let requestCount = 0;
    let retryAfterMs: number | null | undefined;

    // 6. 第一次调用
    attempts++;
    const firstResult = useAsyncDefaultMultimodal
      ? await this.sendAsyncRequestWithPolling(
          asyncUrl,
          requestHeaders,
          requestBody,
          input.background!.idempotencyKey,
          input.timeoutMs
        )
      : input.streaming
        ? await this.sendStreamingRequestWithFallback(url, requestHeaders, requestBody, input.timeoutMs)
        : await this.sendRequest(url, requestHeaders, requestBody, input.timeoutMs);
    requestCount += firstResult.requestCount;
    retryAfterMs = firstResult.retryAfterMs;
    if (firstResult.ok) {
      rawOutput = firstResult.content ?? "";
      hasRawOutput = true;
      usage = firstResult.usage;
      if (
        firstResult.finishReason === "length"
        || (usage?.completionTokens ?? 0) >= maxTokens
      ) {
        lastErrorCode = "output_truncated";
        lastErrorMessage = `模型输出达到 max_tokens=${maxTokens}，JSON 已被截断（completion_tokens=${usage?.completionTokens ?? 0}）`;
      } else {
        // 7. JSON parse
        const parseResult = tryParseJson(rawOutput);
        if (parseResult.ok) {
          // 8. zod schema 校验
          const schemaResult = schema.safeParse(parseResult.data);
          if (schemaResult.success) {
            const latencyMs = Date.now() - startedAt;
            this.modelJobRepo.markSucceeded(
              job.id,
              rawOutput,
              attempts,
              rawInputJsonForDebug,
              undefined,
              toModelJobMetrics(usage, requestCount, latencyMs)
            );
            return {
              ok: true,
              data: schemaResult.data,
              jobId: job.id,
              modelJobId: job.id,
              attempts,
              usage,
              requestCount,
              retryAfterMs,
              rateLimitKey,
              latencyMs,
            };
          }
          lastErrorCode = "schema_invalid";
          lastErrorMessage = `schema 校验失败: ${schemaResult.error.message}`;
        } else {
          lastErrorCode = "invalid_json";
          lastErrorMessage = `JSON parse 失败: ${parseResult.error}`;
        }
      }
    } else {
      // HTTP/网络/超时错误
      lastErrorCode = firstResult.errorCode;
      lastErrorMessage = firstResult.errorMessage;
    }

    // 9. 失败时尝试一次 JSON repair（仅当错误是 invalid_json 或 schema_invalid）
    if (!input.disableRepair && (lastErrorCode === "invalid_json" || lastErrorCode === "schema_invalid")) {
      if (hasRawOutput) {
        attempts++;
        const repairResult = await this.callRepair(
          url,
          config,
          requestHeaders,
          schema,
          rawOutput,
          lastErrorMessage ?? "",
          maxTokens,
          extraOptions,
          input.timeoutMs,
          input.streaming ?? false,
          useAsyncDefaultMultimodal
            ? {
                url: asyncUrl,
                idempotencyKey: await shortHashIdempotency(`${input.background!.idempotencyKey}:repair`),
              }
            : undefined,
          maxTokens * 2
        );
        requestCount += repairResult.requestCount;
        retryAfterMs = repairResult.retryAfterMs ?? retryAfterMs;
        usage = mergeUsage(usage, repairResult.usage);
        if (repairResult.ok) {
          rawOutput = repairResult.content ?? "";
          const parseResult2 = tryParseJson(rawOutput);
          if (parseResult2.ok) {
            const schemaResult2 = schema.safeParse(parseResult2.data);
            if (schemaResult2.success) {
              const latencyMs = Date.now() - startedAt;
              this.modelJobRepo.markSucceeded(
                job.id,
                rawOutput,
                attempts,
                rawInputJsonForDebug,
                undefined,
                toModelJobMetrics(usage, requestCount, latencyMs)
              );
              return {
                ok: true,
                data: schemaResult2.data,
                jobId: job.id,
                modelJobId: job.id,
                attempts,
                usage,
                requestCount,
                retryAfterMs,
                rateLimitKey,
                latencyMs,
              };
            }
            lastErrorCode = "schema_invalid";
            lastErrorMessage = `repair 后 schema 校验仍失败: ${schemaResult2.error.message}`;
          } else {
            lastErrorCode = "invalid_json";
            lastErrorMessage = `repair 后 JSON parse 仍失败: ${parseResult2.error}`;
          }
        } else {
          // repair 调用本身失败
          if (repairResult.errorCode !== undefined) {
            lastErrorCode = repairResult.errorCode;
            lastErrorMessage = `repair 调用失败: ${repairResult.errorMessage}`;
          }
        }
      }
    }

    // 10. 仍失败：记录 model_job.status=failed，不写入正式表
    const latencyMs = Date.now() - startedAt;
    this.modelJobRepo.markFailed(
      job.id,
      lastErrorCode ?? "unknown_error",
      lastErrorMessage ?? "未知错误",
      attempts,
      hasRawOutput ? rawOutput : null,
      rawInputJsonForDebug,
      undefined,
      toModelJobMetrics(usage, requestCount, latencyMs)
    );

    return {
      ok: false,
      errorCode: lastErrorCode ?? "unknown_error",
      errorMessage: !recallDefault && lastErrorMessage
        ? `用户模型配置调用失败：${lastErrorMessage}`
        : lastErrorMessage,
      jobId: job.id,
      modelJobId: job.id,
      attempts,
      usage,
      requestCount,
      retryAfterMs,
      rateLimitKey,
      latencyMs,
    };
  }

  /**
   * 调用 JSON repair（仅一次）
   * 使用相同的模型配置，发送 repair prompt
   */
  private async callRepair(
    url: string,
    config: ModelConfig,
    requestHeaders: Record<string, string>,
    _schema: ZodSchemaLike<unknown>,
    badOutput: string,
    errorMessage: string,
    maxTokens: number,
    extraOptions: Record<string, unknown>,
    timeoutMs?: number,
    streaming = false,
    asyncRequest?: { url: string; idempotencyKey: string },
    repairMaxTokens?: number
  ): Promise<ModelHttpResult> {
    // repair 请求给更大的输出预算（默认 2× 首调），截断型错误多在中部被 max_tokens 截断
    const effectiveRepairMaxTokens = repairMaxTokens ?? maxTokens * 2;
    const schemaDescription = buildSchemaDescription(_schema);
    const repairPrompt = JSON_REPAIR_PROMPT_TEMPLATE.replace(
      "{{schema_description}}",
      schemaDescription
    )
      .replace("{{bad_output}}", badOutput)
      .replace("{{error_message}}", errorMessage);

    const messages = [
      { role: "system", content: COMMON_SYSTEM_PROMPT },
      { role: "user", content: repairPrompt },
    ];

    const requestBody: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: effectiveRepairMaxTokens,
      response_format: { type: "json_object" },
    };

    if (streaming) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }
    applyModelCompatibilityOptions(requestBody, config.model, extraOptions);
    const result = asyncRequest
      ? await this.sendAsyncRequestWithPolling(
          asyncRequest.url,
          requestHeaders,
          requestBody,
          asyncRequest.idempotencyKey,
          timeoutMs
        )
      : streaming
        ? await this.sendStreamingRequestWithFallback(url, requestHeaders, requestBody, timeoutMs)
        : await this.sendRequest(url, requestHeaders, requestBody, timeoutMs);
    if (
      result.ok
      && (result.finishReason === "length" || (result.usage?.completionTokens ?? 0) >= effectiveRepairMaxTokens)
    ) {
      return {
        ...result,
        ok: false,
        errorCode: "output_truncated",
        errorMessage: `repair 输出达到 max_tokens=${effectiveRepairMaxTokens}，JSON 仍被截断`,
      };
    }
    return result;
  }

  private async sendAsyncRequestWithPolling(
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: Record<string, unknown>,
    idempotencyKey: string,
    requestedTimeoutMs?: number
  ): Promise<ModelHttpResult> {
    const deadline = Date.now() + Math.max(
      requestedTimeoutMs ?? 0,
      ASYNC_MODEL_MIN_TOTAL_TIMEOUT_MS
    );
    let submitted: Response;
    try {
      submitted = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          ...requestHeaders,
          "X-Recall-Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(requestBody),
      }, ASYNC_MODEL_POLL_REQUEST_TIMEOUT_MS);
    } catch (error) {
      return { ...mapFetchError(error), requestCount: 1 };
    }

    if (!submitted.ok) {
      const errInfo = await extractErrorBody(submitted);
      const mapped = mapHttpErrorToCode(submitted.status, errInfo);
      return {
        ok: false,
        ...mapped,
        requestCount: 1,
        retryAfterMs: parseRetryAfterMs(submitted.headers.get("retry-after")),
      };
    }

    let envelope: AsyncModelJobEnvelope;
    try {
      envelope = await submitted.json() as AsyncModelJobEnvelope;
    } catch (error) {
      return {
        ok: false,
        errorCode: "response_invalid",
        errorMessage: `异步提交响应不是有效 JSON: ${sanitizeErrorMessage(errorMessage(error))}`,
        requestCount: 1,
      };
    }
    if (!envelope.jobId) {
      return {
        ok: false,
        errorCode: "response_invalid",
        errorMessage: "异步提交响应缺少 jobId",
        requestCount: 1,
      };
    }

    const statusUrl = `${url}/${encodeURIComponent(envelope.jobId)}`;
    let pollMs = normalizeAsyncPollMs(envelope.retryAfterMs);
    while (Date.now() < deadline) {
      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      let response: Response;
      try {
        response = await this.fetchWithTimeout(statusUrl, {
          method: "GET",
          headers: requestHeaders,
        }, ASYNC_MODEL_POLL_REQUEST_TIMEOUT_MS);
      } catch {
        pollMs = Math.min(5_000, Math.max(ASYNC_MODEL_DEFAULT_POLL_MS, pollMs * 1.5));
        continue;
      }

      // 已持有远端 jobId，查询失败不会重复生成；短暂代理错误继续查同一个作业。
      if (response.status === 520 || response.status === 524 || response.status >= 500) {
        pollMs = Math.min(5_000, Math.max(ASYNC_MODEL_DEFAULT_POLL_MS, pollMs * 1.5));
        continue;
      }
      if (!response.ok) {
        const errInfo = await extractErrorBody(response);
        const mapped = mapHttpErrorToCode(response.status, errInfo);
        return { ok: false, ...mapped, requestCount: 1 };
      }

      let state: AsyncModelJobEnvelope;
      try {
        state = await response.json() as AsyncModelJobEnvelope;
      } catch {
        pollMs = Math.min(5_000, Math.max(ASYNC_MODEL_DEFAULT_POLL_MS, pollMs * 1.5));
        continue;
      }
      if (state.status === "succeeded" && state.response) {
        return completionResponseToHttpResult(state.response, 1);
      }
      if (state.status === "failed") {
        return {
          ok: false,
          errorCode: isModelJobErrorCode(state.errorCode) ? state.errorCode : "unknown_error",
          errorMessage: sanitizeErrorMessage(state.errorMessage ?? "默认多模态异步任务失败"),
          requestCount: 1,
        };
      }
      if (state.status !== "pending" && state.status !== "running") {
        return {
          ok: false,
          errorCode: "response_invalid",
          errorMessage: "默认多模态异步任务返回未知状态",
          requestCount: 1,
        };
      }
      pollMs = normalizeAsyncPollMs(state.retryAfterMs);
    }

    return {
      ok: false,
      errorCode: "upstream_timeout",
      errorMessage: "默认多模态任务仍在远端执行，已停止本地轮询；为避免重复生成未自动重提",
      requestCount: 1,
    };
  }

  private async sendStreamingRequestWithFallback(
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: Record<string, unknown>,
    firstResponseTimeoutMs?: number
  ): Promise<ModelHttpResult> {
    const withUsage = await this.sendStreamingRequest(url, requestHeaders, requestBody, firstResponseTimeoutMs);
    if (withUsage.ok || withUsage.receivedContent || !isStreamCompatibilityError(withUsage)) {
      return withUsage;
    }

    const withoutStreamOptions = { ...requestBody };
    delete withoutStreamOptions.stream_options;
    const basicStream = await this.sendStreamingRequest(url, requestHeaders, withoutStreamOptions, firstResponseTimeoutMs);
    if (basicStream.ok || basicStream.receivedContent || !isStreamCompatibilityError(basicStream)) {
      return addRequestCount(basicStream, withUsage.requestCount);
    }

    const nonStreamingBody = { ...withoutStreamOptions };
    delete nonStreamingBody.stream;
    const nonStreaming = await this.sendRequest(url, requestHeaders, nonStreamingBody, firstResponseTimeoutMs);
    return addRequestCount(nonStreaming, withUsage.requestCount + basicStream.requestCount);
  }

  private async sendStreamingRequest(
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: Record<string, unknown>,
    firstResponseTimeoutMs?: number
  ): Promise<ModelHttpResult> {
    const controller = new AbortController();
    const firstResponseTimer = setTimeout(
      () => controller.abort(new Error("stream_first_response_timeout")),
      firstResponseTimeoutMs ?? this.timeoutMs
    );
    const totalTimer = setTimeout(
      () => controller.abort(new Error("stream_total_timeout")),
      STREAM_TOTAL_TIMEOUT_MS
    );
    let receivedContent = false;
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(firstResponseTimer);

      if (!response.ok) {
        const errInfo = await extractErrorBody(response);
        const mapped = mapHttpErrorToCode(response.status, errInfo);
        return {
          ...mapped,
          ok: false,
          receivedContent: false,
          requestCount: 1,
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        };
      }
      if (!response.body) {
        return {
          ok: false,
          errorCode: "response_invalid",
          errorMessage: "流式响应缺少 body",
          receivedContent: false,
          requestCount: 1,
        };
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let finishReason: string | undefined;
      let usage: ModelUsage | undefined;
      let streamEnded = false;
      let sawDoneMarker = false;

      while (!streamEnded) {
        const read = await readStreamChunk(reader, controller, STREAM_IDLE_TIMEOUT_MS);
        if (read.done) {
          buffer += decoder.decode();
          streamEnded = true;
        } else {
          buffer += decoder.decode(read.value, { stream: true });
        }

        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        if (streamEnded && buffer.trim()) {
          events.push(buffer);
          buffer = "";
        }
        for (const event of events) {
          for (const line of event.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === "[DONE]") {
              sawDoneMarker = true;
              streamEnded = true;
              break;
            }
            let chunk: ChatCompletionStreamChunk;
            try {
              chunk = JSON.parse(payload) as ChatCompletionStreamChunk;
            } catch (error) {
              return {
                ok: false,
                errorCode: "response_invalid",
                errorMessage: `SSE 数据不是有效 JSON: ${sanitizeErrorMessage(errorMessage(error))}`,
                receivedContent,
                content,
                requestCount: 1,
              };
            }
            if (chunk.error) {
              return {
                ok: false,
                errorCode: "response_invalid",
                errorMessage: sanitizeErrorMessage(chunk.error.message),
                receivedContent,
                content,
                requestCount: 1,
              };
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta?.content;
            if (delta) {
              content += delta;
              receivedContent = true;
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? usage?.promptTokens,
                completionTokens: chunk.usage.completion_tokens ?? usage?.completionTokens,
                cachedPromptTokens:
                  chunk.usage.prompt_tokens_details?.cached_tokens
                  ?? usage?.cachedPromptTokens,
              };
            }
          }
        }
      }

      if (!sawDoneMarker && !finishReason) {
        return {
          ok: false,
          errorCode: "network_error",
          errorMessage: `流式响应提前结束（已接收 ${content.length} 字符）`,
          receivedContent,
          content,
          usage,
          requestCount: 1,
        };
      }
      return { ok: true, content, finishReason, usage, receivedContent, requestCount: 1 };
    } catch (error) {
      const reason = controller.signal.reason;
      const reasonMessage = reason instanceof Error ? reason.message : "";
      if (reasonMessage === "stream_first_response_timeout") {
        return { ok: false, errorCode: "timeout", errorMessage: "等待流式首响应超时", receivedContent, requestCount: 1 };
      }
      if (reasonMessage === "stream_total_timeout") {
        return { ok: false, errorCode: "timeout", errorMessage: "流式生成超过 10 分钟总时限", receivedContent, requestCount: 1 };
      }
      if (reasonMessage === "stream_idle_timeout") {
        return { ok: false, errorCode: "timeout", errorMessage: "流式响应连续 60 秒无新数据", receivedContent, requestCount: 1 };
      }
      return { ...mapFetchError(error), receivedContent, requestCount: 1 };
    } finally {
      clearTimeout(firstResponseTimer);
      clearTimeout(totalTimer);
    }
  }

  /**
   * 发送 chat completion 请求（处理 HTTP/网络/超时错误）
   */
  private async sendRequest(
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: Record<string, unknown>,
    timeoutMsOverride?: number
  ): Promise<ModelHttpResult> {
    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(requestBody),
      }, timeoutMsOverride);

      if (!response.ok) {
        const errInfo = await extractErrorBody(response);
        const mapped = mapHttpErrorToCode(response.status, errInfo);
        return {
          ok: false,
          errorCode: mapped.errorCode,
          errorMessage: mapped.errorMessage,
          requestCount: 1,
          retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
        };
      }

      let data: ChatCompletionResponse;
      try {
        data = (await response.json()) as ChatCompletionResponse;
      } catch (error) {
        return {
          ok: false,
          errorCode: "response_invalid",
          errorMessage: `HTTP 200 响应不是有效 JSON: ${sanitizeErrorMessage(errorMessage(error))}`,
          requestCount: 1,
        };
      }
      return completionResponseToHttpResult(data, 1);
    } catch (err) {
      return { ...mapFetchError(err), requestCount: 1 };
    }
  }

  /**
   * 带超时的 fetch（AbortController + setTimeout）
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    overrideMs?: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), overrideMs ?? this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function mergeUsage(current: ModelUsage | undefined, next: ModelUsage | undefined): ModelUsage | undefined {
  if (!current) return next;
  if (!next) return current;
  return {
    promptTokens: sumOptional(current.promptTokens, next.promptTokens),
    completionTokens: sumOptional(current.completionTokens, next.completionTokens),
    cachedPromptTokens: sumOptional(current.cachedPromptTokens, next.cachedPromptTokens),
  };
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function toModelJobMetrics(
  usage: ModelUsage | undefined,
  requestCount: number,
  latencyMs: number
): ModelJobMetrics {
  return {
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    cachedPromptTokens: usage?.cachedPromptTokens ?? null,
    requestCount,
    latencyMs,
  };
}

function addRequestCount(result: ModelHttpResult, previousRequestCount: number): ModelHttpResult {
  return { ...result, requestCount: previousRequestCount + result.requestCount };
}

function completionResponseToHttpResult(
  data: ChatCompletionResponse,
  requestCount: number
): ModelHttpResult {
  if (data.error) {
    return {
      ok: false,
      errorCode: "response_invalid",
      errorMessage: sanitizeErrorMessage(data.error.message),
      requestCount,
    };
  }
  if (!data.choices || data.choices.length === 0) {
    return {
      ok: false,
      errorCode: "response_invalid",
      errorMessage: "响应缺少 choices 字段",
      requestCount,
    };
  }
  const choice = data.choices[0];
  const usage = data.usage ? {
    promptTokens: data.usage.prompt_tokens,
    completionTokens: data.usage.completion_tokens,
    cachedPromptTokens: data.usage.prompt_tokens_details?.cached_tokens,
  } : undefined;
  return {
    ok: true,
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason,
    usage,
    requestCount,
  };
}

function normalizeAsyncPollMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return ASYNC_MODEL_DEFAULT_POLL_MS;
  return Math.min(5_000, Math.max(500, Math.round(value!)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MODEL_JOB_ERROR_CODES = new Set<ModelJobErrorCode>([
  "timeout",
  "network_error",
  "upstream_timeout",
  "auth_error",
  "rate_limited",
  "invalid_json",
  "schema_invalid",
  "input_too_large",
  "output_truncated",
  "response_invalid",
  "safety_blocked",
  "unknown_error",
]);

function isModelJobErrorCode(value: unknown): value is ModelJobErrorCode {
  return typeof value === "string" && MODEL_JOB_ERROR_CODES.has(value as ModelJobErrorCode);
}

/**
 * 规范化 endpoint：
 * 1. 去除末尾斜杠
 * 2. 去除末尾 /v1（用户可能误填，后台统一补全）
 * 拼接时统一加 /v1/chat/completions
 */
function normalizeEndpoint(endpoint: string): string {
  let normalized = endpoint.trim();
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.endsWith("/v1")) {
    normalized = normalized.slice(0, -3);
  }
  return normalized;
}

/**
 * 构造请求头
 */
function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildRecallDefaultHeaders(
  installationId: string,
  taskType: string,
  clientVersion: string
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Recall-Installation-Id": installationId,
    "X-Recall-Task-Type": taskType,
    "X-Recall-Client-Version": clientVersion,
  };
}

/**
 * 解析 options_json（失败返回空对象）
 */
function safeParseOptionsJson(optionsJson: string | null | undefined): Record<string, unknown> {
  if (!optionsJson) return {};
  try {
    const parsed = JSON.parse(optionsJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function applyModelCompatibilityOptions(
  requestBody: Record<string, unknown>,
  model: string,
  extraOptions: Record<string, unknown>
): void {
  if (Object.prototype.hasOwnProperty.call(extraOptions, "reasoning_effort")) {
    requestBody.reasoning_effort = extraOptions.reasoning_effort;
    return;
  }
  const modelName = model.trim().toLowerCase().split("/").at(-1);
  if (modelName === "sensenova-6.7-flash-lite") {
    requestBody.reasoning_effort = "none";
  }
}

/**
 * 构造 OpenAI messages
 * - vision：user content 为数组 [{type:text}, {type:image_url}, ...]
 * - language：user content 为字符串
 *
 * 系统提示自动拼接 COMMON_SYSTEM_PROMPT（prompt injection 防护）
 */
function buildMessages(params: {
  kind: ModelKind;
  systemPrompt: string;
  userPrompt: string;
  imagePaths?: string[];
}): Array<Record<string, unknown>> {
  const systemContent = `${COMMON_SYSTEM_PROMPT}\n\n${params.systemPrompt}`;

  // vision 或 multimodal（有图片时）：构造 content 数组
  const hasImages = params.imagePaths && params.imagePaths.length > 0;
  if ((params.kind === "vision" || params.kind === "multimodal") && hasImages) {
    const userContent: Array<Record<string, unknown>> = [
      { type: "text", text: params.userPrompt },
    ];
    for (const imgPath of params.imagePaths!) {
      const dataUrl = imagePathToDataUrl(imgPath);
      if (dataUrl) {
        userContent.push({
          type: "image_url",
          image_url: { url: dataUrl },
        });
      }
    }
    return [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ];
  }

  // language 或 multimodal（无图片时）：纯文本
  return [
    { role: "system", content: systemContent },
    { role: "user", content: params.userPrompt },
  ];
}

/**
 * 构造调试用的 raw_input_json（完整 prompt 文本上下文，不含图片 base64）
 *
 * 仅在 devDebug + verboseModelIO 双开时调用。
 * - 图片 base64 替换为 `[image: NNN chars]` 占位（避免日志爆炸）
 * - 超 64KB 截断为 `[TRUNCATED:NNN chars]` 前缀 + 前 64KB
 * - 失败时返回 undefined（不阻断主流程）
 */
function buildRawInputJsonForDebug(
  messages: Array<Record<string, unknown>>
): string | undefined {
  try {
    const summary = messages.map((m) => {
      const content = m.content;
      if (typeof content === "string") {
        return { role: m.role, content };
      }
      if (Array.isArray(content)) {
        return {
          role: m.role,
          content: (content as Array<Record<string, unknown>>).map((part) => {
            if (part.type === "image_url" && part.image_url) {
              const url =
                ((part.image_url as { url?: string }).url) ?? "";
              return {
                type: "image_url",
                image_url: { url: `[image: ${url.length} chars]` },
              };
            }
            return part;
          }),
        };
      }
      return { role: m.role, content: "[unknown content type]" };
    });
    let json = JSON.stringify(summary);
    const MAX = 64 * 1024;
    if (json.length > MAX) {
      json = `[TRUNCATED:${json.length} chars]` + json.slice(0, MAX);
    }
    return json;
  } catch {
    return undefined;
  }
}

/**
 * 将图片文件读取为 base64 data URL
 * 支持 png/jpeg/jpg/gif/webp
 * 失败时返回 null（不阻断调用，但记录 warning 由调用方处理）
 */
function imagePathToDataUrl(imagePath: string): string | null {
  try {
    if (!fs.existsSync(imagePath)) {
      return null;
    }
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().replace(".", "");
    const mime = mapExtToMime(ext);
    if (!mime) return null;
    const base64 = buffer.toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch {
    return null;
  }
}

/**
 * 扩展名映射为 MIME 类型
 */
function mapExtToMime(ext: string): string | null {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

/**
 * 尝试 JSON parse
 *
 * 处理顺序：stripReasoningTags → stripMarkdownCodeFence → JSON.parse
 * - reasoning 模型（如 deepseek-v4-flash）常输出 <think>...</think> 包裹的推理过程
 * - 若不先剥离，JSON.parse 会在 <think 起始处立即抛错，导致 invalid_json 失败
 */
function tryParseJson(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    // 先剥离 reasoning 模型的 <think>/<reasoning> 标签
    const withoutReasoning = stripReasoningTags(text);
    // 再去除可能的 markdown 代码块包裹
    const cleaned = stripMarkdownCodeFence(withoutReasoning);
    return { ok: true, data: JSON.parse(cleaned) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 剥离 reasoning 模型的推理标签
 *
 * reasoning 模型（deepseek-v4-flash 等）常在正式 JSON 之前输出：
 *   <think>让我分析这个 observation...</think>
 *   {"facts": [...]}
 *
 * 部分模型还会使用 <reasoning>...</reasoning> 或 <reflection>...</reflection> 包裹。
 * 此函数去除这些包裹块，只保留正式输出内容。
 *
 * 处理策略：
 * 1. 先去除成对标签 <think>...</think>（含未闭合的 <think> 到结尾）
 * 2. 找到第一个 { 或 [ 字符（JSON 起始），截取到结尾再交给 JSON.parse
 *    这样即使标签未闭合或混入其他文本，也能稳定提取 JSON
 */
function stripReasoningTags(text: string): string {
  let s = text;

  // 1. 去除成对的 <think>...</think> / <reasoning>...</reasoning> / <reflection>...</reflection>
  const tagPairs = [
    /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi,
    /<reasoning\b[^>]*>[\s\S]*?<\/reasoning\s*>/gi,
    /<reflection\b[^>]*>[\s\S]*?<\/reflection\s*>/gi,
  ];
  for (const re of tagPairs) {
    s = s.replace(re, "");
  }

  // 2. 去除未闭合的 <think>...</think>（只有开头 <think> 没有结尾）
  //    部分模型输出 <think>xxx 直到结尾都没闭合
  const unclosedTags = [/<think\b[^>]*>[\s\S]*$/gi, /<reasoning\b[^>]*>[\s\S]*$/gi, /<reflection\b[^>]*>[\s\S]*$/gi];
  for (const re of unclosedTags) {
    s = s.replace(re, "");
  }

  // 3. 若剩余文本仍含 <think 起始但无闭合，截掉前面部分
  //    找第一个 JSON 起始字符 { 或 [，取从该位置到结尾
  const trimmed = s.trim();
  if (!trimmed) return trimmed;

  // 4. 定位第一个 { 或 [（JSON 对象/数组起始），截掉其前的任何文字
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  let startIdx = -1;
  if (firstObj >= 0 && firstArr >= 0) {
    startIdx = Math.min(firstObj, firstArr);
  } else if (firstObj >= 0) {
    startIdx = firstObj;
  } else if (firstArr >= 0) {
    startIdx = firstArr;
  }
  if (startIdx > 0) {
    return trimmed.slice(startIdx);
  }
  return trimmed;
}

/**
 * 去除 markdown 代码块包裹（```json ... ```）
 * 模型偶尔会忽略 response_format，输出 markdown 包裹的 JSON
 */
function stripMarkdownCodeFence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    // 去掉首行 ```json 或 ```
    const firstNewline = trimmed.indexOf("\n");
    if (firstNewline > 0) {
      const rest = trimmed.slice(firstNewline + 1);
      // 去掉结尾 ```
      if (rest.endsWith("```")) {
        return rest.slice(0, -3).trim();
      }
      return rest.trim();
    }
  }
  return trimmed;
}

/**
 * 映射 HTTP 状态码到 ModelJobErrorCode
 */
function mapHttpErrorToCode(
  status: number,
  errInfo: { code?: string | number; message?: string; type?: string }
): { errorCode: ModelJobErrorCode; errorMessage: string } {
  const safeMsg = sanitizeErrorMessage(errInfo.message ?? `HTTP ${status}`);
  if (status === 401 || status === 403) {
    return { errorCode: "auth_error", errorMessage: `鉴权失败 (HTTP ${status})` };
  }
  if (status === 429) {
    return { errorCode: "rate_limited", errorMessage: "请求被限流 (HTTP 429)" };
  }
  if (status === 520 || status === 524) {
    return {
      errorCode: "upstream_timeout",
      errorMessage: `上游代理超时 (HTTP ${status})，为避免重复生成未自动重试`,
    };
  }
  if (status >= 500) {
    return { errorCode: "network_error", errorMessage: `服务端错误 (HTTP ${status}): ${safeMsg}` };
  }
  if (status >= 400) {
    return { errorCode: "unknown_error", errorMessage: `请求错误 (HTTP ${status}): ${safeMsg}` };
  }
  return { errorCode: "unknown_error", errorMessage: `未知 HTTP 状态: ${status}` };
}

/**
 * 映射 fetch 抛出的错误到 ModelJobErrorCode
 * - AbortError（超时）→ timeout
 * - TypeError（网络错误）→ network_error
 * - 其他 → unknown_error
 */
function mapFetchError(err: unknown): { ok: false; errorCode: ModelJobErrorCode; errorMessage: string } {
  if (err instanceof Error) {
    const name = err.name;
    if (name === "AbortError") {
      return {
        ok: false,
        errorCode: "timeout",
        errorMessage: `请求超时`,
      };
    }
    if (name === "TypeError") {
      // fetch 抛 TypeError 通常是网络错误（DNS 解析失败、连接被拒绝等）
      return {
        ok: false,
        errorCode: "network_error",
        errorMessage: `网络错误: ${sanitizeErrorMessage(err.message)}`,
      };
    }
    return {
      ok: false,
      errorCode: "unknown_error",
      errorMessage: sanitizeErrorMessage(err.message),
    };
  }
  return {
    ok: false,
    errorCode: "unknown_error",
    errorMessage: "未知错误",
  };
}

/**
 * 从错误响应中提取错误信息
 */
async function extractErrorBody(response: Response): Promise<{
  code?: string | number;
  message?: string;
  type?: string;
}> {
  try {
    const body = (await response.json()) as ChatCompletionErrorBody;
    return {
      code: body.error?.code,
      message: body.error?.message,
      type: body.error?.type,
    };
  } catch {
    // 非 JSON 错误响应
    return {};
  }
}

/**
 * 清理错误信息：去除潜在的 API Key 泄露
 * 任何形如 sk-xxx 的字符串都会被脱敏
 */
function isStreamCompatibilityError(result: ModelHttpResult): boolean {
  return result.errorCode === "unknown_error" && (result.errorMessage?.includes("HTTP 400") ?? false);
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  idleTimeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("stream_idle_timeout");
          controller.abort(error);
          reject(error);
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function numericOption(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeErrorMessage(message: string | undefined | null): string {
  if (!message) return "";
  // 脱敏可能的 OpenAI API Key（sk- 开头 + 20+ 字符）
  const sanitized = message.replace(/sk-[A-Za-z0-9-_]{16,}/g, "sk-***REDACTED***");
  // 限制长度
  if (sanitized.length > 500) {
    return sanitized.slice(0, 500) + "...(truncated)";
  }
  return sanitized;
}

/**
 * 构造 schema 描述（用于 JSON repair prompt）
 * 调用 zodToDescription 解析 schema 字段名/类型/约束，
 * 让模型在 JSON repair 时拿到具体字段定义，提升修复成功率。
 * 解析异常时降级到通用描述，保证 repair 流程不中断。
 */
function buildSchemaDescription(schema: ZodSchemaLike<unknown>): string {
  let fieldDescriptions: string;
  try {
    fieldDescriptions = zodToDescription(schema);
  } catch {
    // zodToDescription 解析失败时，回退到通用描述
    return `输出必须是合法 JSON 对象，符合目标 zod schema。
- 字符串字段不超过指定长度（title: 120, summary: 1000, fact content/evidence: 500, reason: 500, report overview: 2000）
- 数值字段 confidence/importance/priority 必须在 [0, 1] 范围内
- 枚举字段必须使用预定义值之一
- 不要添加 schema 之外的字段`;
  }
  return `输出必须是合法 JSON 对象，符合目标 zod schema 的字段定义：
${fieldDescriptions}

通用约束：
- 字符串字段不超过指定长度
- 数值字段 confidence/importance/priority 必须在 [0, 1] 范围内
- 枚举字段必须使用预定义值之一
- 不要添加 schema 之外的字段`;
}

/**
 * 幂等键哈希：保持确定性、长度恒定（32 hex），避免拼接 ":repair" 后超过 Worker 上限。
 */
async function shortHashIdempotency(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest.slice(0, 16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
