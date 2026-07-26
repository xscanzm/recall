// src/renderer/state/slices/debug.ts
// 调试页：模型任务与关联记录
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, DebugJobSummary, DebugJobDetails, DebugRelatedRecords } from "../types";
import { getIpc } from "../ipc";

export interface DebugSlice {

  // 调试模式：DebugPage 数据
  debugJobs: DebugJobSummary[] | null;
  debugJobsLoading: boolean;
  debugJobsError: string | null;
  debugJobDetails: DebugJobDetails | null;
  debugJobDetailsLoading: boolean;
  debugRelatedRecords: DebugRelatedRecords | null;
  debugRelatedRecordsLoading: boolean;
  debugFilters: {
    startAt: string;
    endAt: string;
    jobType: string;
    status: string;
  };

  // 调试模式 actions
  loadDebugJobs: () => Promise<void>;
  loadDebugJobDetails: (jobId: string) => Promise<void>;
  loadDebugRelatedRecords: (createdAt: string) => Promise<void>;
  setDebugFilters: (patch: Partial<{ startAt: string; endAt: string; jobType: string; status: string }>) => void;
  clearDebugState: () => void;
}

export const createDebugSlice: AppSliceCreator<DebugSlice> = (set, get) => ({

  // 调试模式初始状态
  debugJobs: null,
  debugJobsLoading: false,
  debugJobsError: null,
  debugJobDetails: null,
  debugJobDetailsLoading: false,
  debugRelatedRecords: null,
  debugRelatedRecordsLoading: false,
  debugFilters: {
    startAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    endAt: new Date().toISOString(),
    jobType: "all",
    status: "all",
  },

  // -------------------- debug actions --------------------
  loadDebugJobs: async () => {
    const filters = get().debugFilters;
    set({ debugJobsLoading: true, debugJobsError: null });
    try {
      const result = await getIpc().debug.listJobs({
        startAt: filters.startAt,
        endAt: filters.endAt,
        limit: 500,
      });
      if (result.ok) {
        const jobs: DebugJobSummary[] = (result.data as Array<Record<string, unknown>>).map((j) => {
          let debugEventCount = 0;
          if (typeof j.debugEventsJson === "string" && j.debugEventsJson) {
            try {
              const events = JSON.parse(j.debugEventsJson);
              if (Array.isArray(events)) debugEventCount = events.length;
            } catch {
              // ignore parse error
            }
          }
          return {
            id: String(j.id),
            type: String(j.type),
            status: String(j.status),
            attempts: Number(j.attempts ?? 0),
            createdAt: String(j.createdAt ?? j.created_at ?? ""),
            updatedAt: String(j.updatedAt ?? j.updated_at ?? ""),
            errorCode: (j.errorCode ?? j.error_code ?? null) as string | null,
            errorMessage: (j.errorMessage ?? j.error_message ?? null) as string | null,
            debugEventCount,
            inputJson: typeof j.inputJson === "string" ? j.inputJson : (typeof j.input_json === "string" ? j.input_json : ""),
          };
        });
        set({ debugJobs: jobs, debugJobsLoading: false });
      } else {
        set({ debugJobsLoading: false, debugJobsError: result.error });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ debugJobsLoading: false, debugJobsError: message });
    }
  },

  loadDebugJobDetails: async (jobId: string) => {
    set({ debugJobDetailsLoading: true, debugJobDetails: null });
    try {
      const result = await getIpc().debug.getJobDetails(jobId);
      if (result.ok && result.data) {
        const j = result.data as Record<string, unknown>;
        const details: DebugJobDetails = {
          id: String(j.id),
          type: String(j.type),
          status: String(j.status),
          inputJson: String(j.inputJson ?? j.input_json ?? ""),
          outputJson: (j.outputJson ?? j.output_json ?? null) as string | null,
          errorCode: (j.errorCode ?? j.error_code ?? null) as string | null,
          errorMessage: (j.errorMessage ?? j.error_message ?? null) as string | null,
          attempts: Number(j.attempts ?? 0),
          createdAt: String(j.createdAt ?? j.created_at ?? ""),
          updatedAt: String(j.updatedAt ?? j.updated_at ?? ""),
          rawInputJson: (j.rawInputJson ?? j.raw_input_json ?? null) as string | null,
          debugEventsJson: (j.debugEventsJson ?? j.debug_events_json ?? null) as string | null,
        };
        set({ debugJobDetails: details, debugJobDetailsLoading: false });
      } else {
        set({ debugJobDetailsLoading: false, debugJobDetails: null });
      }
    } catch (err) {
      set({ debugJobDetailsLoading: false, debugJobDetails: null });
      console.error("loadDebugJobDetails failed:", err);
    }
  },

  loadDebugRelatedRecords: async (createdAt: string) => {
    set({ debugRelatedRecordsLoading: true, debugRelatedRecords: null });
    try {
      const result = await getIpc().debug.getRelatedRecords({ createdAt, windowSeconds: 60 });
      if (result.ok) {
        set({ debugRelatedRecords: result.data as DebugRelatedRecords, debugRelatedRecordsLoading: false });
      } else {
        set({ debugRelatedRecordsLoading: false, debugRelatedRecords: null });
      }
    } catch (err) {
      set({ debugRelatedRecordsLoading: false, debugRelatedRecords: null });
      console.error("loadDebugRelatedRecords failed:", err);
    }
  },

  setDebugFilters: (patch) => {
    set({ debugFilters: { ...get().debugFilters, ...patch } });
  },

  clearDebugState: () => {
    set({
      debugJobs: null,
      debugJobsError: null,
      debugJobDetails: null,
      debugRelatedRecords: null,
    });
  },
});
