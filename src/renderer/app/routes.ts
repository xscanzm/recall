// src/renderer/app/routes.ts
// 应用路由配置
//
// 集中管理页面路由元数据，避免分散在 App.tsx 和 AppShell.tsx
// M0 仅包含静态路由；M9 之后可扩展参数化路由

export interface RouteMeta {
  key: string;
  label: string;
  description: string;
}

/**
 * 全部页面路由（与 store.ts 的 PageKey 保持一致）
 */
export const ROUTES: RouteMeta[] = [
  { key: "today", label: "今日", description: "今日概览、当前工作主线、应用内提醒" },
  { key: "reminders", label: "提醒", description: "应用内提醒列表，按类型分组" },
  { key: "tasks", label: "任务", description: "任务按状态分组：进行中、未完成、已完成等" },
  { key: "projects", label: "项目", description: "项目卡片与详情" },
  { key: "reports", label: "报告", description: "日报、历史日报、周报" },
  { key: "memory", label: "记忆库", description: "搜索线索、工作片段、任务、项目、决策、报告" },
  { key: "people", label: "人物", description: "人物列表与详情" },
  { key: "settings", label: "设置", description: "模型配置、观察设置、截图保留、通知、黑名单" },
  { key: "trust", label: "信任中心", description: "Recall 看到什么、保存什么、如何删除" },
];

/**
 * 根据路由 key 查找元数据
 */
export function findRoute(key: string): RouteMeta | undefined {
  return ROUTES.find((r) => r.key === key);
}
