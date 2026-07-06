// src/renderer/components/LoadingSpinner.tsx
// 加载状态组件（来自 08 文档"加载状态"要求）
//
// 职责：
// - 在异步操作时显示加载指示器（spinner 或骨架屏）
// - 替代裸文字"正在加载..."
// - 支持三种尺寸：sm / md / lg
// - 支持可选的提示文案
//
// 设计要点：
// - 使用品牌色（accent green）作为 spinner 主色
// - 动画使用 CSS keyframes，prefers-reduced-motion 时禁用
// - 不使用 emoji

interface LoadingSpinnerProps {
  /** 尺寸（默认 md） */
  size?: "sm" | "md" | "lg";
  /** 可选的提示文案（显示在 spinner 下方） */
  label?: string;
  /** 是否使用块级布局（占满容器，居中），默认 true */
  block?: boolean;
}

/**
 * 加载指示器
 *
 * 用法：
 *   <LoadingSpinner />
 *   <LoadingSpinner size="lg" label="正在整理今日记忆..." />
 *   <LoadingSpinner size="sm" block={false} />
 */
export function LoadingSpinner({ size = "md", label, block = true }: LoadingSpinnerProps) {
  const sizeClass = `loading-spinner--${size}`;
  const wrapperClass = block
    ? "loading-spinner-wrapper loading-spinner-wrapper--block"
    : "loading-spinner-wrapper";

  return (
    <div className={wrapperClass}>
      <span className={`loading-spinner ${sizeClass}`} role="status" aria-live="polite" />
      {label && <span className="loading-spinner__label">{label}</span>}
      <style>{`
        .loading-spinner-wrapper {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: var(--text-secondary);
          font-size: 13px;
        }
        .loading-spinner-wrapper--block {
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          padding: 24px;
          gap: 12px;
        }
        .loading-spinner {
          display: inline-block;
          border-radius: 50%;
          border: 2px solid var(--border);
          border-top-color: var(--accent-green);
          animation: loading-spinner-rotate 0.8s linear infinite;
          flex-shrink: 0;
        }
        .loading-spinner--sm {
          width: 12px;
          height: 12px;
          border-width: 1.5px;
        }
        .loading-spinner--md {
          width: 20px;
          height: 20px;
          border-width: 2px;
        }
        .loading-spinner--lg {
          width: 32px;
          height: 32px;
          border-width: 3px;
        }
        .loading-spinner__label {
          font-size: 13px;
          color: var(--text-secondary);
        }
        @keyframes loading-spinner-rotate {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .loading-spinner {
            animation-duration: 2.5s;
          }
        }
      `}</style>
    </div>
  );
}

/**
 * 骨架屏占位
 *
 * 用于列表加载时显示占位行
 *
 * 用法：
 *   <SkeletonRow />
 *   <SkeletonRow width={400} />
 */
interface SkeletonRowProps {
  /** 宽度（像素），默认 100% */
  width?: number | string;
  /** 高度（像素），默认 14 */
  height?: number;
}

export function SkeletonRow({ width = "100%", height = 14 }: SkeletonRowProps) {
  return (
    <div
      className="skeleton-row"
      style={{ width: typeof width === "number" ? `${width}px` : width, height: `${height}px` }}
      aria-hidden="true"
    >
      <style>{`
        .skeleton-row {
          background: linear-gradient(
            90deg,
            var(--border) 0%,
            #f0eee7 50%,
            var(--border) 100%
          );
          background-size: 200% 100%;
          animation: skeleton-shimmer 1.4s ease-in-out infinite;
          border-radius: 4px;
          margin-bottom: 8px;
        }
        @keyframes skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .skeleton-row {
            animation: none;
            background: var(--border);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * 骨架屏列表（用于今日页等列表加载）
 *
 * 用法：
 *   {todayLoading && <SkeletonList rows={4} />}
 */
interface SkeletonListProps {
  /** 占位行数，默认 3 */
  rows?: number;
}

export function SkeletonList({ rows = 3 }: SkeletonListProps) {
  const items = Array.from({ length: rows }, (_, i) => i);
  return (
    <div className="skeleton-list">
      {items.map((i) => (
        <SkeletonRow key={i} width={i % 2 === 0 ? "100%" : "70%"} height={14} />
      ))}
      <style>{`
        .skeleton-list {
          padding: 12px 0;
        }
      `}</style>
    </div>
  );
}
