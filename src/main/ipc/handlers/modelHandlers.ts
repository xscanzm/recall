import { ipcMain } from "electron";
import type { IpcDeps } from "../handlers";
import type { ModelConfig } from "../../../shared/types";
import { handleValidated, ipcFail } from "../validated";

export function registerModelHandlers(deps: IpcDeps): void {
  handleValidated(ipcMain, "model:testConnection", async (_event, input) => {
    const { kind, endpoint, model, apiKey } = input;
    // 调用 ModelGateway.testConnection 真实测试 OpenAI-compatible endpoint
    // 安全约束：apiKey 不进日志、不进 renderer、不进 SQLite
    // 失败时不显示完整 API Key（由 ModelGateway 内部 sanitize）
    const result = await deps.modelGateway.testConnection({
      kind,
      endpoint,
      model,
      apiKey,
    });
    if (result.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      code: result.errorCode ?? "unknown_error",
      message: result.errorMessage ?? "未知错误",
    };
  });

  handleValidated(ipcMain, "model:defaultConsent:resolve", (_event, input) => {
    if (!deps.defaultModelConsentService) ipcFail("not_ready", "默认模型授权服务未初始化");
    deps.defaultModelConsentService.resolve(input.accepted);
    deps.onDefaultModelConsentResolved?.();
    return { ok: true };
  });

  /**
   * model:listConfigs
   * 列出全部模型配置（不返回 API Key）
   * renderer 通过 kind 过滤 vision / language
   */
  handleValidated(ipcMain, "model:listConfigs", (_event, input) => {
    const opts: { kind?: "vision" | "language" | "multimodal"; enabled?: boolean } = {};
    if (input && typeof input === "object") {
      if (input.kind === "vision" || input.kind === "language" || input.kind === "multimodal") opts.kind = input.kind;
      if (typeof input.enabled === "boolean") opts.enabled = input.enabled;
    }
    return deps.settingsService.listModelConfigs(opts);
  });

  /**
   * model:saveConfig
   * 创建或更新模型配置，并把 API Key 写入 SecretService
   * - 输入 id：更新现有配置
   * - 不输入 id：创建新配置
   * - 输入 apiKey：写入 SecretService（覆盖原有 key）
   * - 不输入 apiKey：保留原有 key（用于只改 endpoint/model）
   *
   * 安全约束：
   * - apiKey 不进 SQLite / 不进日志 / 不返回 renderer
   * - 删除模型配置时同时删除 SecretService 中的 key（由 SettingsService.deleteModelConfig 处理）
   */
  handleValidated(ipcMain, "model:saveConfig", async (_event, input) => {
    if (!deps.secretService) {
      ipcFail("not_ready", "SecretService 未初始化");
    }
    const { id, kind, providerName, endpoint, model, apiKey, enabled, temperature, maxTokens } = input;

    // Phase 7：把 temperature/maxTokens 写入 options_json
    // - 留空（undefined）时从 options_json 中删除对应键，使用模型默认值
    // - 更新模式下与现有 optionsJson 合并，保留其他自定义键
    // - ModelGateway 从 options_json 读取 temperature / max_tokens（snake_case）
    const buildOptionsJson = (existing: string | null | undefined): string => {
      let existingOptions: Record<string, unknown> = {};
      if (existing) {
        try {
          const parsedExisting = JSON.parse(existing);
          if (parsedExisting && typeof parsedExisting === "object" && !Array.isArray(parsedExisting)) {
            existingOptions = parsedExisting as Record<string, unknown>;
          }
        } catch {
          // 旧 optionsJson 损坏时忽略，从空对象开始
        }
      }
      const next: Record<string, unknown> = { ...existingOptions };
      if (temperature !== undefined) {
        next.temperature = temperature;
      } else {
        delete next.temperature;
      }
      if (maxTokens !== undefined) {
        next.max_tokens = maxTokens;
      } else {
        delete next.max_tokens;
      }
      return JSON.stringify(next);
    };

    let saved: ModelConfig;
    if (id) {
      // 更新现有配置
      const existing = deps.settingsService.getModelConfigById(id);
      if (!existing) {
        ipcFail("not_found", `未找到模型配置 ${id}`);
      }
      const optionsJson = buildOptionsJson(existing.optionsJson);
      const updated = deps.settingsService.updateModelConfig(id, {
        providerName,
        endpoint,
        model,
        enabled,
        optionsJson,
      });
      if (!updated) {
        ipcFail("not_found", `更新模型配置失败 ${id}`);
      }
      saved = updated;
    } else {
      // 创建新配置
      const optionsJson = buildOptionsJson(undefined);
      saved = deps.settingsService.createModelConfig({
        kind,
        providerName,
        endpoint,
        model,
        enabled: enabled ?? true,
        optionsJson,
      });
    }

    // 写入 API Key 到 SecretService（即使没传 apiKey 也保留原有 key）
    if (apiKey) {
      try {
        await deps.secretService!.setApiKey(saved.id, apiKey);
      } catch {
        // SecretService 写入失败不阻断配置保存
        // 但要在返回中提示用户 key 未保存
        return {
          ok: true,
          config: saved,
          warning: "API Key 未能写入系统安全存储，请稍后重试或检查系统权限。",
        };
      }
    }

    // 返回配置（不含 API Key）
    return { ok: true, config: saved };
  });

  /**
   * model:deleteConfig
   * 删除模型配置，同时删除 SecretService 中的 API Key
   */
  handleValidated(ipcMain, "model:deleteConfig", async (_event, input) => {
    const deleted = await deps.settingsService.deleteModelConfig(input.id);
    return { ok: deleted };
  });
}
