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
  id: z.string(), dateKey, title: z.string(), plainText: z.string(),
  sections: z.object({ completed: stringArray, projectProgress: stringArray, risks: stringArray, tomorrowPlan: stringArray }),
  sourceTimelineBlockIds: stringArray, sourceFactIds: stringArray, omittedForPrivacy: z.number(), warnings: stringArray,
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

export const ipcContracts = {
  "app:getStatus": { request: z.undefined(), response: AppStatusSchema },
  "app:startObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:pauseObserving": { request: z.undefined(), response: AppStatusSchema },
  "app:getLaunchAtLogin": { request: z.undefined(), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
  "app:setLaunchAtLogin": { request: z.object({ enabled: z.boolean() }), response: z.object({ ok: z.literal(true), enabled: z.boolean() }) },
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
  "workReport:generate": {
    request: z.object({ dateKey, selectedBlockIds: stringArray, style: z.enum(["brief", "standard", "formal"]), recipientHint: z.enum(["manager", "team", "client", "self"]).optional() }),
    response: ipcResult(z.unknown()),
  },
  "workReport:get": { request: dateKey, response: ipcResult(WorkReportSchema.nullable()) },
  "workReport:saveSelection": { request: z.object({ dateKey, selectedBlockIds: stringArray, excludedBlockIds: stringArray }), response: ipcResult(z.null()) },
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
