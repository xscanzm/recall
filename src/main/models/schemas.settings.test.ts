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

  it("accepts end-of-day review defaults", () => {
    expect(SettingsUpdateSchema.parse({
      endOfDayReview: { enabled: true, firstTime: "17:30", secondTime: "18:00" },
    })).toEqual({
      endOfDayReview: { enabled: true, firstTime: "17:30", secondTime: "18:00" },
    });
  });

  it("rejects an invalid end-of-day schedule", () => {
    expect(() => SettingsUpdateSchema.parse({
      endOfDayReview: { enabled: true, firstTime: "18:00", secondTime: "17:30" },
    })).toThrow();
    expect(() => SettingsUpdateSchema.parse({
      endOfDayReview: { enabled: true, firstTime: "9:00", secondTime: "18:00" },
    })).toThrow();
  });

  it("rejects incomplete sections and unknown settings", () => {
    expect(() => SettingsUpdateSchema.parse({ observation: { enabled: true } })).toThrow();
    expect(() => SettingsUpdateSchema.parse({ launchAtLogin: true })).toThrow();
  });
});
