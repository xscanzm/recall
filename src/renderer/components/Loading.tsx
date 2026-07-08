import { TimelineSkeletonList } from "./Skeleton";

export interface LoadingProps {
  variant?: "skeleton" | "inline";
  className?: string;
  children?: React.ReactNode;
}

export const Loading = ({ variant = "skeleton", className = "", children }: LoadingProps) => {
  if (variant === "inline") {
    return <div className={`loading-inline ${className}`.trim()}>{children || "加载中..."}</div>;
  }
  return <TimelineSkeletonList />;
};
