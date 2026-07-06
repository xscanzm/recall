// src/renderer/components/ReminderCard.tsx
// 提醒卡片（来自 08 文档 "提醒页" 章节）
//
// 字段（来自 08 文档）：
// - 类型图标（ReminderTypeIcon）
// - 标题
// - 原因
// - 来源数量
// - 置信度标签
// - 操作按钮
//
// 操作按钮（来自 08 文档，6 个）：
// - 确认
// - 忽略
// - 稍后
// - 标记完成
// - 编辑
// - 不再提醒类似内容
//
// 提醒类型颜色（来自 08 文档 "提醒类型颜色" 章节）：
// - 待确认：amber (#D9912B)
// - 任务提醒：green (#2F8F83)
// - 风险：danger (#C74D3C)
// - 项目进展：neutral（border 灰色 #E2E0D8，文字 #66706D）
//
// 重要约束：
// - 不使用 emoji（使用中文字符标签作为类型图标）
// - 标记完成后任务状态更新（通过 onMarkComplete 回调）
// - 编辑内容写入 user_feedback（通过 onEdit 回调）

import { type ReactNode } from "react";
import {
  REMINDER_TYPE_LABELS,
  REMINDER_TYPE_COLORS,
  REMINDER_TYPE_ICONS,
  confidenceLabel,
} from "../app/naming";

export type ReminderType =
  | "task_reminder"
  | "unfinished_work"
  | "decision_review"
  | "project_update"
  | "daily_summary_candidate"
  | "tomorrow_suggestion"
  | "risk_warning"
  | "needs_confirmation";

export interface ReminderCardProps {
  /** 提醒 ID */
  id: string;
  /** 提醒类型 */
  type: ReminderType;
  /** 标题 */
  title: string;
  /** 原因（来自 Judge 输出的 reason 字段） */
  reason: string;
  /** 来源数量（sourceFactIds + sourceSceneIds 的总长度） */
  sourceCount: number;
  /** 置信度（0-1，使用 priority 字段） */
  confidence: number;
  /** 当前状态 */
  status?: string;
  /** 创建时间（ISO 字符串） */
  createdAt?: string;
  /** 是否需要用户确认 */
  requiresUserConfirmation?: boolean;
  /** 确认 */
  onConfirm?: (id: string) => void;
  /** 忽略 */
  onIgnore?: (id: string) => void;
  /** 稍后 */
  onSnooze?: (id: string) => void;
  /** 标记完成（标记完成后任务状态更新） */
  onMarkComplete?: (id: string) => void;
  /** 编辑（编辑内容写入 user_feedback） */
  onEdit?: (id: string) => void;
  /** 不再提醒类似内容 */
  onMuteSimilar?: (id: string) => void;
  /** 附加内容（用于展开详情等） */
  children?: ReactNode;
}

export function ReminderCard(props: ReminderCardProps) {
  const {
    id,
    type,
    title,
    reason,
    sourceCount,
    confidence,
    status,
    createdAt,
    requiresUserConfirmation,
    onConfirm,
    onIgnore,
    onSnooze,
    onMarkComplete,
    onEdit,
    onMuteSimilar,
    children,
  } = props;

  const accent = REMINDER_TYPE_COLORS[type] ?? "#66706D";
  const typeLabel = REMINDER_TYPE_LABELS[type] ?? "提醒";
  const typeIcon = REMINDER_TYPE_ICONS[type] ?? "提";

  // 已处理的提醒不显示操作按钮
  const isProcessed =
    status === "confirmed" ||
    status === "ignored" ||
    status === "done" ||
    status === "do_not_remind_again";

  return (
    <div className="reminder-card" style={{ borderLeftColor: accent }}>
      <div className="reminder-card__header">
        <div className="reminder-card__type-group">
          <span
            className="reminder-card__icon"
            style={{
              backgroundColor: accent,
              color: "#fff",
            }}
            aria-hidden="true"
          >
            {typeIcon}
          </span>
          <span className="reminder-card__type" style={{ color: accent }}>
            {typeLabel}
          </span>
        </div>
        <span className="reminder-card__confidence" style={{ color: accent }}>
          置信度：{confidenceLabel(confidence)}
        </span>
      </div>

      <h4 className="reminder-card__title">{title}</h4>
      <p className="reminder-card__reason">{reason}</p>

      <div className="reminder-card__meta">
        <span>来源 {sourceCount} 条</span>
        {requiresUserConfirmation && <span className="reminder-card__badge">需确认</span>}
        {status && status !== "new" && (
          <span className="reminder-card__badge">{statusLabel(status)}</span>
        )}
        {createdAt && <span>{formatDate(createdAt)}</span>}
      </div>

      {!isProcessed && (
        <div className="reminder-card__actions">
          <div className="reminder-card__actions-primary">
            {onConfirm && (
              <button className="primary" onClick={() => onConfirm(id)}>
                确认
              </button>
            )}
            {onMarkComplete && (
              <button onClick={() => onMarkComplete(id)}>
                完成
              </button>
            )}
            {onSnooze && (
              <button
                className="reminder-card__btn--snooze"
                onClick={() => onSnooze(id)}
              >
                稍后
              </button>
            )}
            {onIgnore && (
              <button onClick={() => onIgnore(id)}>
                忽略
              </button>
            )}
          </div>
          {(onEdit || onMuteSimilar) && (
            <div className="reminder-card__actions-secondary">
              {onEdit && (
                <button onClick={() => onEdit(id)}>
                  编辑
                </button>
              )}
              {onMuteSimilar && (
                <button
                  className="reminder-card__btn--mute"
                  onClick={() => onMuteSimilar(id)}
                >
                  不再提醒
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {children}

      <style>{`
        .reminder-card {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-left: 3px solid var(--accent-green);
          border-radius: var(--radius-card);
          padding: 16px;
          box-shadow: var(--shadow-sm);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .reminder-card__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
        }
        .reminder-card__type-group {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .reminder-card__icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          font-size: 11px;
          font-weight: 600;
          flex-shrink: 0;
        }
        .reminder-card__type {
          font-weight: 500;
        }
        .reminder-card__confidence {
          font-size: 11px;
        }
        .reminder-card__title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }
        .reminder-card__reason {
          margin: 0;
          color: var(--text-secondary);
          font-size: 13px;
          line-height: 1.6;
        }
        .reminder-card__meta {
          font-size: 12px;
          color: var(--text-secondary);
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        .reminder-card__badge {
          display: inline-flex;
          align-items: center;
          padding: 1px 8px;
          border-radius: var(--radius-pill);
          font-size: 11px;
          background-color: var(--bg);
          border: 1px solid var(--border);
          color: var(--text-secondary);
        }
        .reminder-card__actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 4px;
        }
        .reminder-card__actions-primary {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .reminder-card__actions-secondary {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-left: auto;
        }
        .reminder-card__actions button {
          font-size: 12px;
          padding: 4px 10px;
        }
        .reminder-card__btn--snooze {
          color: var(--accent-amber);
          border-color: var(--accent-amber);
          background-color: var(--surface);
        }
        .reminder-card__btn--snooze:hover {
          background-color: color-mix(in srgb, var(--accent-amber) 12%, var(--surface));
        }
        .reminder-card__btn--mute {
          color: var(--danger);
          border-color: var(--danger);
          background-color: var(--surface);
        }
        .reminder-card__btn--mute:hover {
          background-color: color-mix(in srgb, var(--danger) 12%, var(--surface));
        }
      `}</style>
    </div>
  );
}

/**
 * 状态标签（前台名称）
 */
function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    new: "待处理",
    confirmed: "已确认",
    ignored: "已忽略",
    snoozed: "稍后",
    done: "已完成",
    do_not_remind_again: "不再提醒",
  };
  return labels[status] ?? status;
}

/**
 * 格式化日期
 */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}
