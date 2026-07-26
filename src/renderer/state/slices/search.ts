// src/renderer/state/slices/search.ts
// 记忆搜索与 AI 追问
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, SearchResultItem, SearchFilters, AskResult } from "../types";
import { getIpc } from "../ipc";
import { searchMemoryAction } from "../searchDataActions";

export interface SearchSlice {

  // M7 新增：搜索结果
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
  searchSearched: boolean; // 是否已执行过搜索

  followupQuestion: string;
  aiMode: "summary" | "answer" | null;
  aiResult: AskResult | null;
  aiLoading: boolean;
  aiError: string | null;

  // M7 新增：搜索 / 问答 / 项目详情 / 任务更新 / 删除 / 纠错 / 合并 / 忘掉最近
  searchMemory: (query: string, limit?: number, offset?: number, filters?: SearchFilters) => Promise<void>;
  expandSearch: (query: string, filters?: SearchFilters) => Promise<void>;
  setFollowupQuestion: (question: string) => void;
  analyzeMemory: (mode: "summary" | "answer", candidates: Array<{ id: string; type: SearchResultItem["type"] }>, question?: string) => Promise<void>;
}

export const createSearchSlice: AppSliceCreator<SearchSlice> = (set, get) => ({

  // M7 新增：搜索状态
  searchQuery: "",
  searchResults: [],
  searchTotal: 0,
  searchQuality: "none",
  searchQueryTerms: [],
  searchFilters: {},
  searchExpandedTerms: [],
  searchExpandLoading: false,
  searchExpandError: null,
  searchLoading: false,
  searchError: null,
  searchSearched: false,

  followupQuestion: "",
  aiMode: null,
  aiResult: null,
  aiLoading: false,
  aiError: null,
  searchMemory: async (query: string, limit = 50, offset = 0, filters = {}) => {
    await searchMemoryAction(set as never, query, limit, offset, filters);
  },

  /**
   * 轻量问答（调用 memory:ask IPC）
   * 来自 spec.md "历史查询与轻量问答"：
   * - 自然语言输入
   * - 检索相关 facts/scenes/reports
   * - LLM 基于检索结果回答
   * - 回答必须列出来源对象
   * - 聊天只是查询入口，不作为主界面
   */
  expandSearch: async (query: string, filters = {}) => {
    if (!query.trim()) return;
    set({ searchExpandLoading: true, searchExpandError: null, aiMode: null, aiResult: null, aiError: null });
    try {
      const result = await getIpc().memory.expandSearch({ query: query.trim(), filters });
      if (!result.ok) {
        set({ searchExpandLoading: false, searchExpandError: result.message });
        return;
      }
      set({ searchResults: result.results, searchTotal: result.total, searchQuality: result.quality, searchExpandedTerms: result.expandedTerms, searchExpandLoading: false, searchSearched: true });
    } catch (err) {
      set({ searchExpandLoading: false, searchExpandError: err instanceof Error ? err.message : String(err) });
    }
  },

  setFollowupQuestion: (question) => set({ followupQuestion: question }),

  analyzeMemory: async (mode, candidates, question) => {
    const normalizedQuestion = question?.trim();
    if (mode === "answer" && !normalizedQuestion) return;
    set({
      aiLoading: true,
      aiError: null,
      aiMode: mode,
      aiResult: null,
      followupQuestion: mode === "answer" ? normalizedQuestion ?? "" : get().followupQuestion,
    });
    try {
      const result = await getIpc().memory.ask({ mode, question: normalizedQuestion, candidates });
      set({
        aiResult: result,
        aiLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        aiLoading: false,
        aiError: message,
        aiResult: { ok: false, code: "unknown_error", message },
      });
    }
  },

  /**
   * 加载项目详情（调用 memory:getProjectDetail IPC）
   * 返回项目主线 + 最近场景 + 任务 + 决策 + 人物 + 报告片段
   */
});
