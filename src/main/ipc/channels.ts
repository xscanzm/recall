// src/main/ipc/channels.ts
// IPC 白名单（来自 06_TECHNICAL_ARCHITECTURE.md）
//
// 重要约束：
// - handler 必须校验参数（zod）
// - 不开放任意 SQL、任意文件路径读取、任意 shell
// - API Key 不通过 IPC 传递到 renderer
// - 截图文件真实路径不通过 IPC 暴露给 renderer
//
// M8 新增 channel：
// - model:listConfigs / model:saveConfig / model:deleteConfig：模型配置 CRUD
//   （API Key 通过 model:saveConfig 传入 main，存入 SecretService，不返回 renderer）
// - data:export：JSON 导出全部结构化记忆（不含截图）
// - data:clearAll：清空所有结构化记忆数据（保留 settings / model_configs / privacy_rules）
// - data:getCacheSize：查询截图缓存当前大小

/**
 * 全部 IPC channel 类型
 */
export type IpcChannel =
  | "app:getStatus"
  | "app:startObserving"
  | "app:pauseObserving"
  | "app:getLaunchAtLogin"
  | "app:setLaunchAtLogin"
  | "window:minimize"
  | "window:toggleMaximize"
  | "window:close"
  | "settings:get"
  | "settings:update"
  | "endOfDayReview:get"
  | "endOfDayReview:viewToday"
  | "endOfDayReview:snooze"
  | "endOfDayReview:dismiss"
  | "endOfDayReview:expired"
  | "model:testConnection"
  // M8 新增：模型配置 CRUD
  | "model:listConfigs"
  | "model:saveConfig"
  | "model:deleteConfig"
  | "privacy:listRules"
  | "privacy:addRule"
  | "privacy:updateRule"
  | "privacy:deleteRule"
  | "memory:listToday"
  | "memory:search"
  | "memory:expandSearch"
  | "memory:getDetail"
  | "memory:getSourcePreview"
  | "memory:openSourceUrl"
  | "memory:updateFact"
  | "memory:updateTask"
  | "memory:updatePerson"
  | "memory:deleteObject"
  | "memory:ask"
  | "memory:createUserFeedback"
  | "memory:getProjectDetail"
  | "memory:getPersonDetail"
  | "memory:mergeObjects"
  // 012/013 新增：合并建议
  | "memory:listMergeSuggestions"
  | "memory:rejectMergeSuggestion"
  | "memory:listAllAliases"
  | "memory:listPeople"
  | "memory:listProjects"
  | "reminders:list"
  | "reminders:updateStatus"
  | "reports:list"
  | "reports:get"
  | "reports:getImage"
  | "reports:notification:get"
  | "reports:notification:dismiss"
  | "reports:notification:open"
  | "reports:getEvidenceByIds"
  | "reports:generate"
  | "reports:update"
  | "reports:delete"
  | "capture:forgetRecent"
  | "screenshot:clear"
  // M8 新增：数据导出/清空 + 缓存大小查询
  | "data:export"
  | "data:clearAll"
  | "data:getCacheSize"
  // Phase 2 新增：时间轴 / 个人复盘 / 工作日报 / 待收尾
  | "timeline:build"
  | "timeline:reorganizeDay"
  | "timeline:get"
  | "activity:getDayOverview"
  | "personalReview:generate"
  | "personalReview:get"
  | "workReport:generate"
  | "workReport:get"
  | "workReport:saveSelection"
  | "unfinishedThreads:list"
  | "unfinishedThreads:updateStatus"
  | "debug:listJobs"
  | "debug:getJobDetails"
  | "debug:getRelatedRecords"
  // 版本更新
  | "app:getVersion"
  | "update:check"
  | "update:download"
  | "update:installAndQuit"
  | "update:getStatus"
  | "update:dismissVersion";

/**
 * 主进程主动推送到 renderer 的 channel（不是 invoke 通道，是 send 通道）
 */
export type IpcPushChannel =
  | "app:statusChanged" // AppStatus 变化时推送
  | "pipeline:progress" // pipeline 进度（M4 使用）
  | "update:progress" // 下载进度推送
  | "update:statusChanged" // 更新状态变化推送
  | "reports:imageReady" // 信息图保存完成
  | "reports:generated"; // 正式报告正文成功落库

/**
 * 全部 invoke channel 列表（用于白名单校验）
 */
export const ALL_INVOKE_CHANNELS: readonly IpcChannel[] = [
  "app:getStatus",
  "app:startObserving",
  "app:pauseObserving",
  "app:getLaunchAtLogin",
  "app:setLaunchAtLogin",
  "window:minimize",
  "window:toggleMaximize",
  "window:close",
  "settings:get",
  "settings:update",
  "endOfDayReview:get",
  "endOfDayReview:viewToday",
  "endOfDayReview:snooze",
  "endOfDayReview:dismiss",
  "endOfDayReview:expired",
  "model:testConnection",
  "model:listConfigs",
  "model:saveConfig",
  "model:deleteConfig",
  "privacy:listRules",
  "privacy:addRule",
  "privacy:updateRule",
  "privacy:deleteRule",
  "memory:listToday",
  "memory:search",
  "memory:expandSearch",
  "memory:getDetail",
  "memory:getSourcePreview",
  "memory:openSourceUrl",
  "memory:updateFact",
  "memory:updateTask",
  "memory:updatePerson",
  "memory:deleteObject",
  "memory:ask",
  "memory:createUserFeedback",
  "memory:getProjectDetail",
  "memory:getPersonDetail",
  "memory:mergeObjects",
  // 012/013 新增
  "memory:listMergeSuggestions",
  "memory:rejectMergeSuggestion",
  "memory:listAllAliases",
  "memory:listPeople",
  "memory:listProjects",
  "reminders:list",
  "reminders:updateStatus",
  "reports:list",
  "reports:get",
  "reports:getImage",
  "reports:notification:get",
  "reports:notification:dismiss",
  "reports:notification:open",
  "reports:getEvidenceByIds",
  "reports:generate",
  "reports:update",
  "reports:delete",
  "capture:forgetRecent",
  "screenshot:clear",
  "data:export",
  "data:clearAll",
  "data:getCacheSize",
  // Phase 2 新增
  "timeline:build",
  "timeline:reorganizeDay",
  "timeline:get",
  "activity:getDayOverview",
  "personalReview:generate",
  "personalReview:get",
  "workReport:generate",
  "workReport:get",
  "workReport:saveSelection",
  "unfinishedThreads:list",
  "unfinishedThreads:updateStatus",
  "debug:listJobs",
  "debug:getJobDetails",
  "debug:getRelatedRecords",
  // 版本更新
  "app:getVersion",
  "update:check",
  "update:download",
  "update:installAndQuit",
  "update:getStatus",
  "update:dismissVersion",
] as const;

/**
 * 校验给定字符串是否为合法 invoke channel
 */
export function isInvokeChannel(value: string): value is IpcChannel {
  return (ALL_INVOKE_CHANNELS as readonly string[]).includes(value);
}

/**
 * 推送 channel 列表
 */
export const ALL_PUSH_CHANNELS: readonly IpcPushChannel[] = [
  "app:statusChanged",
  "pipeline:progress",
  "update:progress",
  "update:statusChanged",
  "reports:imageReady",
  "reports:generated",
] as const;

export function isPushChannel(value: string): value is IpcPushChannel {
  return (ALL_PUSH_CHANNELS as readonly string[]).includes(value);
}
