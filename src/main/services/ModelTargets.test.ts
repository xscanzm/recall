import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../../shared/types";
import {
  RECALL_DEFAULT_LANGUAGE_CONFIG_ID,
  RECALL_DEFAULT_MULTIMODAL_CONFIG_ID,
  resolveModelConfigId,
} from "./ModelTargets";

function config(id: string, kind: ModelConfig["kind"], enabled = true): ModelConfig {
  return {
    id,
    kind,
    enabled,
    endpoint: "https://example.test",
    model: "model",
    providerName: "test",
    optionsJson: "{}",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("default model routing", () => {
  it("routes text through language, multimodal, then Recall language", async () => {
    const configs = [config("language", "language"), config("multi", "multimodal")];
    const getApiKey = vi.fn(async (id: string) => id === "language" ? "key" : null);
    await expect(resolveModelConfigId({ taskKind: "text", configs, getApiKey, defaultConsent: "accepted" })).resolves.toBe("language");

    getApiKey.mockImplementation(async (id: string) => id === "multi" ? "key" : null);
    await expect(resolveModelConfigId({ taskKind: "text", configs, getApiKey, defaultConsent: "accepted" })).resolves.toBe("multi");

    getApiKey.mockResolvedValue(null);
    await expect(resolveModelConfigId({ taskKind: "text", configs, getApiKey, defaultConsent: "pending" })).resolves.toBe(RECALL_DEFAULT_LANGUAGE_CONFIG_ID);
  });

  it("routes images through vision, multimodal, then Recall multimodal", async () => {
    const configs = [config("vision", "vision"), config("multi", "multimodal")];
    const getApiKey = vi.fn(async (id: string) => id === "vision" ? "key" : null);
    await expect(resolveModelConfigId({ taskKind: "vision", configs, getApiKey, defaultConsent: "accepted" })).resolves.toBe("vision");

    getApiKey.mockImplementation(async (id: string) => id === "multi" ? "key" : null);
    await expect(resolveModelConfigId({ taskKind: "vision", configs, getApiKey, defaultConsent: "accepted" })).resolves.toBe("multi");

    getApiKey.mockResolvedValue(null);
    await expect(resolveModelConfigId({ taskKind: "vision", configs, getApiKey, defaultConsent: "accepted" })).resolves.toBe(RECALL_DEFAULT_MULTIMODAL_CONFIG_ID);
  });

  it("falls through missing Keys but does not use defaults after decline", async () => {
    const getApiKey = vi.fn(async () => null);
    await expect(resolveModelConfigId({
      taskKind: "text",
      configs: [config("missing-key", "language"), config("disabled", "multimodal", false)],
      getApiKey,
      defaultConsent: "declined",
    })).resolves.toBeNull();
  });
});
