import type { StoreApi } from "zustand";
import type { DataExportResult, SearchResultItem, SearchFilters } from "./store";
import { getIpc } from "./ipc";

export interface SearchDataState {
  searchQuery: string;
  searchResults: SearchResultItem[];
  searchTotal: number;
  searchQuality: "strong" | "weak" | "none";
  searchQueryTerms: string[];
  searchFilters: SearchFilters;
  searchExpandedTerms: string[];
  searchExpandLoading: boolean;
  searchExpandError: string | null;
  searchLoading: boolean;
  searchError: string | null;
  searchSearched: boolean;
  todayData: unknown;
  todayLoadedAt: number | null;
  todayPageData: unknown;
  reminders: unknown[];
  remindersLoadedAt: number | null;
  followupQuestion: string;
  aiMode: "summary" | "answer" | null;
  aiResult: unknown;
  aiError: string | null;
  projectDetail: unknown;
  mergeSuggestions: unknown[];
  allAliases: unknown;
  reportsList: unknown[];
  personalReview: unknown;
  workReport: unknown;
  unfinishedThreads: unknown[];
  selectedBlockIds: string[];
  ignoredBlockIds: string[];
  debugJobs: unknown;
  debugJobDetails: unknown;
  debugRelatedRecords: unknown;
  todayPageDateKey: string;
  loadToday: () => Promise<void>;
  loadTodayPageData: (dateKey: string) => Promise<void>;
}

type Set = StoreApi<SearchDataState>["setState"];
type Get = StoreApi<SearchDataState>["getState"];

/** 搜索请求序号：只有最后一次请求的结果允许落地，避免快速连续搜索/展开时旧响应覆盖新结果。 */
let latestSearchRequestId = 0;

export async function searchMemoryAction(set: Set, query: string, limit = 50, offset = 0, filters: SearchFilters = {}): Promise<void> {
  if (!query.trim()) return;
  const requestId = ++latestSearchRequestId;
  set({ searchLoading: true, searchError: null, searchExpandError: null, searchQuery: query, followupQuestion: "", aiMode: null, aiResult: null, aiError: null });
  try {
    const result = await getIpc().memory.search({ query: query.trim(), limit, offset, filters });
    if (requestId !== latestSearchRequestId) return;
    set({ searchResults: result.results, searchTotal: result.total, searchQuality: result.quality, searchQueryTerms: result.queryTerms, searchFilters: filters, searchExpandedTerms: [], searchLoading: false, searchSearched: true });
  } catch (error) {
    if (requestId !== latestSearchRequestId) return;
    set({ searchLoading: false, searchError: error instanceof Error ? error.message : String(error), searchSearched: true });
  }
}

export async function expandSearchAction(set: Set, query: string, filters: SearchFilters = {}): Promise<void> {
  if (!query.trim()) return;
  const requestId = ++latestSearchRequestId;
  set({ searchExpandLoading: true, searchExpandError: null, aiMode: null, aiResult: null, aiError: null });
  try {
    const result = await getIpc().memory.expandSearch({ query: query.trim(), filters });
    if (!result.ok) {
      if (requestId !== latestSearchRequestId) return;
      set({ searchExpandLoading: false, searchExpandError: result.message });
      return;
    }
    if (requestId !== latestSearchRequestId) return;
    set({ searchResults: result.results, searchTotal: result.total, searchQuality: result.quality, searchExpandedTerms: result.expandedTerms, searchExpandLoading: false, searchSearched: true });
  } catch (error) {
    if (requestId !== latestSearchRequestId) return;
    set({ searchExpandLoading: false, searchExpandError: error instanceof Error ? error.message : String(error) });
  }
}

export async function forgetRecentAction(set: Set, get: Get, emptyToday: unknown, duration: "15m" | "30m" | "1h" | "today") {
  const result = await getIpc().capture.forgetRecent({ duration });
  set({ todayData: emptyToday, todayLoadedAt: null, todayPageData: null, reminders: [], remindersLoadedAt: null, searchResults: [], searchTotal: 0, searchQuality: "none", searchQueryTerms: [], searchExpandedTerms: [], searchSearched: false, followupQuestion: "", aiMode: null, aiResult: null, aiError: null, projectDetail: null, reportsList: [], personalReview: null, workReport: null, unfinishedThreads: [], debugJobs: null, debugJobDetails: null, debugRelatedRecords: null });
  await Promise.all([get().loadToday(), get().loadTodayPageData(get().todayPageDateKey)]);
  return { deletedObservations: result.deletedObservations ?? 0, deletedScreenshots: result.deletedScreenshots };
}

export async function exportDataAction(input: { includeScreenshots?: boolean }): Promise<{ ok: boolean; data?: DataExportResult; error?: string }> {
  try {
    const result = await getIpc().data.export(input);
    return result.ok ? { ok: true, data: result.export as DataExportResult } : { ok: false, error: result.message };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function clearAllDataAction(set: Set) {
  try {
    const result = await getIpc().data.clearAll();
    if (!result.ok) return { ok: false, error: result.message };
    set({ todayLoadedAt: null, todayPageData: null, reminders: [], remindersLoadedAt: null, searchResults: [], searchSearched: false, followupQuestion: "", aiMode: null, aiResult: null, aiError: null, projectDetail: null, mergeSuggestions: [], allAliases: null, reportsList: [], personalReview: null, workReport: null, unfinishedThreads: [], selectedBlockIds: [], ignoredBlockIds: [], debugJobs: null, debugJobDetails: null, debugRelatedRecords: null });
    return { ok: true, deletedScreenshots: result.deletedScreenshots };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function clearScreenshotsOnlyAction() {
  try { const result = await getIpc().screenshot.clear(); return { ok: true, deletedScreenshots: result.deletedScreenshots }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function getCacheSizeAction() {
  try { return await getIpc().data.getCacheSize(); }
  catch { return { ok: true as const, bytes: 0, fileCount: 0 }; }
}
