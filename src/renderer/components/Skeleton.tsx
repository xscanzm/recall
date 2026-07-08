export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string;
  className?: string;
}

export const Skeleton = ({ width = "100%", height = 16, borderRadius, className = "" }: SkeletonProps) => {
  const style: React.CSSProperties = {
    width,
    height,
    borderRadius: borderRadius || undefined,
  };
  return <div className={`skeleton ${className}`.trim()} style={style} />;
};

/** 时间轴卡片 skeleton（4 张用于加载状态） */
export const TimelineCardSkeleton = () => (
  <div className="timeline-card-skeleton" style={{ padding: 16, border: "1px solid var(--recall-border)", borderRadius: "var(--radius-md)", background: "var(--recall-surface)" }}>
    <div style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 16 }}>
      <Skeleton width={60} height={12} />
      <div>
        <Skeleton width="60%" height={16} />
        <div style={{ height: 8 }} />
        <Skeleton width="90%" height={14} />
        <div style={{ height: 4 }} />
        <Skeleton width="80%" height={14} />
      </div>
    </div>
  </div>
);

export const TimelineSkeletonList = ({ count = 4 }: { count?: number }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
    {Array.from({ length: count }).map((_, i) => <TimelineCardSkeleton key={i} />)}
  </div>
);
