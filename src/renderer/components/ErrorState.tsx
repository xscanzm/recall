import { type ReactNode } from "react";
import { Button } from "./Button";

export interface ErrorStateProps {
  title: string;
  description?: string;
  /** 主操作（如"重试"） */
  primaryAction?: { label: string; onClick: () => void };
  /** 次操作（如"去设置"、"返回选择"） */
  secondaryAction?: { label: string; onClick: () => void };
  icon?: ReactNode;
  className?: string;
}

export const ErrorState = ({
  title,
  description,
  primaryAction,
  secondaryAction,
  icon,
  className = "",
}: ErrorStateProps) => {
  return (
    <div className={`error-state ${className}`.trim()}>
      {icon && <div className="error-state__icon">{icon}</div>}
      <h3 className="error-state__title">{title}</h3>
      {description && <p className="error-state__desc">{description}</p>}
      {(primaryAction || secondaryAction) && (
        <div className="error-state__actions">
          {primaryAction && (
            <Button variant="primary" onClick={primaryAction.onClick}>
              {primaryAction.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/** 模型错误预设 */
export const ModelErrorState = ({ onRetry, onGoSettings }: { onRetry?: () => void; onGoSettings?: () => void }) => (
  <ErrorState
    title="模型连接失败"
    description="请检查 endpoint、model 和 API Key。"
    primaryAction={onRetry ? { label: "重试", onClick: onRetry } : undefined}
    secondaryAction={onGoSettings ? { label: "去设置", onClick: onGoSettings } : undefined}
  />
);
