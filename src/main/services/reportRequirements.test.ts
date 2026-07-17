import { describe, expect, it } from "vitest";
import { createEmptyReportRequirements } from "../../shared/reportRequirements";
import type { SettingsService } from "./SettingsService";
import {
  hasReportGenerationRequirements,
  resolveReportGenerationRequirements,
} from "./reportRequirements";

describe("report generation requirements", () => {
  it("combines the selected long-term requirement with a trimmed temporary requirement", () => {
    const reportRequirements = createEmptyReportRequirements();
    reportRequirements.weekly = {
      focus: "重点统计客户沟通",
      presentation: "先写结论",
      reminders: "不要把探索写成完成",
    };
    const settingsService = {
      getAll: () => ({ reportRequirements }),
    } as unknown as SettingsService;

    const snapshot = resolveReportGenerationRequirements(
      settingsService,
      "weekly",
      "  本次突出交付风险  "
    );

    expect(snapshot).toEqual({
      reportType: "weekly",
      longTerm: reportRequirements.weekly,
      temporary: "本次突出交付风险",
    });
    expect(hasReportGenerationRequirements(snapshot)).toBe(true);
  });

  it("returns an empty snapshot when settings are unavailable", () => {
    const snapshot = resolveReportGenerationRequirements(null, "personal");

    expect(snapshot).toEqual({
      reportType: "personal",
      longTerm: { focus: "", presentation: "", reminders: "" },
      temporary: "",
    });
    expect(hasReportGenerationRequirements(snapshot)).toBe(false);
  });
});
