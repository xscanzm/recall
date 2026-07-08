// src/renderer/components/LoadMorePager.tsx
// 分页/加载更多组件（来自 06 文档"性能原则"）
//
// 职责：
// - 今日页列表分页或虚拟化
// - 当列表数据超过 pageSize 时显示"加载更多"按钮
// - 客户端分页（数据已加载到内存，仅控制可见数量）
//
// 性能原则：
// - 今日页列表分页或虚拟化
// - 默认每页 20 条，用户可点击加载更多
//
// 注意：本组件做客户端分页，因为 todayData 已通过 IPC 一次性加载。
// 若数据量进一步增大（>500条），应在 IPC 层添加真正的服务端分页。

import { useState, useEffect, type ReactNode } from "react";

interface LoadMorePagerProps<T> {
  /** 全量数据 */
  items: T[];
  /** 每页数量，默认 20 */
  pageSize?: number;
  /** 渲染单条数据的函数 */
  renderItem: (item: T, index: number) => ReactNode;
  /** 加载更多按钮文案，默认 "加载更多" */
  loadMoreLabel?: string;
  /** 空状态文案（当 items 为空时显示），默认 "暂无数据" */
  emptyLabel?: string;
}

/**
 * 客户端分页列表
 *
 * 用法：
 *   <LoadMorePager
 *     items={tasks}
 *     pageSize={20}
 *     renderItem={(task) => <div key={task.id}>{task.title}</div>}
 *   />
 */
export function LoadMorePager<T>({
  items,
  pageSize = 20,
  renderItem,
  loadMoreLabel = "加载更多",
  emptyLabel = "暂无数据",
}: LoadMorePagerProps<T>) {
  const [visibleCount, setVisibleCount] = useState(pageSize);

  // 当 items 变化时重置 visibleCount（避免切换数据源后显示数量错误）
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [items, pageSize]);

  if (items.length === 0) {
    return (
      <p className="state-loading" style={{ margin: 0 }}>
        {emptyLabel}
      </p>
    );
  }

  const visibleItems = items.slice(0, visibleCount);
  const hasMore = visibleCount < items.length;
  const remaining = items.length - visibleCount;

  return (
    <>
      <div className="load-more-pager__list">
        {visibleItems.map((item, idx) => renderItem(item, idx))}
      </div>
      {hasMore && (
        <button
          className="load-more-pager__btn"
          onClick={() => setVisibleCount((c) => c + pageSize)}
        >
          {loadMoreLabel}（剩余 {remaining} 条）
        </button>
      )}
      <style>{`
        .load-more-pager__list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .load-more-pager__btn {
          margin-top: 8px;
          align-self: center;
          font-size: 12px;
          color: var(--recall-text-muted);
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          padding: 6px 16px;
          border-radius: var(--radius-pill);
        }
        .load-more-pager__btn:hover {
          background-color: #f0eee7;
          color: var(--recall-accent);
          border-color: var(--recall-accent);
        }
      `}</style>
    </>
  );
}
