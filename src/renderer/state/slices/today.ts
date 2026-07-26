// src/renderer/state/slices/today.ts
// 今日页：今日数据、时间轴、工作日报选择模式
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, TodayData } from "../types";
import type { TodayPageData } from "../../../shared/types";
import { getIpc, fetchTodayPageData } from "../ipc";
import { isCurrentTodayPageRequest, shouldRollOverTodayDate } from "../todayNavigation";
import { EMPTY_TODAY, todayDateKey } from "../defaults";

/** 今日页请求序号：只有最后一次请求的结果允许落地，避免快速切换日期时旧响应覆盖新数据。 */
let latestTodayPageRequestId = 0;

export interface TodaySlice {

  // 今日数据
  todayData: TodayData;
  todayLoading: boolean;
  todayError: string | null;
  todayLoadedAt: number | null;

  // Phase 3 新增：今日页（doc 21）完整数据与工作日报选择模式
  todayPageData: TodayPageData | null;
  todayPageLoading: boolean;
  todayPageError: string | null;
  timelineBuildingDateKey: string | null;
  lastTimelineBuildAt: number;
  todayPageDateKey: string;
  todayPageFollowingToday: boolean;
  workReportSelectionMode: boolean;
  selectedBlockIds: string[];
  ignoredBlockIds: string[];
  workReportGenerating: boolean;
  workReportError: string | null;
  workReportStyle: "brief" | "standard" | "formal";
  workReportGenerationRequirement: string;
  previewModalOpen: boolean;
  personalReviewGenerating: boolean;
  personalReviewError: string | null;
  sidePanelDrawerOpen: boolean;

  loadToday: () => Promise<void>;

  // Phase 3 新增：今日页 actions
  loadTodayPageData: (dateKey: string) => Promise<void>;
  refreshTodayPageData: () => Promise<void>;
  setTodayPageDateKey: (dateKey: string) => void;
  /**
   * 跨日检测：dateKey 不是今天时自动滚动到今天 + 重新加载
   * 返回 true 表示发生了滚动
   */
  rollOverTodayDateKeyIfNeeded: () => boolean;
  buildTimeline: (dateKey: string) => Promise<void>;
  reorganizeTimelineDay: (dateKey: string) => Promise<void>;
  generatePersonalReview: (
    dateKey: string,
    generationRequirement?: string
  ) => Promise<boolean>;
  generateWorkReport: (params: {
    dateKey: string;
    selectedBlockIds: string[];
    style: "brief" | "standard" | "formal";
    recipientHint?: "manager" | "team" | "client" | "self";
    generationRequirement?: string;
  }) => Promise<boolean>;
  saveReportSelection: (params: {
    dateKey: string;
    selectedBlockIds: string[];
    excludedBlockIds: string[];
  }) => Promise<void>;
  setWorkReportSelectionMode: (enabled: boolean) => void;
  enterSelectionWithBlock: (blockId: string) => void;
  toggleBlockSelection: (blockId: string) => void;
  selectAllWorkBlocks: () => void;
  clearSelection: () => void;
  setWorkReportStyle: (style: "brief" | "standard" | "formal") => void;
  setWorkReportGenerationRequirement: (requirement: string) => void;
  setPreviewModalOpen: (open: boolean) => void;
  setSidePanelDrawerOpen: (open: boolean) => void;
  ignoreTimelineBlock: (id: string) => void;
}

export const createTodaySlice: AppSliceCreator<TodaySlice> = (set, get) => ({

  todayData: EMPTY_TODAY,
  todayLoading: false,
  todayError: null,
  todayLoadedAt: null,

  // Phase 3 新增：今日页初始状态
  todayPageData: null,
  todayPageLoading: false,
  todayPageError: null,
  timelineBuildingDateKey: null,
  lastTimelineBuildAt: 0,
  todayPageDateKey: todayDateKey(),
  todayPageFollowingToday: true,
  workReportSelectionMode: false,
  selectedBlockIds: [],
  ignoredBlockIds: [],
  workReportGenerating: false,
  workReportError: null,
  workReportStyle: "standard",
  workReportGenerationRequirement: "",
  previewModalOpen: false,
  personalReviewGenerating: false,
  personalReviewError: null,
  sidePanelDrawerOpen: false,
  loadToday: async () => {
    if (get().todayLoading) return;
    set({ todayLoading: true, todayError: null });
    try {
      const data = await getIpc().memory.listToday<TodayData>();
      set({
        todayData: data ?? EMPTY_TODAY,
        todayLoading: false,
        todayLoadedAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ todayLoading: false, todayError: message });
    }
  },

  /**
   * 加载提醒列表（调用 reminders:list IPC）
   */
  loadTodayPageData: async (dateKey: string) => {
    const requestId = ++latestTodayPageRequestId;
    set({ todayPageLoading: true, todayPageError: null, todayPageDateKey: dateKey });
    try {
      const appStatus = get().appStatus;
      const data = await fetchTodayPageData(dateKey, appStatus);
      if (!isCurrentTodayPageRequest(requestId, latestTodayPageRequestId, dateKey, get().todayPageDateKey)) return;
      // 进入时清理上一次的选择模式与忽略列表
      set({
        todayPageData: data,
        todayPageLoading: false,
        ignoredBlockIds: [],
        workReportSelectionMode: false,
        selectedBlockIds: [],
        previewModalOpen: false,
      });
    } catch (err) {
      if (!isCurrentTodayPageRequest(requestId, latestTodayPageRequestId, dateKey, get().todayPageDateKey)) return;
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageLoading: false, todayPageError: message });
    }
  },

  /**
   * 用当前 dateKey 重新加载今日页数据
   */
  refreshTodayPageData: async () => {
    const dateKey = get().todayPageDateKey;
    await get().loadTodayPageData(dateKey);
    const state = get();
    const data = state.todayPageData;
    // 触发增量 build 的条件：
    // 1. 完全无 blocks（首次生成）
    // 2. 距上次 build 超过 10 分钟且正在观察（增量补充新片段）
    const hasNoBlocks = data && data.timelineBlocks.length === 0;
    const staleBuild =
      Date.now() - state.lastTimelineBuildAt > 10 * 60 * 1000;
    const shouldTriggerBuild =
      data &&
      data.dateKey === dateKey &&
      dateKey === todayDateKey() &&
      (hasNoBlocks || staleBuild) &&
      state.appStatus.observing &&
      !state.appStatus.paused &&
      state.timelineBuildingDateKey !== dateKey;
    if (shouldTriggerBuild) {
      set({
        timelineBuildingDateKey: dateKey,
        todayPageLoading: true,
        todayPageError: null,
        lastTimelineBuildAt: Date.now(),
      });
      try {
        const res = await getIpc().timeline.build(dateKey);
        if (!res.ok && res.code !== "insufficient_data") {
          throw new Error(res.error ?? "时间轴生成失败");
        }
        set({ todayPageLoading: false });
        await get().loadTodayPageData(dateKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        set({ todayPageLoading: false, todayPageError: message });
      } finally {
        if (get().timelineBuildingDateKey === dateKey) {
          set({ timelineBuildingDateKey: null });
        }
      }
    }
  },

  setTodayPageDateKey: (dateKey: string) => set({
    todayPageDateKey: dateKey,
    todayPageFollowingToday: dateKey === todayDateKey(),
  }),

  /**
   * 跨日检测：如果当前 todayPageDateKey 已经不再是"今天"（本地时区），
   * 自动滚动到今天并重新加载数据。
   * 修复：renderer 长期开着跨过零点，dateKey 不会自动刷新，导致右侧一直显示昨天。
   * 调用方：TodayPage 挂载时、window focus 时、定时（每 30 分钟）调用。
   */
  rollOverTodayDateKeyIfNeeded: () => {
    const current = get().todayPageDateKey;
    const today = todayDateKey();
    if (shouldRollOverTodayDate(current, today, get().todayPageFollowingToday)) {
      set({ todayPageDateKey: today, todayPageFollowingToday: true });
      return true;
    }
    return false;
  },

  /**
   * 触发 TimelineBuilder 生成当天时间轴（调用 LLM），完成后重新加载
   */
  buildTimeline: async (dateKey: string) => {
    if (get().timelineBuildingDateKey === dateKey) return;
    set({ todayPageLoading: true, todayPageError: null, timelineBuildingDateKey: dateKey });
    try {
      const res = await getIpc().timeline.build(dateKey);
      if (!res.ok) throw new Error(res.error ?? "时间轴生成失败");
      set({ todayPageLoading: false });
      await get().loadTodayPageData(dateKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageLoading: false, todayPageError: message });
    } finally {
      if (get().timelineBuildingDateKey === dateKey) {
        set({ timelineBuildingDateKey: null });
      }
    }
  },

  reorganizeTimelineDay: async (dateKey: string) => {
    if (get().timelineBuildingDateKey === dateKey) return;
    set({ todayPageLoading: true, todayPageError: null, timelineBuildingDateKey: dateKey });
    try {
      const res = await getIpc().timeline.reorganizeDay(dateKey);
      if (!res.ok) throw new Error(res.error ?? "时间轴重整失败");
      await get().loadTodayPageData(dateKey);
    } catch (err) {
      set({ todayPageError: err instanceof Error ? err.message : String(err) });
    } finally {
      set({ todayPageLoading: false });
      if (get().timelineBuildingDateKey === dateKey) set({ timelineBuildingDateKey: null });
    }
  },

  /**
   * 生成个人复盘（调用 LLM），完成后重新加载
   */
  generatePersonalReview: async (
    dateKey: string,
    generationRequirement?: string
  ) => {
    set({ personalReviewGenerating: true, personalReviewError: null });
    try {
      const res = await getIpc().personalReview.generate({
        dateKey,
        ...(generationRequirement ? { generationRequirement } : {}),
      });
      if (!res.ok) throw new Error(res.error ?? "复盘生成失败");
      await get().loadTodayPageData(dateKey);
      set({ personalReviewGenerating: false });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ personalReviewGenerating: false, personalReviewError: message });
      return false;
    }
  },

  /**
   * 生成工作日报（基于用户选中的 TimelineBlock），完成后退出选择模式并重新加载
   */
  generateWorkReport: async (params) => {
    set({ workReportGenerating: true, workReportError: null });
    try {
      const res = await getIpc().workReport.generate(params);
      if (!res.ok) throw new Error(res.error ?? "日报生成失败");
      await get().loadTodayPageData(params.dateKey);
      set({
        workReportGenerating: false,
        workReportSelectionMode: false,
        previewModalOpen: false,
        workReportGenerationRequirement: "",
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ workReportGenerating: false, workReportError: message });
      return false;
    }
  },

  /**
   * 保存用户选区（不生成日报），best effort
   */
  saveReportSelection: async (params) => {
    try {
      await getIpc().workReport.saveSelection(params);
    } catch (err) {
      console.error("保存日报选区失败:", err);
    }
  },

  /**
   * 进入/退出工作日报选择模式
   * 进入时默认选中 reportable=true && privateRisk=low 的片段
   */
  setWorkReportSelectionMode: (enabled) => {
    if (enabled) {
      const data = get().todayPageData;
      const defaultSelected = data
        ? data.timelineBlocks
            .filter((b) => b.reportable && b.privateRisk === "low")
            .map((b) => b.id)
        : [];
      set({
        workReportSelectionMode: true,
        selectedBlockIds: defaultSelected,
        workReportError: null,
        previewModalOpen: false,
      });
    } else {
      set({
        workReportSelectionMode: false,
        selectedBlockIds: [],
        previewModalOpen: false,
        workReportError: null,
        workReportGenerationRequirement: "",
      });
    }
  },

  /**
   * 从某张卡片"加入日报"按钮进入选择模式，确保该 block 被选中
   */
  enterSelectionWithBlock: (blockId) => {
    const data = get().todayPageData;
    const defaultSelected = data
      ? data.timelineBlocks
          .filter((b) => b.reportable && b.privateRisk === "low")
          .map((b) => b.id)
      : [];
    const selected = defaultSelected.includes(blockId)
      ? defaultSelected
      : [...defaultSelected, blockId];
    set({
      workReportSelectionMode: true,
      selectedBlockIds: selected,
      workReportError: null,
      previewModalOpen: false,
    });
  },

  toggleBlockSelection: (blockId) => {
    const current = get().selectedBlockIds;
    if (current.includes(blockId)) {
      set({ selectedBlockIds: current.filter((id) => id !== blockId) });
    } else {
      set({ selectedBlockIds: [...current, blockId] });
    }
  },

  /**
   * 选中所有 reportable 且 privateRisk !== "high" 的工作片段
   */
  selectAllWorkBlocks: () => {
    const data = get().todayPageData;
    if (!data) return;
    const workBlockIds = data.timelineBlocks
      .filter((b) => b.reportable && b.privateRisk !== "high")
      .map((b) => b.id);
    set({ selectedBlockIds: workBlockIds });
  },

  clearSelection: () => set({ selectedBlockIds: [] }),

  setWorkReportStyle: (style) => set({ workReportStyle: style }),

  setWorkReportGenerationRequirement: (requirement) =>
    set({ workReportGenerationRequirement: requirement }),

  setPreviewModalOpen: (open) => set({ previewModalOpen: open }),

  setSidePanelDrawerOpen: (open) => set({ sidePanelDrawerOpen: open }),

  /**
   * 忽略时间轴片段（仅本地过滤，不持久化；重新加载时恢复）
   */
  ignoreTimelineBlock: (id) =>
    set((state) => ({
      ignoredBlockIds: state.ignoredBlockIds.includes(id)
        ? state.ignoredBlockIds
        : [...state.ignoredBlockIds, id],
    })),

  /**
   * 更新待收尾事项状态（乐观更新本地 todayPageData）
   */
});
