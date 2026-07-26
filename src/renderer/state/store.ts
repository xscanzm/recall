// src/renderer/state/store.ts
// 全局状态管理（Zustand）——只负责把各域 slice 组合成一个 store。
//
// 状态和动作的实现都在 slices/ 下按域分文件；领域类型在 types.ts。
// 这里刻意保持极薄：新增一个域就加一个 slice 文件和一行展开。
//
// 对外 API 没有变化：仍然是 useAppStore((s) => s.someAction)，
// 类型和大部分领域类型也继续从本模块 re-export，页面无需改 import。

import { create } from "zustand";
import type { AppState } from "./types";
import { createShellSlice } from "./slices/shell";
import { createTodaySlice } from "./slices/today";
import { createRemindersSlice } from "./slices/reminders";
import { createSearchSlice } from "./slices/search";
import { createObjectsSlice } from "./slices/objects";
import { createSettingsSlice } from "./slices/settings";
import { createReportsSlice } from "./slices/reports";
import { createDebugSlice } from "./slices/debug";

export const useAppStore = create<AppState>((...args) => ({
  ...createShellSlice(...args),
  ...createTodaySlice(...args),
  ...createRemindersSlice(...args),
  ...createSearchSlice(...args),
  ...createObjectsSlice(...args),
  ...createSettingsSlice(...args),
  ...createReportsSlice(...args),
  ...createDebugSlice(...args),
}));

// 领域类型继续从这里导出，保持既有 import 路径可用。
export type * from "./types";
