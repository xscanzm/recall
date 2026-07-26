import { z } from "zod";

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const stringArray = z.array(z.string());

export const AppStatusSchema = z.object({
  observing: z.boolean(),
  paused: z.boolean(),
  currentWindow: z.object({
    appName: z.string(),
    windowTitle: z.string(),
    privacyState: z.enum(["allowed", "blocked", "sensitive", "unknown"]),
  }).optional(),
  pipelineState: z.enum(["idle", "capturing", "observing", "extracting", "linking", "judging", "reporting", "error"]),
  lastError: z.string().optional(),
});

export const MemoryTypeSchema = z.enum(["fact", "scene", "task", "project", "decision", "report", "person", "record"]);
export const MemoryRefSchema = z.object({ id: z.string(), type: MemoryTypeSchema });
export const MemoryDetailTypeSchema = z.union([MemoryTypeSchema, z.literal("timeline")]);
export const MemoryDetailRefSchema = z.object({ id: z.string(), type: MemoryDetailTypeSchema });

export const MemorySearchItemSchema = z.object({
  id: z.string(),
  type: MemoryTypeSchema,
  title: z.string(),
  summary: z.string().optional(),
  createdAt: z.string(),
  projectName: z.string().optional(),
  projectId: z.string().nullable().optional(),
  sourceType: z.enum(["observation", "fact", "scene", "project", "report"]).optional(),
  sourceId: z.string().nullable().optional(),
  relevance: z.number().optional(),
  matchReasons: z.array(z.string()).default([]),
  sourceCount: z.number().int().nonnegative().default(0),
});

export const MemorySearchFiltersSchema = z.object({
  timePreset: z.enum(["all", "today", "week", "month"]).optional(),
  timeFrom: z.string().optional(),
  timeTo: z.string().optional(),
  projectId: z.string().optional(),
  type: MemoryTypeSchema.optional(),
  personId: z.string().optional(),
}).default({});

const MemoryVisibleContentSchema = z.object({
  type: z.enum(["webpage", "document", "chat", "code", "spreadsheet", "design", "email", "terminal", "unknown"]),
  summary: z.string(),
  fullText: z.string(),
  keyTextSnippets: z.array(z.string()),
});

const MemorySourceSchema = z.object({
  id: z.string(),
  capturedAt: z.string(),
  appName: z.string(),
  windowTitle: z.string(),
  url: z.string().nullable(),
  summary: z.string(),
  visibleContent: z.array(MemoryVisibleContentSchema),
  screenshotState: z.enum(["available", "expired", "none"]),
  screenshotCount: z.number().int().nonnegative(),
});

export const MemoryDetailSchema = z.object({
  id: z.string(),
  type: MemoryDetailTypeSchema,
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })),
  contentSections: z.array(z.object({ title: z.string(), text: z.string(), items: z.array(z.string()) })),
  sources: z.array(MemorySourceSchema),
  relations: z.array(MemoryRefSchema.extend({ title: z.string(), summary: z.string().optional() })),
  correctionType: z.enum(["fact", "task", "scene", "project", "person", "decision"]).nullable(),
});

const fileCleanup = z.object({
  status: z.enum(["complete", "partial", "failed"]),
  attempted: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
const lifecycleSuccess = z.object({
  ok: z.literal(true),
  deletedObservations: z.number().int().nonnegative().optional(),
  deletedScreenshots: z.number().int().nonnegative(),
  fileCleanup: fileCleanup.optional(),
});
const operationFailure = z.object({ ok: z.literal(false), code: z.string(), message: z.string() });
const ipcFailure = z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() });
const ipcResult = <T extends z.ZodTypeAny>(data: T) => z.union([
  z.object({ ok: z.literal(true), data }),
  ipcFailure,
]);

/** IPC shape for the derived Today timeline projection. */
export const TodayTimelineProjectionSchema = z.object({
  id: z.string(), dateKey, startAt: z.string(), endAt: z.string(), title: z.string(), summary: z.string(),
  category: z.enum(["focus_work", "communication", "research", "writing", "coding", "design", "meeting", "admin", "break", "mixed", "unknown"]),
  projectIds: stringArray, projectNames: stringArray, highlights: stringArray, generatedTasks: stringArray,
  generatedDecisions: stringArray, reportable: z.boolean(), privateRisk: z.enum(["low", "medium", "high"]),
  privateRiskReason: z.string().optional(), sourceSceneIds: stringArray, sourceFactIds: stringArray,
  sourceObservationIds: stringArray, confidence: z.number().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
});

/** @deprecated Use TodayTimelineProjectionSchema for new contracts. */
export const TimelineBlockSchema = TodayTimelineProjectionSchema;

export const WorkReportSchema = z.object({
  id: z.string(), dateKey, title: z.string(),
  reportType: z.enum(["work_daily_report", "daily"]).optional(),
  plainText: z.string(),
  sections: z.object({ completed: stringArray, projectProgress: stringArray, risks: stringArray, tomorrowPlan: stringArray }),
  sourceTimelineBlockIds: stringArray, sourceSceneIds: stringArray.optional(), sourceFactIds: stringArray, omittedForPrivacy: z.number(), warnings: stringArray,
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
});

const dataExport = z.object({
  meta: z.object({
    schemaVersion: z.string(), appVersion: z.string(), exportedAt: z.string(), includeScreenshots: z.boolean(),
    screenshotSemantics: z.enum(["references", "excluded"]), counts: z.record(z.string(), z.number()),
  }),
  observations: z.array(z.unknown()), facts: z.array(z.unknown()), scenes: z.array(z.unknown()), tasks: z.array(z.unknown()),
  decisions: z.array(z.unknown()), people: z.array(z.unknown()), projects: z.array(z.unknown()), reports: z.array(z.unknown()),
  proactiveItems: z.array(z.unknown()), timelineBlocks: z.array(z.unknown()), unfinishedThreads: z.array(z.unknown()),
  reportSelections: z.array(z.unknown()), objectMerges: z.array(z.unknown()), memoryEdges: z.array(z.unknown()),
});

/** 与 main/models/types.ts AppSettings 对齐。settings:get 直接返回整个结构。 */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间必须为 HH:mm");
const reportRequirement = z.object({
  focus: z.string().max(2000),
  presentation: z.string().max(2000),
  reminders: z.string().max(2000),
});
const appSettings = z.object({
  observation: z.object({
    enabled: z.boolean(),
    activeWindowStableSeconds: z.number().nonnegative(),
    contentChangeMinIntervalSeconds: z.number().nonnegative(),
    longSessionIntervalMinutes: z.number().nonnegative(),
    idleThresholdSeconds: z.number().nonnegative(),
  }),
  screenshot: z.object({
    retentionPolicy: z.enum(["delete_immediately", "1h", "6h", "today", "3d", "7d"]),
  }),
  notification: z.object({
    inAppReminders: z.boolean(),
    desktopNotifications: z.boolean(),
    dailyReportTime: z.string(),
    weeklyReportTime: z.string(),
  }),
  endOfDayReview: z.object({ enabled: z.boolean(), firstTime: timeOfDay, secondTime: timeOfDay }),
  dailyReport: z.object({ autoGenerate: z.boolean(), time: z.string() }),
  personalReview: z.object({ autoGenerate: z.boolean(), time: z.string() }),
  reportRequirements: z.object({
    personal: reportRequirement,
    work: reportRequirement,
    weekly: reportRequirement,
    monthly: reportRequirement,
  }),
  defaultModelService: z.object({
    consent: z.enum(["pending", "accepted", "declined"]),
    acceptedAt: z.string().nullable(),
  }),
  schedule: z.object({
    lastDailyReportDate: z.string().nullable(),
    lastWeeklyReportWeekStart: z.string().nullable(),
    lastPersonalReviewDate: z.string().nullable(),
  }),
  onboardingCompleted: z.boolean(),
  debug: z.object({ enabled: z.boolean(), verboseModelIO: z.boolean() }),
  update: z.object({
    lastCheckedAt: z.string().nullable(),
    latestVersion: z.string().nullable(),
    dismissedVersion: z.string().nullable(),
    downloadedInstallerPath: z.string().nullable(),
  }),
});

/**
 * settings:update 的请求体。分区整体替换（SettingsService 是浅合并语义），
 * strict() 保证 renderer 传了拼错的 key 会被当场拒掉而不是静默丢弃。
 */
const appSettingsPatch = z.object({
  observation: appSettings.shape.observation.optional(),
  screenshot: appSettings.shape.screenshot.optional(),
  notification: appSettings.shape.notification.optional(),
  endOfDayReview: appSettings.shape.endOfDayReview
    .refine((value) => value.secondTime > value.firstTime, {
      message: "第二次通知时间必须晚于第一次",
      path: ["secondTime"],
    })
    .optional(),
  dailyReport: appSettings.shape.dailyReport.optional(),
  personalReview: appSettings.shape.personalReview.optional(),
  reportRequirements: appSettings.shape.reportRequirements.optional(),
  defaultModelService: appSettings.shape.defaultModelService.optional(),
  schedule: appSettings.shape.schedule.optional(),
  onboardingCompleted: z.boolean().optional(),
  debug: appSettings.shape.debug.optional(),
}).strict();

/** 与 shared/types.ts PrivacyRule 对齐。 */
const privacyRule = z.object({
  id: z.string(),
  type: z.enum(["app_name", "window_title_keyword", "domain_keyword"]),
  pattern: z.string(),
  action: z.enum(["exclude", "ask_before_capture", "blur_sensitive"]),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 与 main/models/types.ts ProactiveItem 对齐。 */
const proactiveItem = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  reason: z.string(),
  priority: z.number(),
  surface: z.string(),
  requiresUserConfirmation: z.boolean(),
  status: z.string(),
  sourceFactIds: stringArray,
  sourceSceneIds: stringArray,
  createdAt: z.string(),
  updatedAt: z.string(),
  payloadJson: z.string().nullable().optional(),
});

export const ipcContracts = {
  "app:getStatus": { request: z.undefined(), response: AppStatusSchema },
  "app:startObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:pauseObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:getLaunchAtLogin": { request: z.undefined(), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
  "app:setLaunchAtLogin": { request: z.object({ enabled: z.boolean() }), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
  "window:minimize": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "window:toggleMaximize": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "window:close": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "settings:get": { request: z.undefined(), response: appSettings },
  "settings:update": { request: appSettingsPatch, response: z.object({ ok: z.literal(true), settings: appSettings }) },
  "privacy:listRules": { request: z.undefined(), response: z.array(privacyRule) },
  "privacy:addRule": {
    request: z.object({
      type: privacyRule.shape.type,
      pattern: z.string().min(1).max(500),
      action: privacyRule.shape.action,
      enabled: z.boolean().default(true),
    }),
    response: privacyRule,
  },
  "privacy:updateRule": {
    // pattern/action/enabled 三者可选，只传的字段才会进 patch。
    request: z.object({
      id: z.string().min(1),
      pattern: z.string().min(1).max(500).optional(),
      action: privacyRule.shape.action.optional(),
      enabled: z.boolean().optional(),
    }),
    response: z.object({ ok: z.literal(true), rule: privacyRule }),
  },
  "privacy:deleteRule": { request: z.object({ id: z.string().min(1) }), response: z.object({ ok: z.boolean() }) },
  "reminders:list": { request: z.undefined(), response: z.array(proactiveItem) },
  "reminders:updateStatus": {
    request: z.object({
      id: z.string().min(1),
      status: z.enum(["new", "confirmed", "ignored", "snoozed", "done", "do_not_remind_again"]),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  "memory:search": {
    request: z.object({
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      filters: MemorySearchFiltersSchema,
    }),
    response: z.object({
      results: z.array(MemorySearchItemSchema),
      total: z.number().int().nonnegative(),
      quality: z.enum(["strong", "weak", "none"]),
      queryTerms: z.array(z.string()),
    }),
  },
  "memory:expandSearch": {
    request: z.object({ query: z.string().min(1).max(500), filters: MemorySearchFiltersSchema }),
    response: z.union([
      z.object({ ok: z.literal(true), expandedTerms: z.array(z.string()), results: z.array(MemorySearchItemSchema), total: z.number().int().nonnegative(), quality: z.enum(["strong", "weak", "none"]) }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "memory:ask": {
    request: z.object({
      mode: z.enum(["summary", "answer"]),
      question: z.string().trim().max(1000).optional(),
      candidates: z.array(MemoryRefSchema).min(1).max(15),
    }).superRefine((value, context) => {
      if (value.mode === "answer" && !value.question) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["question"], message: "AI回答必须提供追问内容" });
      }
    }),
    response: z.union([
      z.object({
        ok: z.literal(true),
        mode: z.enum(["summary", "answer"]),
        answer: z.string(),
        caveat: z.string().optional(),
        sources: z.array(MemorySearchItemSchema),
        candidateCount: z.number().int().nonnegative(),
      }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "memory:getDetail": {
    request: MemoryDetailRefSchema,
    response: MemoryDetailSchema.nullable(),
  },
  "memory:getSourcePreview": {
    request: z.object({ observationId: z.string(), index: z.number().int().nonnegative() }),
    response: z.union([
      z.object({ ok: z.literal(true), dataUrl: z.string() }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "memory:openSourceUrl": {
    request: z.object({ url: z.string().url() }),
    response: z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "capture:forgetRecent": { request: z.object({ duration: z.enum(["15m", "30m", "1h", "today", "all"]) }), response: lifecycleSuccess },
  "screenshot:clear": { request: z.undefined(), response: lifecycleSuccess },
  "data:export": { request: z.object({ includeScreenshots: z.boolean().optional() }).default({}), response: z.union([z.object({ ok: z.literal(true), export: dataExport }), operationFailure]) },
  "data:clearAll": { request: z.undefined(), response: z.union([lifecycleSuccess, operationFailure]) },
  "data:getCacheSize": { request: z.undefined(), response: z.object({ ok: z.literal(true), bytes: z.number().nonnegative(), fileCount: z.number().int().nonnegative() }) },
  "timeline:build": { request: dateKey, response: ipcResult(z.unknown()) },
  "timeline:reorganizeDay": { request: dateKey, response: ipcResult(z.unknown()) },
  "timeline:get": { request: dateKey, response: ipcResult(z.array(TodayTimelineProjectionSchema)) },
  "activity:getDayOverview": {
    request: dateKey,
    response: ipcResult(z.object({
      stats: z.object({
        totalObservedMinutes: z.number().nonnegative(),
        categorizedMinutes: z.record(
          z.enum(["focus_work", "communication", "research", "writing", "coding", "design", "meeting", "admin", "break", "mixed", "unknown"]),
          z.number().nonnegative()
        ),
        pendingMinutes: z.number().nonnegative(),
        sampleCount: z.number().int().nonnegative(),
      }),
      episodes: z.array(z.object({
        id: z.string(),
        startAt: z.string(),
        endAt: z.string(),
        title: z.string(),
        summary: z.string(),
        category: z.enum(["focus_work", "communication", "research", "writing", "coding", "design", "meeting", "admin", "break", "mixed", "unknown"]),
        categoryConfidence: z.number().min(0).max(1),
        sourceObservationIds: stringArray,
        projectNames: stringArray,
        topicTexts: stringArray,
      })),
      windows: z.array(z.object({
        id: z.string(),
        startAt: z.string(),
        endAt: z.string(),
        title: z.string(),
        summary: z.string(),
        category: z.enum(["focus_work", "communication", "research", "writing", "coding", "design", "meeting", "admin", "break", "mixed", "unknown"]),
        categoryConfidence: z.number().min(0).max(1),
        sourceEpisodeIds: stringArray,
        sourceObservationIds: stringArray,
        projectNames: stringArray,
        topicTexts: stringArray,
      })),
      observedStartAt: z.string().nullable(),
      observedEndAt: z.string().nullable(),
    })),
  },
  "workReport:generate": {
    request: z.object({
      dateKey,
      selectedBlockIds: stringArray,
      style: z.enum(["brief", "standard", "formal"]),
      recipientHint: z.enum(["manager", "team", "client", "self"]).optional(),
      generationRequirement: z.string().trim().max(2000).optional(),
    }),
    response: ipcResult(z.unknown()),
  },
  "workReport:get": { request: dateKey, response: ipcResult(WorkReportSchema.nullable()) },
  "workReport:saveSelection": { request: z.object({ dateKey, selectedBlockIds: stringArray, excludedBlockIds: stringArray }), response: ipcResult(z.null()) },
  "reports:getImage": {
    request: z.object({ id: z.string().min(1).max(200) }),
    response: ipcResult(z.object({ dataUrl: z.string(), mimeType: z.string() }).nullable()),
  },
  "reports:notification:get": {
    request: z.undefined(),
    response: z.object({
      reportId: z.string(),
      type: z.string(),
      title: z.string(),
      dateKey: z.string(),
    }).nullable(),
  },
  "reports:notification:dismiss": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true) }),
  },
  "reports:notification:open": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true) }),
  },
  // 版本更新
  "app:getVersion": { request: z.undefined(), response: z.object({ version: z.string() }) },
  "update:check": {
    request: z.object({ force: z.boolean().optional() }).default({}),
    response: z.object({
      hasUpdate: z.boolean(),
      currentVersion: z.string(),
      latestVersion: z.string(),
      downloadUrl: z.string(),
      sha256: z.string(),
      releaseNotes: z.string(),
      publishedAt: z.string(),
    }),
  },
  "update:download": {
    request: z.undefined(),
    response: z.object({ installerPath: z.string() }),
  },
  "update:installAndQuit": {
    request: z.object({ installerPath: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
  "update:getStatus": {
    request: z.undefined(),
    response: z.union([
      z.object({ state: z.literal("idle") }),
      z.object({ state: z.literal("checking") }),
      z.object({ state: z.literal("hasUpdate"), info: z.unknown() }),
      z.object({ state: z.literal("noUpdate"), info: z.unknown() }),
      z.object({
        state: z.literal("downloading"),
        progress: z.object({
          bytesDownloaded: z.number(),
          bytesTotal: z.number(),
          percent: z.number(),
        }),
      }),
      z.object({
        state: z.literal("downloaded"),
        installerPath: z.string(),
        info: z.unknown(),
      }),
      z.object({ state: z.literal("installing") }),
      z.object({ state: z.literal("error"), message: z.string(), code: z.string().optional() }),
    ]),
  },
  "update:dismissVersion": {
    request: z.object({ version: z.string() }),
    response: z.object({ ok: z.literal(true) }),
  },
} as const;

export type ValidatedIpcChannel = keyof typeof ipcContracts;
export type IpcRequest<C extends ValidatedIpcChannel> = z.input<(typeof ipcContracts)[C]["request"]>;
export type IpcResponse<C extends ValidatedIpcChannel> = z.output<(typeof ipcContracts)[C]["response"]>;

export const validatedIpcChannels = Object.keys(ipcContracts) as ValidatedIpcChannel[];
