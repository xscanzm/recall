import type { StoreApi } from "zustand";
import type { DataExportResult, SearchResultItem } from "./store";
import { getIpc } from "./ipc";

export interface SearchDataState {
  searchQuery: string;
  searchResults: SearchResultItem[];
  searchLoading: boolean;
  searchError: string | null;
  searchSearched: boolean;
  todayData: unknown;
  todayLoadedAt: number | null;
  todayPageData: unknown;
  reminders: unknown[];
  remindersLoadedAt: number | null;
  askResult: unknown;
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

export async function searchMemoryAction(set: Set, query: string, limit = 50, offset = 0): Promise<void> {
  if (!query.trim()) return;
  set({ searchLoading: true, searchError: null, searchQuery: query });
  try {
    const result = await getIpc().memory.search({ query: query.trim(), limit, offset });
    set({ searchResults: result.results, searchLoading: false, searchSearched: true });
  } catch (error) {
    set({ searchLoading: false, searchError: error instanceof Error ? error.message : String(error), searchSearched: true });
  }
}

export async function forgetRecentAction(set: Set, get: Get, emptyToday: unknown, duration: "15m" | "30m" | "1h" | "today") {
  const result = await getIpc().capture.forgetRecent({ duration });
  set({ todayData: emptyToday, todayLoadedAt: null, todayPageData: null, reminders: [], remindersLoadedAt: null, searchResults: [], searchSearched: false, projectDetail: null, reportsList: [], personalReview: null, workReport: null, unfinishedThreads: [], debugJobs: null, debugJobDetails: null, debugRelatedRecords: null });
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
    set({ todayLoadedAt: null, todayPageData: null, reminders: [], remindersLoadedAt: null, searchResults: [], searchSearched: false, askResult: null, projectDetail: null, mergeSuggestions: [], allAliases: null, reportsList: [], personalReview: null, workReport: null, unfinishedThreads: [], selectedBlockIds: [], ignoredBlockIds: [], debugJobs: null, debugJobDetails: null, debugRelatedRecords: null });
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
