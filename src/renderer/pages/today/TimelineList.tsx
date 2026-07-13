// src/renderer/pages/today/TimelineList.tsx
// 时间轴列表（spec 行 1417-1488）
//
// - 容器带 1px 竖线（::before 伪元素，颜色 #D6D3CA）
// - 加载状态：4 张 skeleton 卡片
// - 空状态：今天还没有时间轴片段
// - 正常：TimelineCard 列表

import type { TimelineBlock } from "../../../shared/types";
import { TimelineCard } from "./TimelineCard";
import type { TimelineViewMode } from "./TimelineToolbar";

interface TimelineListProps {
  blocks: TimelineBlock[];
  loading: boolean;
  organizing?: boolean;
  viewMode: TimelineViewMode;
  onOpenDetail: (block: TimelineBlock) => void;
}

export function TimelineList({ blocks, loading, organizing = false, viewMode, onOpenDetail }: TimelineListProps) {
  if (loading) {
    return <TimelineSkeleton />;
  }

  if (blocks.length === 0) {
    if (organizing) {
      return (
        <div className="timeline-list timeline-list--empty">
          <div className="timeline-empty">
            <p className="timeline-empty__title">正在整理这一天的时间轴。</p>
            <p className="timeline-empty__sub">
              Recall 正在把记录整理成片段，稍等一下就会出现在这里。
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="timeline-list timeline-list--empty">
        <div className="timeline-empty">
          <p className="timeline-empty__title">这一天还没有时间轴片段。</p>
          <p className="timeline-empty__sub">
            继续工作一会儿，Recall 会把你的电脑工作整理成时间轴。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-list">
      {blocks.map((block) => (
        <TimelineCard
          key={block.id}
          block={block}
          detailMode={viewMode === "detail"}
          onOpenDetail={() => onOpenDetail(block)}
        />
      ))}
    </div>
  );
}

/** 4 张 skeleton 卡片（spec 行 1704） */
function TimelineSkeleton() {
  return (
    <div className="timeline-list">
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="timeline-card timeline-card--skeleton" key={i} aria-hidden="true">
          <div className="timeline-card__time-col">
            <span className="timeline-card__dot" />
            <span className="skeleton" style={{ width: 56, height: 12 }} />
          </div>
          <div className="timeline-card__body">
            <div className="skeleton" style={{ width: "60%", height: 16 }} />
            <div style={{ height: 8 }} />
            <div className="skeleton" style={{ width: "92%", height: 14 }} />
            <div style={{ height: 6 }} />
            <div className="skeleton" style={{ width: "78%", height: 14 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
