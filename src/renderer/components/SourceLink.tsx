export interface SourceLinkProps {
  /** 来源片段数量，undefined 时只显示"查看来源" */
  sourceCount?: number;
  /** 来源时间 HH:MM，undefined 时不显示时间 */
  sourceTime?: string;
  onClick?: () => void;
  className?: string;
}

export const SourceLink = ({ sourceCount, sourceTime, onClick, className = "" }: SourceLinkProps) => {
  const text = sourceCount && sourceCount > 0
    ? sourceTime
      ? `来自今天 ${sourceTime} 的记录`
      : `来自 ${sourceCount} 个片段`
    : "查看来源";
  return (
    <button
      type="button"
      className={`source-link ${className}`.trim()}
      onClick={onClick}
    >
      {text}
    </button>
  );
};
