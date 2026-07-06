// src/renderer/components/StatusPill.tsx
// 顶部状态栏的 StatusPill（来自 08 文档 "App Shell 布局" 章节）
//
// 必须显示以下状态（来自 08 文档）：
// - 观察中
// - 已暂停
// - 黑名单跳过（当前应用在黑名单中，Recall 正在安静跳过）
// - 敏感内容跳过（这段内容看起来比较敏感，Recall 没有采集它）
// - 模型错误（模型连接失败）
// - 正在整理（pipeline 处理中：capturing/observing/extracting/linking/judging/reporting）
//
// 还显示当前活动 app 简略信息（通过 detail 字段）

import { useAppStore } from "../state/store";
import type { AppStatus } from "../../shared/types";

type PillVariant =
  | "idle"
  | "observing"
  | "paused"
  | "blocked"
  | "sensitive"
  | "error"
  | "processing";

interface PillConfig {
  variant: PillVariant;
  label: string;
  detail?: string;
}

/**
 * 根据 AppStatus 派生 StatusPill 配置
 *
 * 优先级（来自高到低）：
 * 1. error：模型错误（lastError 或 pipelineState=error）
 * 2. paused：已暂停
 * 3. blocked：黑名单跳过（currentWindow.privacyState=blocked）
 * 4. sensitive：敏感内容跳过（currentWindow.privacyState=sensitive）
 * 5. processing：正在整理（pipelineState != idle 且 observing）
 * 6. observing：观察中
 * 7. idle：未开始观察
 */
function derivePillConfig(appStatus: AppStatus): PillConfig {
  const { observing, paused, currentWindow, pipelineState, lastError } = appStatus;

  if (lastError || pipelineState === "error") {
    return {
      variant: "error",
      label: "模型错误",
      detail: lastError ?? "发生未知错误",
    };
  }

  if (paused) {
    return { variant: "paused", label: "已暂停" };
  }

  if (currentWindow?.privacyState === "blocked") {
    return {
      variant: "blocked",
      label: "黑名单跳过",
      detail: currentWindow.appName,
    };
  }

  if (currentWindow?.privacyState === "sensitive") {
    return {
      variant: "sensitive",
      label: "敏感内容跳过",
      detail: currentWindow.appName,
    };
  }

  if (pipelineState !== "idle" && observing) {
    const stateLabels: Record<string, string> = {
      capturing: "采集中",
      observing: "观察中",
      extracting: "正在整理",
      linking: "正在关联",
      judging: "正在判断",
      reporting: "生成报告中",
    };
    return {
      variant: "processing",
      label: stateLabels[pipelineState] ?? "正在处理",
    };
  }

  if (observing) {
    return {
      variant: "observing",
      label: "观察中",
      detail: currentWindow?.appName,
    };
  }

  return { variant: "idle", label: "未开始观察" };
}

/**
 * 各变体的颜色配置（来自 08 文档品牌色）
 * - observing/processing：accent green
 * - paused/sensitive：accent amber
 * - blocked/error：danger
 * - idle：neutral
 */
const VARIANT_COLORS: Record<PillVariant, { bg: string; fg: string; dot: string }> = {
  idle: { bg: "#f0eee7", fg: "#66706d", dot: "#9aa3a1" },
  observing: { bg: "#eef3f1", fg: "#2f8f83", dot: "#2f8f83" },
  paused: { bg: "#fdf3e3", fg: "#d9912b", dot: "#d9912b" },
  blocked: { bg: "#fbeeeb", fg: "#c74d3c", dot: "#c74d3c" },
  sensitive: { bg: "#fdf3e3", fg: "#d9912b", dot: "#d9912b" },
  error: { bg: "#fbeeeb", fg: "#c74d3c", dot: "#c74d3c" },
  processing: { bg: "#eef3f1", fg: "#2f8f83", dot: "#2f8f83" },
};

export function StatusPill() {
  const appStatus = useAppStore((s) => s.appStatus);
  const config = derivePillConfig(appStatus);
  const colors = VARIANT_COLORS[config.variant];

  return (
    <div
      className="status-pill"
      style={{
        backgroundColor: colors.bg,
        color: colors.fg,
      }}
      role="status"
      aria-live="polite"
    >
      <span
        className="status-pill__dot"
        style={{ backgroundColor: colors.dot }}
      />
      <span className="status-pill__label">{config.label}</span>
      {config.detail ? (
        <span className="status-pill__detail">{config.detail}</span>
      ) : null}
    </div>
  );
}
