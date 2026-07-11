import { describe, expect, it } from "vitest";
import { SettingsUpdateSchema } from "./schemas";

describe("SettingsUpdateSchema", () => {
  it("accepts a complete observation section", () => {
    const observation = {
      enabled: true,
      activeWindowStableSeconds: 30,
      contentChangeMinIntervalSeconds: 60,
      longSessionIntervalMinutes: 5,
      idleThresholdSeconds: 120,
    };
    expect(SettingsUpdateSchema.parse({ observation })).toEqual({ observation });
  });

  it("rejects incomplete sections and unknown settings", () => {
    expect(() => SettingsUpdateSchema.parse({ observation: { enabled: true } })).toThrow();
    expect(() => SettingsUpdateSchema.parse({ launchAtLogin: true })).toThrow();
  });
});
