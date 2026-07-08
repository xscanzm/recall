export interface PrivacyStateProps {
  description?: string;
  className?: string;
}

export const PrivacyState = ({ description = "当前内容可能比较敏感，Recall 已跳过。", className = "" }: PrivacyStateProps) => {
  return (
    <div className={`privacy-state ${className}`.trim()}>
      <p className="privacy-state__desc">{description}</p>
    </div>
  );
};
