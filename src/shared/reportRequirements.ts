export const REPORT_REQUIREMENT_TYPES = [
  "personal",
  "work",
  "weekly",
  "monthly",
] as const;

export const REPORT_REQUIREMENT_MAX_LENGTH = 2000;
export const TEMPORARY_REPORT_REQUIREMENT_MAX_LENGTH = 2000;

export type ReportRequirementType = (typeof REPORT_REQUIREMENT_TYPES)[number];

export interface ReportRequirement {
  focus: string;
  presentation: string;
  reminders: string;
}

export type ReportRequirements = Record<ReportRequirementType, ReportRequirement>;

export interface ReportGenerationRequirementsSnapshot {
  reportType: ReportRequirementType;
  longTerm: ReportRequirement;
  temporary: string;
}

export function createEmptyReportRequirement(): ReportRequirement {
  return { focus: "", presentation: "", reminders: "" };
}

export function createEmptyReportRequirements(): ReportRequirements {
  return {
    personal: createEmptyReportRequirement(),
    work: createEmptyReportRequirement(),
    weekly: createEmptyReportRequirement(),
    monthly: createEmptyReportRequirement(),
  };
}

export function normalizeReportRequirements(value: unknown): ReportRequirements {
  const source = isRecord(value) ? value : {};
  const result = createEmptyReportRequirements();

  for (const type of REPORT_REQUIREMENT_TYPES) {
    const requirement = isRecord(source[type]) ? source[type] : {};
    result[type] = {
      focus: asText(requirement.focus),
      presentation: asText(requirement.presentation),
      reminders: asText(requirement.reminders),
    };
  }

  return result;
}

function asText(value: unknown): string {
  return typeof value === "string"
    ? value.slice(0, REPORT_REQUIREMENT_MAX_LENGTH)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
