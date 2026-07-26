// src/renderer/state/slices/objects.ts
// 记忆对象：项目/人物/任务详情、合并、反馈、待收尾
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, TaskItem, PersonItem, ProjectDetail, FeedbackType, FeedbackTargetType } from "../types";
import type { UnfinishedThread } from "../../../shared/types";
import { getIpc } from "../ipc";

export interface ObjectsSlice {

  // M7 新增：项目详情
  projectDetail: ProjectDetail | null;
  projectDetailLoading: boolean;
  projectDetailError: string | null;

  /** 项目页筛选：关键词 / 状态 / 排序 */
  projectsFilters: {
    keyword: string;
    status: "active" | "candidate" | "archived";
    sortBy: "lastActiveAt" | "createdAt" | "name";
  };
  /** 人物页筛选：关键词 / 关联项目 / 排序 */
  peopleFilters: {
    keyword: string;
    projectId: string;
    status: "active" | "candidate" | "deleted";
    sortBy: "updatedAt" | "createdAt" | "name";
  };

  // 012/013 新增：合并建议（来自 Linker）
  mergeSuggestions: unknown[];
  mergeSuggestionsLoading: boolean;
  allAliases: {
    projects: Array<{ id: string; name: string; aliases: string[] }>;
    people: Array<{ id: string; name: string; aliases: string[] }>;
  } | null;

  // Phase 5 新增：待收尾页状态（doc 24）
  unfinishedThreads: UnfinishedThread[];
  unfinishedLoading: boolean;
  unfinishedError: string | null;
  loadProjectDetail: (id: string) => Promise<void>;
  clearProjectDetail: () => void;
  updateTask: (id: string, patch: Record<string, unknown>) => Promise<void>;
  updatePerson: (id: string, patch: Record<string, unknown>) => Promise<void>;
  deleteObject: (id: string, type: string) => Promise<void>;
  createUserFeedback: (input: {
    targetType: FeedbackTargetType;
    targetId: string;
    feedbackType: FeedbackType;
    note?: string;
    patch?: Record<string, unknown>;
  }) => Promise<void>;
  mergeObjects: (input: {
    objectType: "project" | "task" | "person" | "decision";
    fromId: string;
    toId: string;
    reason?: string;
  }) => Promise<{
    rewrittenFactsCount: number;
    rewrittenScenesCount: number;
    mergedAliases: string[];
  }>;
  loadMergeSuggestions: () => Promise<void>;
  rejectMergeSuggestion: (id: string) => Promise<void>;
  // 012/013 新增：别名映射
  loadAllAliases: () => Promise<void>;
  /** 设置项目页筛选（部分更新） */
  setProjectsFilters: (patch: Partial<{ keyword: string; status: "active" | "candidate" | "archived"; sortBy: "lastActiveAt" | "createdAt" | "name" }>) => void;
  /** 设置人物页筛选（部分更新） */
  setPeopleFilters: (patch: Partial<{ keyword: string; projectId: string; status: "active" | "candidate" | "deleted"; sortBy: "updatedAt" | "createdAt" | "name" }>) => void;
  updateUnfinishedThreadStatus: (
    id: string,
    status: "open" | "done" | "snoozed" | "ignored"
  ) => Promise<void>;

  // Phase 5 新增：待收尾页 actions
  loadUnfinishedThreads: () => Promise<void>;
  updateUnfinishedStatus: (
    id: string,
    status: "open" | "done" | "snoozed" | "ignored"
  ) => Promise<void>;
}

export const createObjectsSlice: AppSliceCreator<ObjectsSlice> = (set, get) => ({

  // M7 新增：项目详情
  projectDetail: null,
  projectDetailLoading: false,
  projectDetailError: null,

  projectsFilters: {
    keyword: "",
    status: "active",
    sortBy: "lastActiveAt",
  },
  peopleFilters: {
    keyword: "",
    projectId: "",
    status: "active",
    sortBy: "updatedAt",
  },

  // 012/013 新增：合并建议 + 别名映射
  mergeSuggestions: [],
  mergeSuggestionsLoading: false,
  allAliases: null,

  // Phase 5 新增：待收尾页初始状态
  unfinishedThreads: [],
  unfinishedLoading: false,
  unfinishedError: null,
  loadProjectDetail: async (id: string) => {
    set({ projectDetailLoading: true, projectDetailError: null, projectDetail: null });
    try {
      const detail = await getIpc().memory.getProjectDetail({ id });
      set({
        projectDetail: detail as ProjectDetail,
        projectDetailLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ projectDetailLoading: false, projectDetailError: message });
    }
  },

  /**
   * 清除当前查看的项目详情
   */
  clearProjectDetail: () => {
    set({ projectDetail: null, projectDetailError: null });
  },

  /**
   * 更新任务（调用 memory:updateTask IPC）
   * 重要约束：不覆盖 source ids（由 main 端 handler 控制）
   */
  updateTask: async (id: string, patch: Record<string, unknown>) => {
    try {
      await getIpc().memory.updateTask({ id, ...patch });
      // 乐观更新本地状态（todayData.tasks + projectDetail.tasks）
      const updateTaskInList = (task: TaskItem) =>
        task.id === id ? { ...task, ...patch } : task;
      const today = get().todayData;
      set({
        todayData: {
          ...today,
          tasks: today.tasks.map(updateTaskInList),
        },
      });
      const detail = get().projectDetail;
      if (detail) {
        set({
          projectDetail: {
            ...detail,
            tasks: detail.tasks.map(updateTaskInList),
          },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 更新人物（调用 memory:updatePerson IPC）
   * 重要约束：不覆盖 source ids（由 main 端 handler 控制）
   */
  updatePerson: async (id: string, patch: Record<string, unknown>) => {
    try {
      await getIpc().memory.updatePerson({ id, ...patch });
      // 乐观更新本地状态（todayData.people）
      const updatePersonInList = (person: PersonItem) =>
        person.id === id ? { ...person, ...patch } : person;
      const today = get().todayData;
      set({
        todayData: {
          ...today,
          people: today.people.map(updatePersonInList),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 删除对象（调用 memory:deleteObject IPC）
   * soft delete 优先（由 main 端 handler 实现）
   */
  deleteObject: async (id: string, type: string) => {
    try {
      await getIpc().memory.deleteObject({ id, type });
      // 乐观更新本地状态（从列表中移除）
      const today = get().todayData;
      const removeFromList = <T extends { id: string; deletedAt?: string | null }>(item: T) =>
        item.id === id ? { ...item, deletedAt: new Date().toISOString() } : item;
      if (type === "fact") {
        set({
          todayData: { ...today, facts: today.facts.map(removeFromList) },
        });
      } else if (type === "scene") {
        set({
          todayData: { ...today, scenes: today.scenes.map(removeFromList) },
        });
      } else if (type === "task") {
        set({
          todayData: { ...today, tasks: today.tasks.map(removeFromList) },
        });
      } else if (type === "decision") {
        set({
          todayData: { ...today, decisions: today.decisions.map(removeFromList) },
        });
      } else if (type === "person") {
        set({
          todayData: { ...today, people: today.people.map(removeFromList) },
        });
      } else if (type === "project") {
        // 项目使用 archive，从列表中过滤掉
        set({
          todayData: { ...today, projects: today.projects.filter((p) => p.id !== id) },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 用户纠错（调用 memory:createUserFeedback IPC）
   * - 保存 edit history
   * - 更新对应对象（不覆盖 source ids）
   * - 写入 user_feedback
   */
  createUserFeedback: async (input) => {
    try {
      await getIpc().memory.createUserFeedback(input);
      // 纠错后重新加载今日数据，确保 UI 同步
      // 不抛错，让调用方决定是否刷新
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  /**
   * 合并对象（调用 memory:mergeObjects IPC）
   * - 把 fromId 对象的 sourceFactIds 合并到 toId
   * - soft delete fromId
   * - 012 增强：返回改写统计（rewrittenFactsCount / rewrittenScenesCount / mergedAliases）
   * - 合并完成后立即刷新今日数据 + 合并建议列表
   */
  mergeObjects: async (input) => {
    try {
      const result = await getIpc().memory.mergeObjects(input);
      // 合并后重新加载今日数据
      await get().loadToday();
      // 重新加载合并建议（如该建议被确认）
      if (get().mergeSuggestions.length > 0) {
        void get().loadMergeSuggestions();
      }
      const merged = (result as { merged: {
        rewrittenFactsCount: number;
        rewrittenScenesCount: number;
        mergedAliases: string[];
      } }).merged;
      return {
        rewrittenFactsCount: merged.rewrittenFactsCount,
        rewrittenScenesCount: merged.rewrittenScenesCount,
        mergedAliases: merged.mergedAliases,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  // 012/013 新增：加载合并建议（Linker 输出的 mergeSuggestions）
  loadMergeSuggestions: async () => {
    set({ mergeSuggestionsLoading: true });
    try {
      const result = await getIpc().memory.listMergeSuggestions({ status: "new", limit: 200 });
      set({ mergeSuggestions: result.items, mergeSuggestionsLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message, mergeSuggestionsLoading: false });
    }
  },

  // 012/013 新增：拒绝某个合并建议
  rejectMergeSuggestion: async (id) => {
    try {
      await getIpc().memory.rejectMergeSuggestion({ id });
      // 重新加载列表
      await get().loadMergeSuggestions();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
      throw err;
    }
  },

  // 012/013 新增：加载所有已知别名映射（供 UI 提示 + LLM prompt 注入）
  loadAllAliases: async () => {
    try {
      const result = await getIpc().memory.listAllAliases();
      set({
        allAliases: {
          projects: result.projects,
          people: result.people,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ error: message });
    }
  },

  /**
   * 忘掉最近（调用 capture:forgetRecent IPC）
   * - 删除对应时间范围内截图缓存（硬删除）
   * - 删除对应 observation
   * - 删除或 soft delete 关联 facts/scenes（由 main 端实现）
   */

  setProjectsFilters: (patch) =>
    set((state) => ({ projectsFilters: { ...state.projectsFilters, ...patch } })),

  setPeopleFilters: (patch) =>
    set((state) => ({ peopleFilters: { ...state.peopleFilters, ...patch } })),
  updateUnfinishedThreadStatus: async (id, status) => {
    const prev = get().todayPageData;
    // 乐观更新
    if (prev) {
      set({
        todayPageData: {
          ...prev,
          unfinishedThreads: prev.unfinishedThreads.map((t) =>
            t.id === id ? { ...t, status } : t
          ),
        },
      });
    }
    try {
      const result = await getIpc().unfinishedThreads.updateStatus({ id, status });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      // 回滚
      set({ todayPageData: prev });
      const message = err instanceof Error ? err.message : String(err);
      set({ todayPageError: message });
    }
  },

  // ============================================================================
  // Phase 5 新增：待收尾页 actions（doc 24）
  // ============================================================================

  /**
   * 加载仍需处理的待收尾列表，仅拉取 open 状态。
   */
  loadUnfinishedThreads: async () => {
    if (get().unfinishedLoading) return;
    set({ unfinishedLoading: true, unfinishedError: null });
    try {
      const result = await getIpc().unfinishedThreads.list({ status: "open" });
      if (!result.ok) throw new Error(result.error);
      set({ unfinishedThreads: result.data as UnfinishedThread[], unfinishedLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ unfinishedError: message, unfinishedLoading: false });
    }
  },

  /**
   * 更新待收尾状态（乐观更新本地 unfinishedThreads）
   */
  updateUnfinishedStatus: async (id, status) => {
    const prev = get().unfinishedThreads;
    set({ unfinishedThreads: status === "open" ? prev.map((thread) => thread.id === id ? { ...thread, status } : thread) : prev.filter((thread) => thread.id !== id) });
    try {
      const result = await getIpc().unfinishedThreads.updateStatus({ id, status });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      // 回滚
      set({ unfinishedThreads: prev });
      const message = err instanceof Error ? err.message : String(err);
      set({ unfinishedError: message });
    }
  },
});
