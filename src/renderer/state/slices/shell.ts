// src/renderer/state/slices/shell.ts
// 应用外壳：运行状态、页面导航、跨页跳转、版本更新、确认对话框
//
// 由 store.ts 组合。slice 之间不直接互相 import：需要读别的域的状态时
// 用 get()（拿到的是完整 AppState），保持单向依赖 slice → types。

import type { AppSliceCreator, PageKey } from "../types";
import type { AppStatus } from "../../../shared/types";
import type { UpdateStatus, DownloadProgress } from "../../../shared/updateTypes";
import { getIpc } from "../ipc";

/** 默认 AppStatus（与 main 进程 createInitialAppStatus 保持一致） */
const DEFAULT_APP_STATUS: AppStatus = {
  observing: false,
  paused: false,
  pipelineState: "idle",
};

/** 默认更新状态 */
const DEFAULT_UPDATE_STATUS: UpdateStatus = { state: "idle" };

export interface ShellSlice {
  // 状态
  appStatus: AppStatus;
  currentPage: PageKey;
  isReady: boolean; // AppStatus 是否已通过 IPC 加载完成
  error: string | null;

  // 跨页面跳转：源记录 ID 和类型（用于搜索结果跳转到今日页等场景）
  pendingJumpId: string | null;
  pendingJumpType: string | null;

  // 版本更新
  updateStatus: UpdateStatus;
  currentVersion: string;

  // Phase 7 新增：设置页 / 信任中心 UI 状态
  /** 设置页当前激活的分区 tab（all | model | observation | screenshot | blacklist | notification | data） */
  settingsTab: string;
  /** 数据管理操作执行中（用于禁用按钮 + loading） */
  clearingData: boolean;
  /** 危险操作二次确认对话框是否显示 */
  showConfirmDialog: boolean;
  /** 确认对话框标题 */
  confirmDialogTitle: string;
  /** 确认对话框正文 */
  confirmDialogMessage: string;
  /** 确认对话框按钮文案（默认"确认"） */
  confirmDialogConfirmText: string;
  /** 用户确认后执行的回调 */
  confirmAction: (() => void) | null;

  // 动作
  setAppStatus: (status: AppStatus) => void;
  setPage: (page: PageKey) => void;
  setReady: (ready: boolean) => void;
  setError: (error: string | null) => void;

  // 跨页面跳转动作
  setPendingJump: (id: string, type: string) => void;
  clearPendingJump: () => void;

  // 版本更新
  loadUpdateStatus: () => Promise<void>;
  loadCurrentVersion: () => Promise<void>;
  checkForUpdate: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismissUpdateVersion: (version: string) => Promise<void>;
  setUpdateStatus: (status: UpdateStatus) => void;
  setDownloadProgress: (progress: DownloadProgress) => void;

  // Phase 7 新增：设置页 / 信任中心 UI actions
  /** 切换设置页激活分区 */
  setSettingsTab: (tab: string) => void;
  /** 标记数据管理操作执行中 / 完成 */
  setClearingData: (clearing: boolean) => void;
  /**
   * 发起危险操作二次确认。
   * 调用后弹出确认对话框，用户点击确认时执行 onConfirm，取消则关闭对话框。
   */
  requestConfirm: (input: {
    title: string;
    message: string;
    confirmText?: string;
    onConfirm: () => void;
  }) => void;
  /** 关闭确认对话框（取消） */
  closeConfirmDialog: () => void;
  /** 执行确认对话框的确认动作 */
  executeConfirm: () => void;
}

export const createShellSlice: AppSliceCreator<ShellSlice> = (set, get) => ({
  appStatus: DEFAULT_APP_STATUS,
  currentPage: "today",
  isReady: false,
  error: null,

  // 跨页面跳转初始状态
  pendingJumpId: null,
  pendingJumpType: null,

  // 版本更新
  updateStatus: DEFAULT_UPDATE_STATUS,
  currentVersion: "",

  // Phase 7 新增：设置页 / 信任中心 UI 初始状态
  settingsTab: "all",
  clearingData: false,
  showConfirmDialog: false,
  confirmDialogTitle: "",
  confirmDialogMessage: "",
  confirmDialogConfirmText: "确认",
  confirmAction: null,

  setAppStatus: (status) => set({ appStatus: status }),
  setPage: (page) => set({ currentPage: page }),
  setReady: (ready) => set({ isReady: ready }),
  setError: (error) => set({ error }),

  // 跨页面跳转动作：设置/清除待跳转的源记录 ID 和类型
  setPendingJump: (id, type) => set({ pendingJumpId: id, pendingJumpType: type }),
  clearPendingJump: () => set({ pendingJumpId: null, pendingJumpType: null }),

  /**
   * 加载今日记忆数据（调用 memory:listToday IPC）
   */
  loadUpdateStatus: async () => {
    try {
      const status = (await getIpc().update.getStatus()) as UpdateStatus;
      set({ updateStatus: status });
    } catch {
      // 静默失败
    }
  },

  /**
   * 加载当前应用版本号
   */
  loadCurrentVersion: async () => {
    try {
      const { version } = await getIpc().app.getVersion();
      set({ currentVersion: version });
    } catch {
      // 静默失败
    }
  },

  /**
   * 检查更新（手动触发）
   */
  checkForUpdate: async () => {
    try {
      await getIpc().update.check({ force: true });
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 下载更新
   */
  downloadUpdate: async () => {
    try {
      await getIpc().update.download();
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 安装并退出
   */
  installUpdate: async () => {
    const { updateStatus } = get();
    if (updateStatus.state !== "downloaded") return;
    try {
      await getIpc().update.installAndQuit({ installerPath: updateStatus.installerPath });
    } catch {
      // 错误状态由 onStatusChanged push
    }
  },

  /**
   * 忽略某版本
   */
  dismissUpdateVersion: async (version: string) => {
    try {
      await getIpc().update.dismissVersion({ version });
    } catch {
      // 静默失败
    }
  },

  /**
   * 设置更新状态（IPC push 回调）
   */
  setUpdateStatus: (status: UpdateStatus) => set({ updateStatus: status }),

  /**
   * 设置下载进度（IPC push 回调）
   */
  setDownloadProgress: (progress: DownloadProgress) => {
    set({ updateStatus: { state: "downloading", progress } });
  },

  /**
   * 数据导出（JSON，默认不含截图）
   */

  // ============================================================================
  // Phase 7 新增 actions（设置页 / 信任中心 UI）
  // ============================================================================

  setSettingsTab: (tab) => set({ settingsTab: tab }),

  setClearingData: (clearing) => set({ clearingData: clearing }),

  /**
   * 发起危险操作二次确认。
   * 弹出确认对话框，用户确认时执行 onConfirm，取消则关闭。
   * 调用方负责在 onConfirm 内部处理 loading / 错误提示。
   */
  requestConfirm: ({ title, message, confirmText, onConfirm }) =>
    set({
      showConfirmDialog: true,
      confirmDialogTitle: title,
      confirmDialogMessage: message,
      confirmDialogConfirmText: confirmText ?? "确认",
      confirmAction: onConfirm,
    }),

  /** 用户取消：关闭对话框并清空回调 */
  closeConfirmDialog: () =>
    set({
      showConfirmDialog: false,
      confirmDialogTitle: "",
      confirmDialogMessage: "",
      confirmDialogConfirmText: "确认",
      confirmAction: null,
    }),

  /**
   * 用户点击确认按钮：执行回调并关闭对话框。
   * 在回调内部抛错时由调用方自行处理；这里只负责关闭对话框。
   */
  executeConfirm: () => {
    const action = get().confirmAction;
    set({
      showConfirmDialog: false,
      confirmDialogTitle: "",
      confirmDialogMessage: "",
      confirmDialogConfirmText: "确认",
      confirmAction: null,
    });
    if (action) {
      action();
    }
  },
});
