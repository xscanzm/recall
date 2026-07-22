import type { ModelConfig } from "../../shared/types";

export type ModelTaskKind = "text" | "vision";

export const RECALL_DEFAULT_LANGUAGE_CONFIG_ID = "recall-default-language";
export const RECALL_DEFAULT_MULTIMODAL_CONFIG_ID = "recall-default-multimodal";
export const RECALL_DEFAULT_MODEL_PROXY_ORIGIN = "https://recall-update.ppclaw.online";

export function isRecallDefaultConfigId(configId: string): boolean {
  return configId === RECALL_DEFAULT_LANGUAGE_CONFIG_ID
    || configId === RECALL_DEFAULT_MULTIMODAL_CONFIG_ID;
}

export function createRecallDefaultModelConfig(configId: string): ModelConfig | null {
  const now = new Date(0).toISOString();
  if (configId === RECALL_DEFAULT_LANGUAGE_CONFIG_ID) {
    return {
      id: configId,
      kind: "language",
      providerName: "Recall 默认模型服务",
      endpoint: `${RECALL_DEFAULT_MODEL_PROXY_ORIGIN}/api/model/language`,
      model: "deepseek-v4-flash",
      optionsJson: "{}",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (configId === RECALL_DEFAULT_MULTIMODAL_CONFIG_ID) {
    return {
      id: configId,
      kind: "multimodal",
      providerName: "Recall 默认模型服务",
      endpoint: `${RECALL_DEFAULT_MODEL_PROXY_ORIGIN}/api/model/multimodal`,
      model: "sensenova-6.7-flash-lite",
      optionsJson: "{}",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }
  return null;
}

export async function resolveModelConfigId(input: {
  taskKind: ModelTaskKind;
  configs: ModelConfig[];
  getApiKey: (configId: string) => Promise<string | null>;
  defaultConsent: "pending" | "accepted" | "declined";
}): Promise<string | null> {
  const preferredKinds = input.taskKind === "text"
    ? ["language", "multimodal"]
    : ["vision", "multimodal"];
  for (const kind of preferredKinds) {
    for (const config of input.configs) {
      if (
        config.kind !== kind
        || !config.enabled
        || !config.endpoint.trim()
        || !config.model.trim()
      ) continue;
      if (await input.getApiKey(config.id)) return config.id;
    }
  }
  if (input.defaultConsent === "declined") return null;
  return input.taskKind === "text"
    ? RECALL_DEFAULT_LANGUAGE_CONFIG_ID
    : RECALL_DEFAULT_MULTIMODAL_CONFIG_ID;
}
