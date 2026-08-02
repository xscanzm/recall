// src/renderer/hooks/useFocusTrap.ts
// 对话框焦点陷阱 hook（a11y 批量，plan todo 15）
//
// 行为（WAI-ARIA dialog 模式）：
// - enabled=true 时：保存 document.activeElement，把焦点移入容器内第一个可聚焦元素
// - Tab / Shift+Tab 在容器内循环（最后一个 Tab 回到第一个，第一个 Shift+Tab 回到最后一个）
// - Escape 触发 onEscape（由调用方关闭对话框）
// - 禁用 / 卸载时：恢复打开前保存的焦点
//
// 可聚焦元素判定：a[href]、button、input、select、textarea、非 -1 的 [tabindex]
// （与 plan todo 15 的 MODIFICATION SPEC 一致；disabled 控件天然不可聚焦，不额外过滤）

import { useEffect, type RefObject } from "react";

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export interface UseFocusTrapOptions {
  /** 是否启用陷阱（对话框打开时传 true，关闭传 false） */
  enabled: boolean;
  /** Escape 键回调（调用方用它执行关闭逻辑） */
  onEscape: () => void;
}

/**
 * 对话框焦点陷阱：打开时把焦点圈进容器内，Escape 关闭，关闭后还原焦点。
 * 仅做焦点管理，不改变调用方既有的 open/close 逻辑。
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  { enabled, onEscape }: UseFocusTrapOptions
): void {
  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    return setupFocusTrap(container, { onEscape });
  }, [enabled, onEscape, containerRef]);
}

export interface FocusTrapCallbacks {
  onEscape: () => void;
}

/**
 * 焦点陷阱核心逻辑（独立导出以便单测；useFocusTrap 只是它的 useEffect 包装）。
 * 返回清理函数：移除 keydown 监听并恢复之前保存的焦点。
 */
export function setupFocusTrap(
  container: HTMLElement,
  { onEscape }: FocusTrapCallbacks
): () => void {
  const previouslyFocused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  const getFocusable = (): HTMLElement[] =>
    Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

  const focusable = getFocusable();
  (focusable[0] ?? container).focus();

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const items = getFocusable();
    if (items.length === 0) return;
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === items[0] || !container.contains(active)) {
        event.preventDefault();
        items[items.length - 1].focus();
      }
    } else if (active === items[items.length - 1] || !container.contains(active)) {
      event.preventDefault();
      items[0].focus();
    }
  };

  document.addEventListener("keydown", handleKeyDown, true);
  return () => {
    document.removeEventListener("keydown", handleKeyDown, true);
    if (previouslyFocused && document.contains(previouslyFocused)) {
      previouslyFocused.focus();
    }
  };
}
