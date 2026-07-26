// src/renderer/state/slices/reminders.ts
// 提醒列表
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, ReminderItem } from "../types";
import type { IpcRequest } from "../../../shared/ipcContracts";
import { getIpc } from "../ipc";

export interface RemindersSlice {

  // 提醒数据
  reminders: ReminderItem[];
  remindersLoading: boolean;
  remindersError: string | null;
  remindersLoadedAt: number | null;
  loadReminders: () => Promise<void>;
  /** status 收窄成契约里的枚举，写错的字面量在编译期就会被拦住。 */
  updateReminderStatus: (
    id: string,
    status: IpcRequest<"reminders:updateStatus">["status"],
  ) => Promise<void>;
}

export const createRemindersSlice: AppSliceCreator<RemindersSlice> = (set, get) => ({

  reminders: [],
  remindersLoading: false,
  remindersError: null,
  remindersLoadedAt: null,
  loadReminders: async () => {
    if (get().remindersLoading) return;
    set({ remindersLoading: true, remindersError: null });
    try {
      const list = await getIpc().reminders.list();
      set({
        reminders: list ?? [],
        remindersLoading: false,
        remindersLoadedAt: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ remindersLoading: false, remindersError: message });
    }
  },

  /**
   * 更新提醒状态（调用 reminders:updateStatus IPC）
   * 标记完成后任务状态更新
   * 乐观更新：先更新本地状态，失败时回滚到快照
   */
  updateReminderStatus: async (id, status) => {
    const prev = get().reminders; // 保存快照，用于失败时回滚
    try {
      // 乐观更新本地列表（先于 IPC 调用）
      set({
        reminders: prev.map((r) => (r.id === id ? { ...r, status } : r)),
      });
      await getIpc().reminders.updateStatus({ id, status });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 回滚到更新前的快照
      set({ reminders: prev, remindersError: message });
      throw err;
    }
  },

  // ============================================================================
  // M7 新增动作
  // ============================================================================

  /**
   * 搜索记忆（调用 memory:search IPC）
   * 来自 spec.md "记忆库搜索"：
   * - 搜索结果类型：Fact/Scene/Task/Project/Decision/Report
   * - 每条结果显示：类型/标题摘要/时间/项目/来源跳转
   */
});
