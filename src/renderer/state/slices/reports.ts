// src/renderer/state/slices/reports.ts
// 报告页：复盘/日报/周报/月报/历史
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, ReportItem, ReportsTabKey } from "../types";
import type { PersonalReview, WorkReport, ReportGeneratedEvent } from "../../../shared/types";
import { getIpc } from "../ipc";
import { dailyReportRecordToWorkReport } from "../reportAdapters";
import { currentMonthKey, currentWeekStart, todayDateKey } from "../defaults";

const UNREAD_REPORTS_STORAGE_KEY = "recall.unread-reports.v1";

function readStoredUnreadReports(): ReportGeneratedEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(UNREAD_REPORTS_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReportGeneratedEvent => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      return (
        typeof value.reportId === "string" &&
        typeof value.type === "string" &&
        typeof value.title === "string" &&
        typeof value.dateKey === "string"
      );
    }).slice(0, 50);
  } catch {
    return [];
  }
}

function persistUnreadReports(reports: ReportGeneratedEvent[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UNREAD_REPORTS_STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // localStorage 不可用时不影响报告生成和页面展示。
  }
}

/**
 * 报告页 Tab key（Phase 4，doc 23）
 */

export interface ReportsSlice {

  // Phase 4 新增：报告页状态（doc 23）
  /** 报告页当前 Tab：我的复盘 / 工作日报 / 周报 / 月报 / 历史 */
  reportsTab: ReportsTabKey;
  /** 报告页当前选中的日期 key（YYYY-MM-DD） */
  reportsDateKey: string;
  /**
   * 报告页 dateKey 是否被用户主动设置（prev/next/date-input）
   * - true：跨日回滚不会覆盖（保留用户选择的历史日期）
   * - false：跨日回滚可以触发（自动滚动到今天）
   * - load 成功且 current === today 时 reset 为 false（让"打开应用后跨日回滚能工作"）
   */
  reportsDateKeySetByUser: boolean;
  /** 报告页周报 Tab 选中的周起始 dateKey（YYYY-MM-DD，周一） */
  reportsWeekStart: string;
  /** 报告页月报 Tab 选中的月份 key（YYYY-MM） */
  reportsMonthKey: string;
  /** 当前查看的个人复盘（与 todayPageData.personalReview 区分，专供报告页使用） */
  personalReview: PersonalReview | null;
  /** 当前查看的工作日报（与 todayPageData.workReport 区分，专供报告页使用） */
  workReport: WorkReport | null;
  /** 正式报告生成后尚未进入报告页查看的报告。 */
  unreadReports: ReportGeneratedEvent[];
  /** 历史 Tab 的报告列表 */
  reportsList: ReportItem[];
  /** 报告页加载状态 */
  reportsLoading: boolean;
  /** 报告页错误信息 */
  reportsError: string | null;
  /** 报告编辑器是否处于编辑模式 */
  reportEditing: boolean;
  /** 报告编辑器草稿内容（plain text） */
  reportDraft: string;
  /** 历史报告列表过滤：类型（"all" | "daily" | "weekly" | "monthly" | "retrospective"） */
  reportsHistoryTypeFilter: string;
  /** 历史报告列表过滤：起始 dateKey */
  reportsHistoryDateFrom: string;
  /** 历史报告列表过滤：结束 dateKey */
  reportsHistoryDateTo: string;
  /** 历史报告列表过滤：项目 ID（"all" 或具体 projectId） */
  reportsHistoryProjectFilter: string;

  // Phase 4 新增：报告页 actions（doc 23）
  /** 切换报告页 Tab */
  setReportsTab: (tab: ReportsTabKey) => void;
  /** 设置报告页当前日期 */
  setReportsDateKey: (dateKey: string) => void;
  /**
   * 跨日检测：reportsDateKey 跨过零点时自动滚动到今天并重新加载当前 Tab 数据
   * - 仅当 reportsDateKeySetByUser = false 时才回滚（避免覆盖用户主动选择的历史日期）
   */
  rollOverReportsDateKeyIfNeeded: () => boolean;
  /**
   * 标记 dateKey 已被用户主动设置（prev/next/date-input）
   */
  markReportsDateKeySetByUser: () => void;
  /**
   * 清除 user-changed 标记
   * - load 成功后 + current === today 时调用（让跨日回滚能正常工作）
   */
  resetReportsDateKeyUserFlag: () => void;
  /**
   * "默认显示最近一份有的复盘"：
   * - 如果当前 dateKey 没有复盘/日报，自动切到 ≤ today 的最近一份
   * - 如果用户主动改过 dateKey，不强制回退
   */
  fallbackToLatestReportIfMissing: () => Promise<void>;
  /** 设置报告页周起始 */
  setReportsWeekStart: (dateKey: string) => void;
  /** 设置报告页月份 key */
  setReportsMonthKey: (monthKey: string) => void;
  /** 收到新的正式报告事件，更新右上角未读提醒。 */
  addUnreadReport: (report: ReportGeneratedEvent) => void;
  /** 用户进入报告页或点击提醒后清除未读报告。 */
  markUnreadReportsRead: () => void;
  /** 加载指定日期的个人复盘（专供报告页使用，写入 state.personalReview） */
  loadPersonalReview: (dateKey: string) => Promise<void>;
  /** 加载指定日期的工作日报（专供报告页使用，写入 state.workReport） */
  loadWorkReport: (dateKey: string) => Promise<void>;
  /** 加载历史报告列表（支持类型/日期范围过滤） */
  loadReportsList: (filters?: {
    type?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
  }) => Promise<void>;
  /** 更新报告内容（编辑后保存，content 为 plain text，内部包装为 contentJson） */
  updateReport: (id: string, content: string) => Promise<void>;
  /** 物理删除报告（调用 reports:delete IPC） */
  deleteReport: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /** 进入/退出报告编辑模式 */
  setReportEditing: (editing: boolean) => void;
  /** 设置报告编辑草稿 */
  setReportDraft: (draft: string) => void;
  /** 设置历史报告过滤：类型 */
  setReportsHistoryTypeFilter: (type: string) => void;
  /** 设置历史报告过滤：起始日期 */
  setReportsHistoryDateFrom: (dateKey: string) => void;
  /** 设置历史报告过滤：结束日期 */
  setReportsHistoryDateTo: (dateKey: string) => void;
  /** 设置历史报告过滤：项目 */
  setReportsHistoryProjectFilter: (projectId: string) => void;
}

export const createReportsSlice: AppSliceCreator<ReportsSlice> = (set, get) => ({

  // Phase 4 新增：报告页初始状态（doc 23）
  reportsTab: "personal",
  reportsDateKey: todayDateKey(),
  reportsDateKeySetByUser: false,
  reportsWeekStart: currentWeekStart(),
  reportsMonthKey: currentMonthKey(),
  personalReview: null,
  workReport: null,
  unreadReports: readStoredUnreadReports(),
  reportsList: [],
  reportsLoading: false,
  reportsError: null,
  reportEditing: false,
  reportDraft: "",
  reportsHistoryTypeFilter: "all",
  reportsHistoryDateFrom: "",
  reportsHistoryDateTo: "",
  reportsHistoryProjectFilter: "all",

  // ============================================================================
  // Phase 4 新增 actions（报告页，doc 23）
  // ============================================================================

  setReportsTab: (tab) => set({ reportsTab: tab }),

  setReportsDateKey: (dateKey) => set({ reportsDateKey: dateKey, reportsDateKeySetByUser: true }),

  /**
   * 跨日检测：reportsDateKey 跨过零点时自动滚动到今天 + 重新加载当前 Tab
   * **重要**：仅当用户没有主动改过日期时才回滚（防止"点前一天看历史"被错误回滚）
   * - user-changed flag 在 setReportsDateKey 时被设为 true
   * - 任何 reloadPersonalReview/loadWorkReport 成功后会 reset flag
   *   （这样明天重新打开时跨日回滚能正常工作）
   *
   * 调用方：ReportsPage 挂载时 / window focus / 30 分钟定时
   * 调用方**不**应在 dateKey 变化的 effect 里调用本方法（会形成循环）
   */
  rollOverReportsDateKeyIfNeeded: () => {
    // 用户主动改过日期 → 不回滚（保留用户的选择）
    if (get().reportsDateKeySetByUser) return false;
    const current = get().reportsDateKey;
    const today = todayDateKey();
    // 只有当 current 严格小于 today 时（说明跨过了一天）才滚动
    if (current && current < today) {
      set({ reportsDateKey: today, reportsDateKeySetByUser: false });
      // 重新加载当前 Tab（与 ReportsPage useEffect 触发逻辑一致）
      const tab = get().reportsTab;
      if (tab === "personal") {
        void get().loadPersonalReview(today);
      } else if (tab === "work") {
        void get().loadWorkReport(today);
      }
      return true;
    }
    return false;
  },

  /**
   * 标记 dateKey 已被用户主动设置（用于 rollOver 跳过逻辑）
   * - ReportsPage 在 prev/next/date-input onChange 时显式调用
   * - 加载成功后 resetReportsDateKeyUserFlag() 会清除标记
   */
  markReportsDateKeySetByUser: () => set({ reportsDateKeySetByUser: true }),

  /**
   * 清除 user-changed 标记
   * - load 成功且 current === today 时调用（让"用户刚切回今天"也允许后续跨日回滚）
   * - 切换 tab 时不调用（保留用户对该 tab 的日期选择）
   */
  resetReportsDateKeyUserFlag: () => set({ reportsDateKeySetByUser: false }),

  /**
   * "默认显示最近一份有的复盘"：
   * - 如果当前 dateKey 没有复盘，自动切到 ≤ today 的最近一份
   * - 工作日报 Tab 同理
   * - 调用方：ReportsPage 加载完成后
   * - 如果是用户主动切的 dateKey（user-changed=true），不强制回退
   */
  fallbackToLatestReportIfMissing: async () => {
    const state = get();
    const today = todayDateKey();
    const currentDateKey = state.reportsDateKey;
    const tab = state.reportsTab;
    // 仅当 currentDateKey ≥ today 时才回退（用户主动看过去的不动）
    if (currentDateKey < today) return;
    // 仅当 user 没改过时自动回退
    if (state.reportsDateKeySetByUser) return;

    if (tab === "personal") {
      if (state.personalReview) return; // 当前已有，不动
      const list = await getIpc().reports.list<{ dateKey: string }>({
        type: "personal_daily_review",
        dateTo: today,
        limit: 1,
      });
      if (list.length > 0 && list[0]?.dateKey && list[0].dateKey !== currentDateKey) {
        set({ reportsDateKey: list[0].dateKey });
        await get().loadPersonalReview(list[0].dateKey);
      }
    } else if (tab === "work") {
      if (state.workReport) return;
      const [manualReports, dailyReports] = await Promise.all([
        getIpc().reports.list<{ dateKey: string; updatedAt?: string }>({
          type: "work_daily_report",
          dateTo: today,
          limit: 1,
        }),
        getIpc().reports.list<{ dateKey: string; updatedAt?: string }>({
          type: "daily",
          dateTo: today,
          limit: 1,
        }),
      ]);
      const latest = [...manualReports, ...dailyReports]
        .filter((report) => report.dateKey)
        .sort((left, right) => {
          const dateOrder = right.dateKey.localeCompare(left.dateKey);
          if (dateOrder !== 0) return dateOrder;
          return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
        })[0];
      if (latest?.dateKey && latest.dateKey !== currentDateKey) {
        set({ reportsDateKey: latest.dateKey });
        await get().loadWorkReport(latest.dateKey);
      }
    }
  },

  setReportsWeekStart: (dateKey) => set({ reportsWeekStart: dateKey }),

  setReportsMonthKey: (monthKey) => set({ reportsMonthKey: monthKey }),

  addUnreadReport: (report) => {
    const next = [
      report,
      ...get().unreadReports.filter((item) => item.reportId !== report.reportId),
    ].slice(0, 50);
    persistUnreadReports(next);
    set({ unreadReports: next });
  },

  markUnreadReportsRead: () => {
    persistUnreadReports([]);
    set({ unreadReports: [] });
  },

  /**
   * 加载指定日期的个人复盘（调用 personalReview:get IPC，写入 state.personalReview）
   * 与 todayPageData.personalReview 区分：本字段专供报告页"我的复盘"Tab 使用。
   */
  loadPersonalReview: async (dateKey) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const res = await getIpc().personalReview.get(dateKey);
      if (res.ok) {
        const data = res.data as PersonalReview | null | undefined;
        // 加载成功 + 当前是今天 → 清除 user-changed 标记（让跨日回滚能工作）
        // 注：切到历史日期时不重置（保留"用户在看历史"意图）
        if (dateKey >= todayDateKey()) {
          set({ reportsDateKeySetByUser: false });
        }
        set({
          personalReview: data ?? null,
          reportsLoading: false,
        });
      } else {
        set({
          personalReview: null,
          reportsLoading: false,
          reportsError: res.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 加载指定日期的工作日报（调用 workReport:get IPC，写入 state.workReport）
   * 与 todayPageData.workReport 区分：本字段专供报告页"工作日报"Tab 使用。
   */
  loadWorkReport: async (dateKey) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const res = await getIpc().workReport.get(dateKey);
      if (res.ok) {
        let data = res.data as WorkReport | null | undefined;
        // 定时自动日报使用 type=daily；工作日报 Tab 在没有人工选片段报告时兼容展示它。
        if (!data) {
          const dailyReports = await getIpc().reports.list<ReportItem>({
            type: "daily",
            dateFrom: dateKey,
            dateTo: dateKey,
            limit: 1,
          });
          data = dailyReportRecordToWorkReport(dailyReports[0]);
        }
        if (dateKey >= todayDateKey()) {
          set({ reportsDateKeySetByUser: false });
        }
        set({
          workReport: data ?? null,
          reportsLoading: false,
        });
      } else {
        set({
          workReport: null,
          reportsLoading: false,
          reportsError: res.error,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 加载历史报告列表（调用 reports:list IPC）
   * 支持 type/dateFrom/dateTo/limit 过滤。
   */
  loadReportsList: async (filters) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const input: Record<string, unknown> = {};
      if (filters?.type && filters.type !== "all") input.type = filters.type;
      if (filters?.dateFrom) input.dateFrom = filters.dateFrom;
      if (filters?.dateTo) input.dateTo = filters.dateTo;
      if (filters?.limit) input.limit = filters.limit;
      const list = await getIpc().reports.list<ReportItem>(input);
      set({
        reportsList: list ?? [],
        reportsLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 更新报告内容（编辑后保存）
   * content 为 plain text，内部包装为 {plainText, edited:true} 的 contentJson 后调用 reports:update。
   * 保存后同步更新本地 personalReview / workReport / reportsList。
   */
  updateReport: async (id, content) => {
    set({ reportsLoading: true, reportsError: null });
    try {
      const contentJson = JSON.stringify({ plainText: content, edited: true });
      await getIpc().reports.update({ id, contentJson });
      const now = new Date().toISOString();
      // 同步更新本地 personalReview
      const pr = get().personalReview;
      if (pr && pr.id === id) {
        set({ personalReview: { ...pr, updatedAt: now } });
      }
      // 同步更新本地 workReport（plainText 字段直接替换）
      const wr = get().workReport;
      if (wr && wr.id === id) {
        set({ workReport: { ...wr, plainText: content, updatedAt: now } });
      }
      // 同步更新 reportsList 中的对应项
      const list = get().reportsList;
      if (list.some((r) => r.id === id)) {
        set({
          reportsList: list.map((r) =>
            r.id === id ? { ...r, contentJson, updatedAt: now } : r
          ),
        });
      }
      set({ reportsLoading: false, reportEditing: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsLoading: false, reportsError: message });
    }
  },

  /**
   * 物理删除报告（调用 reports:delete IPC）
   * 删除后同步从 reportsList 中移除该项。
   */
  deleteReport: async (id) => {
    try {
      const deleted = await getIpc().reports.delete({ id });
      if (deleted) {
        // 同步从本地列表中移除
        const list = get().reportsList;
        if (list.some((r) => r.id === id)) {
          set({ reportsList: list.filter((r) => r.id !== id) });
        }
      }
      return { ok: deleted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ reportsError: message });
      return { ok: false, error: message };
    }
  },

  setReportEditing: (editing) => set({ reportEditing: editing }),

  setReportDraft: (draft) => set({ reportDraft: draft }),

  setReportsHistoryTypeFilter: (type) => set({ reportsHistoryTypeFilter: type }),

  setReportsHistoryDateFrom: (dateKey) => set({ reportsHistoryDateFrom: dateKey }),

  setReportsHistoryDateTo: (dateKey) => set({ reportsHistoryDateTo: dateKey }),

  setReportsHistoryProjectFilter: (projectId) =>
    set({ reportsHistoryProjectFilter: projectId }),
});
