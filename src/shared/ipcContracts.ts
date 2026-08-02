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

/** 与 shared/types.ts ModelConfig 对齐。 */
const modelConfig = z.object({
  id: z.string(),
  kind: z.enum(["vision", "language", "multimodal"]),
  providerName: z.string(),
  endpoint: z.string(),
  model: z.string(),
  optionsJson: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 与 shared/types.ts EndOfDayReview / EndOfDayReviewItem 对齐。 */
const endOfDayReviewItem = z.object({
  id: z.string(),
  text: z.string(),
  sourceType: z.enum(["timeline_block", "unfinished_thread"]),
});
const endOfDayReview = z.object({
  dateKey: z.string(),
  completed: z.array(endOfDayReviewItem),
  attention: z.array(endOfDayReviewItem),
  empty: z.boolean(),
});

/** 与 main/models/schemas.ts ModelTestConnectionInputSchema 对齐。 */
const modelTestConnectionInput = z.object({
  kind: z.enum(["vision", "language", "multimodal"]),
  endpoint: z.string().url(),
  model: z.string().min(1),
  // API Key 不进入 renderer/SQLite/日志：测试连接时通过临时字段传入 main 进程
  apiKey: z.string().min(1),
});

/** 与 main/models/schemas.ts ModelSaveConfigInputSchema 对齐。 */
const modelSaveConfigInput = z.object({
  id: z.string().min(1).optional(),
  kind: z.enum(["vision", "language", "multimodal"]),
  providerName: z.string().min(1).max(120),
  endpoint: z.string().url(),
  model: z.string().min(1).max(120),
  apiKey: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  // Phase 7：可选字段，留空时使用模型默认值（写入 options_json）
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).optional(),
});

/** 与 main/models/schemas.ts MemoryUpdateFactInputSchema 对齐。 */
const memoryUpdateFactInput = z.object({
  id: z.string().min(1),
  content: z.string().max(5000).optional(),
  importance: z.number().min(0).max(1).optional(),
  status: z
    .enum(["open", "in_progress", "likely_done", "done", "blocked", "unknown"])
    .optional(),
  tags: z.array(z.string()).optional(),
});

/** 与 main/models/schemas.ts MemoryUpdateTaskInputSchema 对齐。 */
const memoryUpdateTaskInput = z.object({
  id: z.string().min(1),
  title: z.string().max(200).optional(),
  status: z
    .enum([
      "open",
      "in_progress",
      "likely_done",
      "done",
      "blocked",
      "needs_confirmation",
    ])
    .optional(),
  projectId: z.string().nullable().optional(),
  summary: z.string().max(2000).nullable().optional(),
});

/** 与 main/models/schemas.ts MemoryUpdatePersonInputSchema 对齐。 */
const memoryUpdatePersonInput = z.object({
  id: z.string().min(1),
  name: z.string().max(200).optional(),
  role: z.string().max(200).nullable().optional(),
  organization: z.string().max(200).nullable().optional(),
  relationship: z.string().max(200).nullable().optional(),
  summary: z.string().max(2000).nullable().optional(),
});

/** 与 main/models/schemas.ts UserFeedbackInputSchema 对齐。 */
const userFeedbackInput = z.object({
  targetType: z.enum(["fact", "task", "scene", "project", "person", "decision", "reminder"]),
  targetId: z.string().min(1),
  feedbackType: z.enum([
    "content_wrong",
    "not_important",
    "wrong_project",
    "task_done",
    "not_a_task",
    "do_not_record",
    "sensitive_delete",
  ]),
  note: z.string().max(1000).optional(),
  /** 可选：更新对象字段（不覆盖 source ids） */
  patch: z.record(z.string(), z.unknown()).optional(),
});

/** 与 main/models/schemas.ts MergeObjectsInputSchema 对齐。 */
const mergeObjectsInput = z.object({
  objectType: z.enum(["project", "task", "person", "decision"]),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

/** 与 main/models/schemas.ts DebugListJobsInputSchema / DebugRelatedRecordsInputSchema 对齐。 */
const debugListJobsInput = z.object({
  startAt: z.string(),
  endAt: z.string(),
  limit: z.number().int().min(1).max(1000).optional(),
});
const debugRelatedRecordsInput = z.object({
  createdAt: z.string(),
  windowSeconds: z.number().int().min(1).max(300).optional(),
});

export const ipcContracts = {
  "app:getStatus": { request: z.undefined(), response: AppStatusSchema },
  "app:startObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:pauseObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:getLaunchAtLogin": { request: z.undefined(), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
  "app:setLaunchAtLogin": { request: z.object({ enabled: z.boolean() }), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
  "window:minimize": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "window:toggleMaximize": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "window:drag": {
    request: z.object({
      phase: z.enum(["start", "move", "end"]),
      screenX: z.number().finite(),
      screenY: z.number().finite(),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  "window:close": { request: z.undefined(), response: z.object({ ok: z.literal(true) }) },
  "settings:get": { request: z.undefined(), response: appSettings },
  "settings:update": { request: appSettingsPatch, response: z.object({ ok: z.literal(true), settings: appSettings }) },
  "model:testConnection": {
    request: modelTestConnectionInput,
    response: z.union([
      z.object({ ok: z.literal(true) }),
      z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
    ]),
  },
  "model:defaultConsent:resolve": {
    request: z.object({ accepted: z.boolean() }),
    response: z.object({ ok: z.literal(true) }),
  },
  "model:listConfigs": {
    request: z.object({
      kind: z.enum(["vision", "language", "multimodal"]).optional(),
      enabled: z.boolean().optional(),
    }).optional(),
    response: z.array(modelConfig),
  },
  "model:saveConfig": {
    request: modelSaveConfigInput,
    response: z.object({ ok: z.literal(true), config: modelConfig, warning: z.string().optional() }),
  },
  "model:deleteConfig": {
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.boolean() }),
  },
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
  "memory:listToday": {
    request: z.undefined(),
    response: z.object({
      observations: z.array(z.unknown()),
      facts: z.array(z.unknown()),
      scenes: z.array(z.unknown()),
      tasks: z.array(z.unknown()),
      decisions: z.array(z.unknown()),
      people: z.array(z.unknown()),
      projects: z.array(z.unknown()),
    }),
  },
  "memory:updateFact": {
    request: memoryUpdateFactInput,
    response: z.object({ ok: z.literal(true), fact: z.unknown() }),
  },
  "memory:updateTask": {
    request: memoryUpdateTaskInput,
    response: z.object({ ok: z.literal(true), task: z.unknown() }),
  },
  "memory:updatePerson": {
    request: memoryUpdatePersonInput,
    response: z.object({ ok: z.literal(true), person: z.unknown() }),
  },
  "memory:deleteObject": {
    request: z.object({
      id: z.string().min(1),
      type: z.enum(["fact", "task", "scene", "project", "person", "decision"]),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  "memory:createUserFeedback": {
    request: userFeedbackInput,
    response: z.object({ ok: z.literal(true), feedback: z.unknown() }),
  },
  "memory:getProjectDetail": {
    request: z.object({ id: z.string().min(1) }),
    response: z.object({
      project: z.unknown(),
      facts: z.array(z.unknown()),
      scenes: z.array(z.unknown()),
      tasks: z.array(z.unknown()),
      decisions: z.array(z.unknown()),
      people: z.array(z.unknown()),
      recentReports: z.array(z.unknown()),
    }),
  },
  "memory:getPersonDetail": {
    request: z.object({ id: z.string().min(1) }),
    response: z.object({
      person: z.unknown(),
      relatedProjects: z.array(z.unknown()),
      relatedScenes: z.array(z.unknown()),
      relatedTasks: z.array(z.unknown()),
      relatedFacts: z.array(z.unknown()),
    }),
  },
  "memory:mergeObjects": {
    request: mergeObjectsInput,
    response: z.object({ ok: z.literal(true), merged: z.unknown() }),
  },
  "memory:listMergeSuggestions": {
    request: z.object({
      status: z.enum(["new", "confirmed", "ignored", "all"]).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }).optional(),
    response: z.object({ ok: z.literal(true), items: z.array(proactiveItem) }),
  },
  "memory:rejectMergeSuggestion": {
    request: z.object({ id: z.string().min(1) }),
    response: z.object({ ok: z.literal(true) }),
  },
  "memory:listAllAliases": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true), projects: z.array(z.unknown()), people: z.array(z.unknown()) }),
  },
  "memory:listPeople": {
    request: z.object({
      includeDeleted: z.boolean().optional(),
      admissionStatus: z.enum(["promoted", "candidate", "rejected"]).optional(),
      includeNonPromoted: z.boolean().optional(),
    }).optional(),
    response: z.object({ ok: z.literal(true), people: z.array(z.unknown()) }),
  },
  "memory:listProjects": {
    request: z.object({
      includeArchived: z.boolean().optional(),
      admissionStatus: z.enum(["promoted", "candidate", "rejected"]).optional(),
      includeNonPromoted: z.boolean().optional(),
    }).optional(),
    response: z.object({ ok: z.literal(true), projects: z.array(z.unknown()) }),
  },
  "memory:reviewAdmission": {
    request: z.object({
      objectType: z.enum(["project", "person"]),
      id: z.string().min(1),
      decision: z.enum(["promote", "reject", "restore"]),
    }),
    response: z.object({ ok: z.literal(true) }),
  },
  "capture:forgetRecent": { request: z.object({ duration: z.enum(["15m", "30m", "1h", "today", "all"]) }), response: lifecycleSuccess },
  "screenshot:clear": { request: z.undefined(), response: lifecycleSuccess },
  "data:export": { request: z.object({ includeScreenshots: z.boolean().optional() }).default({}), response: z.union([z.object({ ok: z.literal(true), export: dataExport }), operationFailure]) },
  "data:clearAll": { request: z.undefined(), response: z.union([lifecycleSuccess, operationFailure]) },
  "data:getCacheSize": { request: z.undefined(), response: z.object({ ok: z.literal(true), bytes: z.number().nonnegative(), fileCount: z.number().int().nonnegative() }) },
  "debug:listJobs": {
    request: debugListJobsInput,
    response: z.union([
      z.object({ ok: z.literal(true), data: z.array(z.unknown()) }),
      z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
    ]),
  },
  "debug:getJobDetails": {
    request: z.object({ jobId: z.string().min(1) }),
    response: z.union([
      z.object({ ok: z.literal(true), data: z.unknown() }),
      z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
    ]),
  },
  "debug:getRelatedRecords": {
    request: debugRelatedRecordsInput,
    response: z.union([
      z.object({
        ok: z.literal(true),
        data: z.object({
          observations: z.array(z.unknown()),
          facts: z.array(z.unknown()),
          scenes: z.array(z.unknown()),
          proactiveItems: z.array(z.unknown()),
        }),
      }),
      z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
    ]),
  },
  "mac:checkPermissions": {
    request: z.undefined(),
    response: z.object({
      ok: z.literal(true),
      data: z.object({
        isMac: z.boolean(),
        screenCaptureGranted: z.boolean(),
        accessibilityGranted: z.boolean(),
      }),
    }),
  },
  "mac:openSystemSettings": {
    request: z.object({ privacyType: z.enum(["screen", "accessibility"]) }),
    response: z.union([
      z.object({ ok: z.literal(true), data: z.object({ success: z.boolean() }) }),
      z.object({ ok: z.literal(false), error: z.string(), code: z.string().optional() }),
    ]),
  },
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
  "endOfDayReview:get": {
    request: z.undefined(),
    response: endOfDayReview.nullable(),
  },
  "endOfDayReview:viewToday": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true) }),
  },
  "endOfDayReview:snooze": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true) }),
  },
  "endOfDayReview:dismiss": {
    request: z.undefined(),
    response: z.object({ ok: z.literal(true) }),
  },
  "endOfDayReview:expired": {
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
    // P0：无输入（z.undefined 严格拒绝任何非 undefined 载荷）。
    // 渲染层不得传入 installerPath——安装包路径由主进程 UpdateService
    // 在 downloadUpdate 成功时内部保存；传 { installerPath } 返回 schema_invalid。
    request: z.undefined(),
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
