import { describe, expect, it } from "vitest";
import { normalizeAppSettings } from "./SettingsService";

describe("settings default model migration", () => {
  it("normalizes old settings without consent to pending", () => {
    const settings = normalizeAppSettings({ onboardingCompleted: true });
    expect(settings.defaultModelService).toEqual({ consent: "pending", acceptedAt: null });
  });
});
