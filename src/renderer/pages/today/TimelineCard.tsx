// src/renderer/pages/today/TimelineCard.tsx
// 时间轴卡片（spec 行 1417-1553）
//
// 结构：
// - 时间列（92px）+ 主体内容（1fr）
// - 选择模式下左侧显示 checkbox
// - 时间列：HH:MM - HH:MM
// - 标题：务实（break 类别用 短暂休息 / 离开电脑 / 暂无明显活动）
// - 摘要：1-2 句
// - 标签：项目（青绿）/ 类型（灰）/ 风险待确认（琥珀）
// - 关键产出 chips
// - 底部操作：查看来源 / 加入日报 / 忽略

import type { TimelineBlock } from "../../../shared/types";
import { Tag } from "../../components/Tag";
import { SourceLink } from "../../components/SourceLink";
import { useAppStore } from "../../state/store";
import {
  formatTimeRange,
  resolveBlockTitle,
  resolveBlockSummary,
  categoryLabel,
} from "./helpers";

interface TimelineCardProps {
  block: TimelineBlock;
  detailMode: boolean;
}

export function TimelineCard({ block, detailMode }: TimelineCardProps) {
  const selectionMode = useAppStore((s) => s.workReportSelectionMode);
  const selectedBlockIds = useAppStore((s) => s.selectedBlockIds);
  const toggleBlockSelection = useAppStore((s) => s.toggleBlockSelection);
  const enterSelectionWithBlock = useAppStore((s) => s.enterSelectionWithBlock);
  const ignoreTimelineBlock = useAppStore((s) => s.ignoreTimelineBlock);

  const isSelected = selectedBlockIds.includes(block.id);
  const isPrivateHigh = block.privateRisk === "high";
  // 选择模式下，高风险片段默认不可选
  const unselectable = selectionMode && isPrivateHigh;

  const title = resolveBlockTitle(block);
  const summary = resolveBlockSummary(block);
  const timeRange = formatTimeRange(block.startAt, block.endAt);

  const handleToggle = () => {
    if (unselectable) return;
    toggleBlockSelection(block.id);
  };

  const cardClassName = [
    "timeline-card",
    selectionMode && isSelected ? "is-selected" : "",
    unselectable ? "is-unselectable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cardClassName} id={`block-${block.id}`}>
      {/* 选择模式 checkbox */}
      {selectionMode && (
        <div className="timeline-card__check">
          <input
            type="checkbox"
            checked={isSelected}
            disabled={unselectable}
            onChange={handleToggle}
            aria-label={`选择 ${title} 进入工作日报`}
          />
        </div>
      )}

      {/* 时间列 + 节点 */}
      <div className="timeline-card__time-col">
        <span className="timeline-card__dot" aria-hidden="true" />
        <span className="timeline-card__time">{timeRange}</span>
      </div>

      {/* 主体内容 */}
      <div className="timeline-card__body">
        <h3 className="timeline-card__title">{title}</h3>
        {summary && <p className="timeline-card__summary">{summary}</p>}

        {/* 标签行 */}
        {(block.projectNames.length > 0 || detailMode) && (
          <div className="timeline-card__tags">
            {block.projectNames.slice(0, 3).map((p, i) => (
              <Tag key={`p${i}`} type="project">
                {p}
              </Tag>
            ))}
            {detailMode && <Tag type="category">{categoryLabel(block.category)}</Tag>}
            {block.privateRisk !== "low" && (
              <Tag type="warning">
                {isPrivateHigh ? "风险待确认" : "注意敏感内容"}
              </Tag>
            )}
            {block.reportable && detailMode && (
              <Tag type="reportable">可入日报</Tag>
            )}
          </div>
        )}

        {/* 关键产出 chips */}
        {block.highlights && block.highlights.length > 0 && (
          <div className="timeline-card__chips">
            {block.highlights.slice(0, detailMode ? 6 : 3).map((h, i) => (
              <span key={`h${i}`} className="chip">
                {h}
              </span>
            ))}
          </div>
        )}

        {/* 选择模式下高风险提示 */}
        {unselectable && (
          <p className="timeline-card__private-note">
            含私人/敏感内容，默认不用于日报
          </p>
        )}

        {/* 底部操作（非选择模式） */}
        {!selectionMode && (
          <div className="timeline-card__actions">
            <SourceLink
              sourceCount={block.sourceObservationIds.length}
              sourceTime={timeRange ? formatTimeRange(block.startAt, block.endAt).split(" - ")[0] : undefined}
              onClick={() => {
                /* MVP: 暂未实现来源详情面板 */
              }}
            />
            <button
              type="button"
              className="timeline-card__action"
              onClick={() => enterSelectionWithBlock(block.id)}
            >
              加入日报
            </button>
            <button
              type="button"
              className="timeline-card__action timeline-card__action--ghost"
              onClick={() => ignoreTimelineBlock(block.id)}
            >
              忽略
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
