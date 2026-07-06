// src/renderer/components/TaskRow.tsx
// 任务行（来自 spec.md "任务页"章节）
//
// 显示字段（来自 spec.md）：
// - 标题
// - 项目
// - 最近证据（summary 或 sourceFactIds 第一条）
// - 状态（前台命名 + 颜色）
// - 优先级（高/中/低）
// - 更新时间
//
// 操作（来自 spec.md）：
// - 标记完成（done）
// - 改项目
// - 编辑标题
// - 删除（soft delete 优先）
// - 查看来源
// - 纠错（打开 CorrectionDialog）
//
// 重要约束：
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语

import { TASK_STATUS_LABELS } from "../app/naming";

export type TaskStatus =
  | "open"
  | "in_progress"
  | "likely_done"
  | "done"
  | "blocked"
  | "needs_confirmation"
  | "unknown";

export interface TaskRowProps {
  id: string;
  title: string;
  status: TaskStatus;
  projectName?: string;
  summary?: string | null;
  priority?: number;
  sourceFactIds?: string[];
  updatedAt: string;
  /** 12.7：L3 反向影响 - 仅由被删 facts 支撑的对象被标记为 orphan */
  orphanStatus?: string | null;
  onComplete?: (id: string) => void;
  onChangeProject?: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
  onViewSource?: (id: string) => void;
  onCorrect?: (id: string) => void;
}

/**
 * 状态颜色映射（来自 08 文档"提醒类型颜色"和品牌色系）
 * - 进行中：green
 * - 已完成：green
 * - 可能已完成：amber
 * - 待确认：amber
 * - 阻塞：danger
 * - 未完成：neutral
 */
const STATUS_COLORS: Record<TaskStatus, string> = {
  open: "#66706d",
  in_progress: "#2f8f83",
  likely_done: "#d9912b",
  done: "#2f8f83",
  blocked: "#c74d3c",
  needs_confirmation: "#d9912b",
  unknown: "#66706d",
};

/**
 * 优先级标签（高/中/低）
 */
function priorityLabel(p: number): string {
  if (p >= 0.7) return "高";
  if (p >= 0.4) return "中";
  return "低";
}

/**
 * 优先级颜色
 */
function priorityColor(p: number): string {
  if (p >= 0.7) return "#c74d3c"; // 高 -> danger
  if (p >= 0.4) return "#d9912b"; // 中 -> amber
  return "#66706d"; // 低 -> neutral
}

export function TaskRow(props: TaskRowProps) {
  const statusColor = STATUS_COLORS[props.status] ?? STATUS_COLORS.unknown;
  const statusLabel = TASK_STATUS_LABELS[props.status] ?? "未知";
  const recentEvidence = props.summary || (props.sourceFactIds && props.sourceFactIds.length > 0 ? `来自 ${props.sourceFactIds.length} 条线索` : null);

  return (
    <div className="task-row" data-status={props.status}>
      <div className="task-row__main">
        <div className="task-row__title">{props.title}</div>
        <div className="task-row__meta">
          {props.projectName && (
            <span className="task-row__project">{props.projectName}</span>
          )}
          <span
            className="task-row__status"
            style={{ color: statusColor }}
          >
            {statusLabel}
          </span>
          {props.priority !== undefined && (
            <span
              className="task-row__priority"
              style={{ color: priorityColor(props.priority) }}
            >
              优先级：{priorityLabel(props.priority)}
            </span>
          )}
          {(props.orphanStatus === "source_deleted" ||
            props.orphanStatus === "needs_review") && (
            <span className="task-row__orphan-chip" title="该任务的来源已被删除，需复核">
              来源失效
            </span>
          )}
          <span className="task-row__time">
            更新于 {new Date(props.updatedAt).toLocaleString("zh-CN")}
          </span>
        </div>
        {recentEvidence && (
          <div className="task-row__evidence">
            <span className="task-row__evidence-label">最近证据：</span>
            <span className="task-row__evidence-text">{recentEvidence}</span>
          </div>
        )}
      </div>
      <div className="task-row__actions">
        {props.onComplete && props.status !== "done" && (
          <button
            type="button"
            onClick={() => props.onComplete?.(props.id)}
            title="标记完成"
          >
            完成
          </button>
        )}
        {props.onEdit && (
          <button
            type="button"
            onClick={() => props.onEdit?.(props.id)}
            title="编辑标题"
          >
            编辑
          </button>
        )}
        {props.onChangeProject && (
          <button
            type="button"
            onClick={() => props.onChangeProject?.(props.id)}
            title="改项目"
          >
            改项目
          </button>
        )}
        {props.onViewSource && (
          <button
            type="button"
            onClick={() => props.onViewSource?.(props.id)}
            title="查看来源"
          >
            来源
          </button>
        )}
        {props.onCorrect && (
          <button
            type="button"
            onClick={() => props.onCorrect?.(props.id)}
            title="纠错"
          >
            纠错
          </button>
        )}
        {props.onDelete && (
          <button
            type="button"
            className="task-row__delete-btn"
            onClick={() => props.onDelete?.(props.id)}
            title="删除"
          >
            删除
          </button>
        )}
      </div>

      <style>{`
        .task-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
          gap: 12px;
        }
        .task-row:hover {
          background-color: #f0eee7;
        }
        .task-row[data-status="done"] .task-row__title {
          color: var(--text-secondary);
          text-decoration: line-through;
        }
        .task-row__main {
          flex: 1;
          min-width: 0;
        }
        .task-row__title {
          font-weight: 500;
          color: var(--text-primary);
          margin-bottom: 4px;
          font-size: 13px;
          line-height: 1.5;
        }
        .task-row__meta {
          display: flex;
          gap: 12px;
          font-size: 12px;
          color: var(--text-secondary);
          flex-wrap: wrap;
          align-items: center;
        }
        .task-row__project {
          background-color: #eef3f1;
          color: var(--accent-green);
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          font-size: 11px;
        }
        .task-row__status {
          font-weight: 500;
        }
        .task-row__priority {
          font-size: 11px;
        }
        .task-row__orphan-chip {
          padding: 2px 8px;
          background-color: rgba(217, 145, 43, 0.12);
          border: 1px solid #d9912b;
          border-radius: var(--radius-pill);
          font-size: 11px;
          color: #d9912b;
          font-weight: 500;
        }
        .task-row__time {
          font-size: 11px;
          opacity: 0.7;
        }
        .task-row__evidence {
          margin-top: 6px;
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.6;
        }
        .task-row__evidence-label {
          font-weight: 500;
          color: var(--text-secondary);
        }
        .task-row__evidence-text {
          color: var(--text-primary);
          opacity: 0.85;
        }
        .task-row__actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
          flex-wrap: wrap;
          max-width: 280px;
          justify-content: flex-end;
        }
        .task-row__actions button {
          font-size: 11px;
          padding: 4px 8px;
          border: 1px solid var(--border);
          background-color: var(--surface);
        }
        .task-row__actions button:hover {
          background-color: #f0eee7;
        }
        .task-row__delete-btn {
          color: var(--danger) !important;
          border-color: var(--danger) !important;
        }
        .task-row__delete-btn:hover {
          background-color: #fbeeeb !important;
        }
      `}</style>
    </div>
  );
}
