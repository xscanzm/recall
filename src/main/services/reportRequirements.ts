import type { SettingsService } from "./SettingsService";
import {
  createEmptyReportRequirement,
  TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH,
  type ReportGenerationRequirementsSnapshot,
  type ReportRequirementType,
} from "../../shared/reportRequirements";

export function resolveReportGenerationRequirements(
  settingsService: SettingsService | null,
  reportType: ReportRequirementType,
  temporaryRequirement?: string
): ReportGenerationRequirementsSnapshot {
  let longTerm = createEmptyReportRequirement();

  if (settingsService) {
    try {
      longTerm = {
        ...settingsService.getAll().reportRequirements[reportType],
      };
    } catch {
      longTerm = createEmptyReportRequirement();
    }
  }

  return {
    reportType,
    longTerm,
    temporary: (temporaryRequirement ?? "")
      .trim()
      .slice(0, TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH),
  };
}

export function hasReportGenerationRequirements(
  snapshot: ReportGenerationRequirementsSnapshot
): boolean {
  return Boolean(
    snapshot.longTerm.focus.trim() ||
      snapshot.longTerm.presentation.trim() ||
      snapshot.longTerm.reminders.trim() ||
      snapshot.temporary
  );
}
