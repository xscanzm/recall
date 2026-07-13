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

import type { TodayTimelineProjection } from "../../../shared/types";
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
  block: TodayTimelineProjection;
  detailMode: boolean;
  onOpenDetail: () => void;
}

export function TimelineCard({ block, detailMode, onOpenDetail }: TimelineCardProps) {
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
    detailMode ? "timeline-card--detail" : "timeline-card--segment",
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
        <h3 className="timeline-card__title"><button type="button" className="timeline-card__title-button" onClick={onOpenDetail}>{title}</button></h3>
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
            {(detailMode ? block.highlights : block.highlights.slice(0, 3)).map((h, i) => (
              <span key={`h${i}`} className="chip">
                {h}
              </span>
            ))}
          </div>
        )}

        {detailMode && (
          <div className="timeline-card__detail" aria-label={`${title} 的完整细节`}>
            <DetailItems title="接下来要做" items={block.generatedTasks} emptyText="没有整理出后续任务" />
            <DetailItems title="形成的决定" items={block.generatedDecisions} emptyText="没有识别到明确决定" />

            <div className="timeline-card__detail-section">
              <h4>整理把握</h4>
              <p>{confidenceLabel(block.confidence)}</p>
            </div>

            {block.privateRisk !== "low" && (
              <div className="timeline-card__detail-section timeline-card__detail-section--privacy">
                <h4>隐私提醒</h4>
                <p>{block.privateRiskReason?.trim() || defaultPrivacyReason(block.privateRisk)}</p>
              </div>
            )}

            <div className="timeline-card__detail-section timeline-card__provenance">
              <h4>内容依据</h4>
              <div className="timeline-card__provenance-counts">
                <span><strong>{block.sourceObservationIds.length}</strong> 个活动瞬间</span>
                <span><strong>{block.sourceFactIds.length}</strong> 条记忆线索</span>
                <span><strong>{block.sourceSceneIds.length}</strong> 个工作片段</span>
              </div>
            </div>
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
              sourceCount={
                block.sourceSceneIds.length +
                block.sourceFactIds.length +
                block.sourceObservationIds.length
              }
              sourceTime={timeRange ? formatTimeRange(block.startAt, block.endAt).split(" - ")[0] : undefined}
              onClick={onOpenDetail}
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

function DetailItems({ title, items, emptyText }: { title: string; items: string[]; emptyText: string }) {
  return (
    <div className="timeline-card__detail-section">
      <h4>{title}</h4>
      {items.length > 0 ? (
        <ul>
          {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
        </ul>
      ) : (
        <p className="timeline-card__detail-empty">{emptyText}</p>
      )}
    </div>
  );
}

function confidenceLabel(confidence?: number): string {
  if (confidence === undefined) return "依据有限，建议结合原始记录确认";
  if (confidence >= 0.85) return "把握较高，记录之间相互印证";
  if (confidence >= 0.65) return "有一定把握，关键内容建议再确认";
  return "把握有限，建议查看内容依据";
}

function defaultPrivacyReason(risk: TodayTimelineProjection["privateRisk"]): string {
  return risk === "high"
    ? "这段内容可能包含私人或敏感信息，使用前请确认。"
    : "这段内容可能涉及敏感信息，分享前请检查。";
}
