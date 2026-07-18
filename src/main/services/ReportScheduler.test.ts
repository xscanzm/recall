import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "../models/types";
import type { ReporterWorker } from "./ReporterWorker";
import type { PersonalReviewWriterWorker } from "./PersonalReviewWriterWorker";
import type { ReportRepository } from "../db/repositories/ReportRepository";
import type { SettingsService } from "./SettingsService";
import { ReportScheduler } from "./ReportScheduler";

const TODAY = "2026-07-17";

describe("ReportScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs daily reports and personal reviews even when legacy autoGenerate is false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 19, 0, 30));
    const settings = createSettings({
      dailyReport: { autoGenerate: false, time: "23:59" },
      personalReview: { autoGenerate: false, time: "18:45" },
      notification: { dailyReportTime: "18:30", weeklyReportTime: "23:59" },
    });
    const dailyDates: string[] = [];
    const personalDates: string[] = [];
    const scheduler = createScheduler({
      settings,
      reporterWorker: {
        generateDailyReport: vi.fn(async (dateKey: string) => {
          dailyDates.push(dateKey);
          return successResult("daily-report");
        }),
        generateWeeklyReport: vi.fn(async () => successResult("weekly-report")),
      },
      personalReviewWriterWorker: {
        writePersonalReview: vi.fn(async (dateKey: string) => {
          personalDates.push(dateKey);
          return successResult("personal-review");
        }),
      },
    });

    await callPrivate(scheduler, "checkSchedule");

    expect(dailyDates).toEqual([TODAY]);
    expect(personalDates).toEqual([TODAY]);
  });

  it("triggers weekly reports on Friday only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 20, 0, 30));
    const settings = createSettings({
      dailyReport: { autoGenerate: false, time: "23:59" },
      personalReview: { autoGenerate: false, time: "23:59" },
      notification: { dailyReportTime: "23:59", weeklyReportTime: "20:00" },
    });
    const weeklyDates: string[] = [];
    const scheduler = createScheduler({
      settings,
      reporterWorker: {
        generateDailyReport: vi.fn(async () => successResult("daily-report")),
        generateWeeklyReport: vi.fn(async (weekStart: string) => {
          weeklyDates.push(weekStart);
          return successResult("weekly-report");
        }),
      },
    });

    await callPrivate(scheduler, "checkSchedule");
    expect(weeklyDates).toEqual(["2026-07-13"]);

    vi.setSystemTime(new Date(2026, 6, 19, 20, 0, 30));
    const sundayWeekly = vi.fn(async () => successResult("weekly-report"));
    const sundayScheduler = createScheduler({
      settings: createSettings({
        dailyReport: { autoGenerate: false, time: "23:59" },
        personalReview: { autoGenerate: false, time: "23:59" },
        notification: { dailyReportTime: "23:59", weeklyReportTime: "20:00" },
      }),
      reporterWorker: {
        generateDailyReport: vi.fn(async () => successResult("daily-report")),
        generateWeeklyReport: sundayWeekly,
      },
    });
    await callPrivate(sundayScheduler, "checkSchedule");
    expect(sundayWeekly).not.toHaveBeenCalled();
  });

  it("generates a monthly report without changing weekly schedule state", async () => {
    const monthlyGenerate = vi.fn(async (monthKey: string, requirement?: string) => {
      expect(monthKey).toBe("2026-07");
      expect(requirement).toBe("突出本月成果");
      return successResult("monthly-report");
    });
    const settings = createSettings({
      schedule: { lastWeeklyReportWeekStart: "2026-07-13" },
    });
    const scheduler = createScheduler({
      settings,
      reporterWorker: {
        generateDailyReport: vi.fn(async () => successResult("daily-report")),
        generateWeeklyReport: vi.fn(async () => successResult("weekly-report")),
        generateMonthlyReport: monthlyGenerate,
      },
    });

    const result = await scheduler.generateMonthlyReportNow("2026-07", "突出本月成果");

    expect(result).toMatchObject({ ok: true, reportId: "monthly-report" });
    expect(settings.schedule.lastWeeklyReportWeekStart).toBe("2026-07-13");
  });

  it("treats the scheduled daily report type as already completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 19, 0, 30));
    const settings = createSettings({
      dailyReport: { autoGenerate: false, time: "23:59" },
      personalReview: { autoGenerate: false, time: "23:59" },
      notification: { dailyReportTime: "18:30", weeklyReportTime: "23:59" },
    });
    const dailyGenerate = vi.fn(async () => successResult("daily-report"));
    const scheduler = createScheduler({
      settings,
      reporterWorker: {
        generateDailyReport: dailyGenerate,
        generateWeeklyReport: vi.fn(async () => successResult("weekly-report")),
      },
      reportRepo: {
        getByTypeAndDate: vi.fn((type: string) =>
          type === "daily" ? ({ id: "existing-daily" } as never) : null
        ),
        listByType: vi.fn(() => []),
      },
    });

    await callPrivate(scheduler, "checkSchedule");

    expect(dailyGenerate).not.toHaveBeenCalled();
  });

  it("tries a failed historical daily report again on the next backfill", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 19, 0, 30));
    const settings = createSettings({
      schedule: {
        lastDailyReportDate: "2026-07-16",
        lastWeeklyReportWeekStart: null,
        lastPersonalReviewDate: TODAY,
      },
      dailyReport: { autoGenerate: false, time: "23:59" },
      personalReview: { autoGenerate: false, time: "23:59" },
      notification: { dailyReportTime: "18:30", weeklyReportTime: "23:59" },
    });
    let attempts = 0;
    const dailyGenerate = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? { ok: false, errorCode: "temporary", errorMessage: "temporary failure" }
        : successResult("daily-report");
    });
    const scheduler = createScheduler({
      settings,
      reporterWorker: {
        generateDailyReport: dailyGenerate,
        generateWeeklyReport: vi.fn(async () => successResult("weekly-report")),
      },
      reportRepo: {
        getByTypeAndDate: vi.fn(() => null),
        listByType: vi.fn(() => []),
      },
    });

    await callPrivate(scheduler, "checkMissedSchedules");
    await callPrivate(scheduler, "checkMissedSchedules");

    expect(dailyGenerate).toHaveBeenCalledTimes(2);
    expect(settings.schedule.lastDailyReportDate).toBe(TODAY);
  });
});

type SettingsOverrides = Omit<
  Partial<AppSettings>,
  "notification" | "dailyReport" | "personalReview" | "schedule"
> & {
  notification?: Partial<AppSettings["notification"]>;
  dailyReport?: Partial<AppSettings["dailyReport"]>;
  personalReview?: Partial<AppSettings["personalReview"]>;
  schedule?: Partial<AppSettings["schedule"]>;
};

function createSettings(overrides: SettingsOverrides): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...overrides,
    notification: {
      ...DEFAULT_SETTINGS.notification,
      ...(overrides.notification ?? {}),
    },
    dailyReport: {
      ...DEFAULT_SETTINGS.dailyReport,
      ...(overrides.dailyReport ?? {}),
    },
    personalReview: {
      ...DEFAULT_SETTINGS.personalReview,
      ...(overrides.personalReview ?? {}),
    },
    schedule: {
      ...DEFAULT_SETTINGS.schedule,
      ...(overrides.schedule ?? {}),
    },
  };
}

function createScheduler(deps: {
  settings: AppSettings;
  reporterWorker: Partial<ReporterWorker>;
  personalReviewWriterWorker?: Partial<PersonalReviewWriterWorker>;
  reportRepo?: Partial<ReportRepository>;
}): ReportScheduler {
  const settingsService = {
    getAll: () => deps.settings,
    setSchedule: (patch: Partial<AppSettings["schedule"]>) => {
      deps.settings.schedule = { ...deps.settings.schedule, ...patch };
      return deps.settings;
    },
  } as unknown as SettingsService;
  return new ReportScheduler({
    reporterWorker: deps.reporterWorker as ReporterWorker,
    personalReviewWriterWorker:
      deps.personalReviewWriterWorker as PersonalReviewWriterWorker | undefined,
    reportRepo: deps.reportRepo as ReportRepository | undefined,
    settingsService,
  });
}

function successResult(reportId: string) {
  return { ok: true as const, reportRecord: { id: reportId } as never };
}

async function callPrivate(
  scheduler: ReportScheduler,
  method: "checkSchedule" | "checkMissedSchedules"
): Promise<void> {
  const target = scheduler as unknown as Record<string, () => Promise<void>>;
  await target[method]();
}
