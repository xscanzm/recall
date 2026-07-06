// src/renderer/components/EmptyState.tsx
// 空状态与错误状态组件（来自 08 文档"空状态与错误状态文案"章节）
//
// 完整文案（必须 1:1 实现来自 08 文档）：
//
// 空状态：
//   "回声还没有开始观察。
//    配置模型并开启后，它会把今天的工作上下文整理成任务、进展和日报。"
//
// 暂停状态：
//   "已暂停。暂停期间不会采集窗口，也不会调用模型。"
//
// 无报告：
//   "今天还没有足够记忆生成日报。
//    继续工作一会儿，或手动添加一条记录。"
//
// 模型错误：
//   "模型连接失败。请检查 endpoint、model 和 API Key。"
//
// 敏感内容跳过：
//   "这段内容看起来比较敏感，Recall 没有采集它。"
//
// 黑名单跳过：
//   "当前应用在黑名单中，Recall 正在安静跳过。"

import { type ReactNode } from "react";

/**
 * 完整文案常量（来自 08 文档，1:1 实现）
 */
export const EMPTY_STATE_MESSAGES = {
  freshStart: "回声还没有开始观察。",
  freshStartHint: "配置模型并开启后，它会把今天的工作上下文整理成任务、进展和日报。",

  paused: "已暂停。暂停期间不会采集窗口，也不会调用模型。",

  noReport: "今天还没有足够记忆生成日报。",
  noReportHint: "继续工作一会儿，或手动添加一条记录。",

  modelError: "模型连接失败。请检查 endpoint、model 和 API Key。",

  sensitiveSkipped: "这段内容看起来比较敏感，Recall 没有采集它。",

  blacklistedSkipped: "当前应用在黑名单中，Recall 正在安静跳过。",
} as const;

/**
 * 空状态类型
 */
export type EmptyStateVariant =
  | "freshStart"
  | "paused"
  | "noReport"
  | "modelError"
  | "sensitiveSkipped"
  | "blacklistedSkipped";

interface EmptyStateProps {
  variant: EmptyStateVariant;
  /** 可选的附加操作按钮区域 */
  actions?: ReactNode;
  /** 可选的附加说明（不替换标准文案，仅作为补充） */
  hint?: ReactNode;
}

const VARIANT_TITLE: Record<EmptyStateVariant, string> = {
  freshStart: "回声 Recall",
  paused: "已暂停",
  noReport: "暂无日报",
  modelError: "模型连接失败",
  sensitiveSkipped: "已跳过敏感内容",
  blacklistedSkipped: "黑名单跳过",
};

/**
 * 渲染空状态/错误状态的完整文案
 *
 * 文案严格来自 08 文档，1:1 实现，不修改。
 */
export function EmptyState({ variant, actions, hint }: EmptyStateProps) {
  const title = VARIANT_TITLE[variant];
  const messages = getMessages(variant);

  return (
    <div className={`empty-state-block empty-state-block--${variant}`}>
      <h3 className="empty-state-block__title">{title}</h3>
      {messages.map((msg, idx) => (
        <p key={idx} className={idx === 0 ? "empty-state-block__main" : "empty-state-block__sub"}>
          {msg}
        </p>
      ))}
      {hint && <div className="empty-state-block__hint">{hint}</div>}
      {actions && <div className="empty-state-block__actions">{actions}</div>}
      <style>{`
        .empty-state-block {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 32px 28px;
          text-align: center;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
        }
        .empty-state-block--modelError,
        .empty-state-block--sensitiveSkipped,
        .empty-state-block--blacklistedSkipped {
          border-color: var(--border);
        }
        .empty-state-block--modelError .empty-state-block__title {
          color: var(--danger);
        }
        .empty-state-block--sensitiveSkipped .empty-state-block__title,
        .empty-state-block--paused .empty-state-block__title {
          color: var(--accent-amber);
        }
        .empty-state-block--blacklistedSkipped .empty-state-block__title {
          color: var(--text-secondary);
        }
        .empty-state-block__title {
          font-size: 15px;
          font-weight: 600;
          margin: 0;
        }
        .empty-state-block__main {
          margin: 0;
          font-size: 14px;
          color: var(--text-primary);
          line-height: 1.6;
          max-width: 480px;
        }
        .empty-state-block__sub {
          margin: 0;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.6;
          max-width: 480px;
        }
        .empty-state-block__hint {
          font-size: 12px;
          color: var(--text-secondary);
          opacity: 0.8;
          margin-top: 4px;
        }
        .empty-state-block__actions {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          flex-wrap: wrap;
          justify-content: center;
        }
      `}</style>
    </div>
  );
}

/**
 * 根据变体返回完整文案数组
 * 文案来自 08 文档，1:1 实现
 */
function getMessages(variant: EmptyStateVariant): string[] {
  switch (variant) {
    case "freshStart":
      return [EMPTY_STATE_MESSAGES.freshStart, EMPTY_STATE_MESSAGES.freshStartHint];
    case "paused":
      return [EMPTY_STATE_MESSAGES.paused];
    case "noReport":
      return [EMPTY_STATE_MESSAGES.noReport, EMPTY_STATE_MESSAGES.noReportHint];
    case "modelError":
      return [EMPTY_STATE_MESSAGES.modelError];
    case "sensitiveSkipped":
      return [EMPTY_STATE_MESSAGES.sensitiveSkipped];
    case "blacklistedSkipped":
      return [EMPTY_STATE_MESSAGES.blacklistedSkipped];
  }
}
