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
  { key: "today", label: "今日", description: "当天片段流与我的复盘" },
  { key: "tasks", label: "待收尾", description: "需要继续、确认、跟进或可能遗忘的事项" },
  { key: "projects", label: "项目", description: "项目记忆、最近片段、关键记忆与待收尾" },
  { key: "people", label: "人物", description: "人物上下文、最近互动、相关项目与提到过的事" },
  { key: "memory", label: "记忆库", description: "搜索片段、记忆原子、长期对象和报告" },
  { key: "reports", label: "报告", description: "日报、周报、月报等对外表达" },
  { key: "settings", label: "设置", description: "模型配置、观察设置、截图保留、通知、黑名单" },
  { key: "reminders", label: "提醒", description: "旧提醒页，后续并入待收尾" },
  { key: "trust", label: "信任中心", description: "旧信任中心，后续并入设置" },
  { key: "debug", label: "调试", description: "开发者调试：模型调用记录、丢弃事件、落库对比" },
];

/**
 * 根据路由 key 查找元数据
 */
export function findRoute(key: string): RouteMeta | undefined {
  return ROUTES.find((r) => r.key === key);
}
