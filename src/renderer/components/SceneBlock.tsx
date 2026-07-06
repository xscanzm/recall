// src/renderer/components/SceneBlock.tsx
// 工作片段卡片（前台命名：Scene -> 工作片段，来自 08 文档）
//
// 显示：标题、摘要、时间范围、关联事实数、关联实体
// M5+ 之后由 TodayPage 使用，M0 仅占位导出

export interface SceneBlockProps {
  title: string;
  summary: string;
  startAt: string;
  endAt: string;
  projectName?: string;
  factCount: number;
  entityNames: string[];
  confidence: number;
  onClick?: () => void;
}

export function SceneBlock(props: SceneBlockProps) {
  const start = new Date(props.startAt);
  const end = new Date(props.endAt);
  const fmt = (d: Date) =>
    `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;

  return (
    <div className="scene-block" onClick={props.onClick} role={props.onClick ? "button" : undefined}>
      <div className="scene-block__header">
        <span className="scene-block__time">{fmt(start)} - {fmt(end)}</span>
        {props.projectName && (
          <span className="scene-block__project">{props.projectName}</span>
        )}
      </div>
      <h4 className="scene-block__title">{props.title}</h4>
      <p className="scene-block__summary">{props.summary}</p>
      <div className="scene-block__meta">
        <span>{props.factCount} 条线索</span>
        {props.entityNames.length > 0 && (
          <span>涉及：{props.entityNames.slice(0, 3).join("、")}{props.entityNames.length > 3 ? " 等" : ""}</span>
        )}
      </div>
      <style>{`
        .scene-block {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 14px 16px;
          cursor: ${props.onClick ? "pointer" : "default"};
          transition: border-color 0.15s ease;
        }
        .scene-block:hover {
          border-color: var(--accent-green);
        }
        .scene-block__header {
          display: flex;
          gap: 12px;
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 6px;
        }
        .scene-block__project {
          color: var(--accent-green);
        }
        .scene-block__title {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 6px;
        }
        .scene-block__summary {
          margin: 0 0 8px 0;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .scene-block__meta {
          display: flex;
          gap: 12px;
          font-size: 12px;
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
