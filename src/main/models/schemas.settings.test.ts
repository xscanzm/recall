import { describe, expect, it } from "vitest";
import { ipcContracts } from "../../shared/ipcContracts";
import { createEmptyReportRequirements } from "../../shared/reportRequirements";

// settings:update 迁移到 handleValidated 后，真正把关的是契约里的 request schema，
// 原来的 SettingsUpdateSchema 已不再挂在任何调用路径上。这些断言改打契约，
// 免得覆盖率留在一段死代码上。
const SettingsUpdateSchema = ipcContracts["settings:update"].request;

describe("settings:update request contract", () => {
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

  it("accepts complete per-type report requirements", () => {
    const reportRequirements = createEmptyReportRequirements();
    reportRequirements.weekly = {
      focus: "重点统计客户沟通和交付结果",
      presentation: "先写结论，控制在 500 字以内",
      reminders: "不要把探索中的事项写成已完成",
    };

    expect(SettingsUpdateSchema.parse({ reportRequirements })).toEqual({
      reportRequirements,
    });
  });

  it("rejects incomplete or oversized report requirements", () => {
    expect(() => SettingsUpdateSchema.parse({
      reportRequirements: { personal: { focus: "只关注决策" } },
    })).toThrow();

    const reportRequirements = createEmptyReportRequirements();
    reportRequirements.monthly.focus = "x".repeat(2001);
    expect(() => SettingsUpdateSchema.parse({ reportRequirements })).toThrow();
  });
});
