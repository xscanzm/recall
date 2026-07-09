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
import type { ModelJobRepository } from "../db/repositories/ModelJobRepository";
import type { ModelJobErrorCode } from "../db/repositories/ModelJobRepository";
import {
  COMMON_SYSTEM_PROMPT,
  JSON_REPAIR_PROMPT_TEMPLATE,
} from "../models/prompts";
import { zodToDescription } from "./zodToDescription";
import { logger } from "./Logger";

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

/**
 * 默认温度
 */
export const DEFAULT_TEMPERATURE = 0.3;

/**
 * 默认 max tokens
 */
export const DEFAULT_MAX_TOKENS = 4096;

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
   * reasoning effort（仅部分模型支持，如 sensenova-6.7-flash-lite）
   * - "none"：禁用推理模式，避免 content 为空（阶段一验证此参数为必须）
   * - 其他值由调用方按需传入
   */
  reasoningEffort?: "none" | "low" | "medium" | "high";
  /**
   * 单次调用超时覆盖（毫秒）。未指定时使用实例默认超时（120s）。
   * 批次模式（默认 6 帧多图）需要 180s，普通模式保持 120s。
   */
  timeoutMs?: number;
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
  /** 尝试次数 */
  attempts?: number;
  /** usage 信息 */
  usage?: { promptTokens: number; completionTokens: number };
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
  };
  error?: {
    code?: string | number;
    message?: string;
    type?: string;
  };
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

  constructor(deps: ModelGatewayDeps) {
    this.settingsService = deps.settingsService;
    this.secretService = deps.secretService;
    this.modelJobRepo = deps.modelJobRepo;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
      };
    }
    if (!input.imagePaths || input.imagePaths.length === 0) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: "vision 调用必须提供至少一张图片",
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
    const url = `${endpoint}/chat/completions`;

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
    // 1. 读取 model_config
    const config = this.settingsService.getModelConfigById(input.configId);
    if (!config) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `未找到模型配置: ${input.configId}`,
      };
    }
    if (config.kind !== input.kind) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `模型配置 kind 不匹配: 期望 ${input.kind}，实际 ${config.kind}`,
      };
    }
    if (!config.enabled) {
      return {
        ok: false,
        errorCode: "unknown_error",
        errorMessage: `模型配置已禁用: ${input.configId}`,
      };
    }

    // 2. 从 SecretService 获取 API Key
    const apiKey = await this.secretService.getApiKey(input.configId);
    if (!apiKey) {
      return {
        ok: false,
        errorCode: "auth_error",
        errorMessage: `未找到 API Key（configId=${input.configId}）`,
      };
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
    const url = `${endpoint}/chat/completions`;
    const temperature = input.temperature ?? extraOptions.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = input.maxTokens ?? extraOptions.max_tokens ?? DEFAULT_MAX_TOKENS;

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
      response_format: { type: "json_object" },
    };
    // 透传 reasoning_effort（阶段一验证：sensenova-6.7-flash-lite 必须设为 "none" 否则 content 为空）
    if (input.reasoningEffort) {
      requestBody.reasoning_effort = input.reasoningEffort;
    }
    // 合并 extra options（除 temperature/max_tokens 外的字段）
    for (const [k, v] of Object.entries(extraOptions)) {
      if (k !== "temperature" && k !== "max_tokens" && !requestBody.hasOwnProperty(k)) {
        requestBody[k] = v;
      }
    }

    let attempts = 0;
    let lastErrorCode: ModelJobErrorCode | undefined;
    let lastErrorMessage: string | undefined;
    let rawOutput = "";
    let hasRawOutput = false;
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    // 6. 第一次调用
    attempts++;
    const firstResult = await this.sendRequest(url, apiKey, requestBody, input.timeoutMs);
    if (firstResult.ok) {
      rawOutput = firstResult.content ?? "";
      hasRawOutput = true;
      usage = firstResult.usage;
      // 7. JSON parse
      const parseResult = tryParseJson(rawOutput);
      if (parseResult.ok) {
        // 8. zod schema 校验
        const schemaResult = schema.safeParse(parseResult.data);
        if (schemaResult.success) {
          // 校验通过 + safety 检查
          const safetyCheck = checkSafety(parseResult.data);
          if (safetyCheck.blocked) {
            // 敏感内容视为 safety_blocked，不写入正式表
            this.modelJobRepo.markFailed(
              job.id,
              "safety_blocked",
              safetyCheck.reason ?? "high sensitive content",
              attempts,
              rawOutput,
              rawInputJsonForDebug
            );
            return {
              ok: false,
              errorCode: "safety_blocked",
              errorMessage: safetyCheck.reason,
              jobId: job.id,
              attempts,
              usage,
            };
          }
          // 成功
          this.modelJobRepo.markSucceeded(job.id, rawOutput, attempts, rawInputJsonForDebug);
          return {
            ok: true,
            data: schemaResult.data,
            jobId: job.id,
            attempts,
            usage,
          };
        }
        // schema 校验失败
        lastErrorCode = "schema_invalid";
        lastErrorMessage = `schema 校验失败: ${schemaResult.error.message}`;
      } else {
        lastErrorCode = "invalid_json";
        lastErrorMessage = `JSON parse 失败: ${parseResult.error}`;
      }
    } else {
      // HTTP/网络/超时错误
      lastErrorCode = firstResult.errorCode;
      lastErrorMessage = firstResult.errorMessage;
    }

    // 9. 失败时尝试一次 JSON repair（仅当错误是 invalid_json 或 schema_invalid）
    if (lastErrorCode === "invalid_json" || lastErrorCode === "schema_invalid") {
      if (hasRawOutput) {
        attempts++;
        const repairResult = await this.callRepair(
          url,
          config,
          apiKey,
          extraOptions,
          schema,
          rawOutput,
          lastErrorMessage ?? ""
        );
        if (repairResult.ok) {
          rawOutput = repairResult.content ?? "";
          usage = repairResult.usage ?? usage;
          const parseResult2 = tryParseJson(rawOutput);
          if (parseResult2.ok) {
            const schemaResult2 = schema.safeParse(parseResult2.data);
            if (schemaResult2.success) {
              const safetyCheck = checkSafety(parseResult2.data);
              if (safetyCheck.blocked) {
                this.modelJobRepo.markFailed(
                  job.id,
                  "safety_blocked",
                  safetyCheck.reason ?? "high sensitive content",
                  attempts,
                  rawOutput
                );
                return {
                  ok: false,
                  errorCode: "safety_blocked",
                  errorMessage: safetyCheck.reason,
                  jobId: job.id,
                  attempts,
                  usage,
                };
              }
              this.modelJobRepo.markSucceeded(job.id, rawOutput, attempts, rawInputJsonForDebug);
              return {
                ok: true,
                data: schemaResult2.data,
                jobId: job.id,
                attempts,
                usage,
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
    this.modelJobRepo.markFailed(
      job.id,
      lastErrorCode ?? "unknown_error",
      lastErrorMessage ?? "未知错误",
      attempts,
      hasRawOutput ? rawOutput : null,
      rawInputJsonForDebug
    );

    return {
      ok: false,
      errorCode: lastErrorCode ?? "unknown_error",
      errorMessage: lastErrorMessage,
      jobId: job.id,
      attempts,
      usage,
    };
  }

  /**
   * 调用 JSON repair（仅一次）
   * 使用相同的模型配置，发送 repair prompt
   */
  private async callRepair(
    url: string,
    config: ModelConfig,
    apiKey: string,
    extraOptions: Record<string, unknown>,
    _schema: ZodSchemaLike<unknown>,
    badOutput: string,
    errorMessage: string
  ): Promise<{
    ok: boolean;
    content?: string;
    usage?: { promptTokens: number; completionTokens: number };
    errorCode?: ModelJobErrorCode;
    errorMessage?: string;
  }> {
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
      max_tokens: extraOptions.max_tokens ?? DEFAULT_MAX_TOKENS,
      response_format: { type: "json_object" },
    };

    const result = await this.sendRequest(url, apiKey, requestBody);
    if (result.ok) {
      return {
        ok: true,
        content: result.content,
        usage: result.usage,
      };
    }
    return {
      ok: false,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    };
  }

  /**
   * 发送 chat completion 请求（处理 HTTP/网络/超时错误）
   */
  private async sendRequest(
    url: string,
    apiKey: string,
    requestBody: Record<string, unknown>,
    timeoutMsOverride?: number
  ): Promise<{
    ok: boolean;
    content?: string;
    usage?: { promptTokens: number; completionTokens: number };
    errorCode?: ModelJobErrorCode;
    errorMessage?: string;
  }> {
    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: buildHeaders(apiKey),
        body: JSON.stringify(requestBody),
      }, timeoutMsOverride);

      if (!response.ok) {
        const errInfo = await extractErrorBody(response);
        const mapped = mapHttpErrorToCode(response.status, errInfo);
        return {
          ok: false,
          errorCode: mapped.errorCode,
          errorMessage: mapped.errorMessage,
        };
      }

      const data = (await response.json()) as ChatCompletionResponse;
      if (data.error) {
        return {
          ok: false,
          errorCode: "unknown_error",
          errorMessage: sanitizeErrorMessage(data.error.message),
        };
      }
      if (!data.choices || data.choices.length === 0) {
        return {
          ok: false,
          errorCode: "unknown_error",
          errorMessage: "响应缺少 choices 字段",
        };
      }
      const content = data.choices[0]?.message?.content ?? "";
      const usage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
      };
      return { ok: true, content, usage };
    } catch (err) {
      const mapped = mapFetchError(err);
      return mapped;
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
      const response = await fetch(url, {
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

/**
 * 规范化 endpoint：去除末尾斜杠
 * 若 endpoint 以 /v1 结尾，去除 /v1 后再统一加 /chat/completions
 * （OpenAI-compatible endpoint 通常以 /v1 结尾，但也可能直接是 base url）
 */
function normalizeEndpoint(endpoint: string): string {
  let normalized = endpoint.trim();
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
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
 * 检查输出是否包含敏感内容（high_sensitive）
 * 视觉模型返回 high_sensitive 时视为 safety_blocked
 */
function checkSafety(data: unknown): { blocked: boolean; reason?: string } {
  if (data && typeof data === "object") {
    const obj = data as { sensitivity?: string; sensitivityReason?: string };
    if (obj.sensitivity === "high_sensitive") {
      return {
        blocked: true,
        reason: obj.sensitivityReason ?? "vision output marked as high_sensitive",
      };
    }
  }
  return { blocked: false };
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
