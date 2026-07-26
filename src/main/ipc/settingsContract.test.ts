import { describe, expect, it } from "vitest";
import { ipcContracts } from "../../shared/ipcContracts";
import { DEFAULT_SETTINGS } from "../models/types";
import { normalizeAppSettings } from "../services/SettingsService";

/**
 * settings:get 迁移到 handleValidated 之后，响应体也要过 schema。
 *
 * 这意味着往 AppSettings 加字段但忘了同步契约，不会在编译期报错——
 * 只会在用户点开设置页时炸成一个 schema_invalid。这里把两边钉在一起：
 * 契约必须能吞下 SettingsService 真正会返回的东西。
 */
describe("settings:get response contract", () => {
  const responseSchema = ipcContracts["settings:get"].response;

  it("accepts DEFAULT_SETTINGS as-is", () => {
    const parsed = responseSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  });

  it("accepts what normalizeAppSettings produces from an empty file", () => {
    // 旧版本 settings.json 缺字段时走的就是这条路径。
    const parsed = responseSchema.safeParse(normalizeAppSettings({}));
    expect(parsed.success, parsed.success ? "" : parsed.error.message).toBe(true);
  });

  it("keeps every AppSettings top-level key covered by the contract", () => {
    const contractKeys = Object.keys(responseSchema.shape).sort();
    const settingsKeys = Object.keys(normalizeAppSettings({})).sort();
    expect(contractKeys).toEqual(settingsKeys);
  });
});
