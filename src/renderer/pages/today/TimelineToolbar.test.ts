// @vitest-environment happy-dom
// TimelineToolbar tablist 键盘导航测试（plan todo 15 验收：目标组件渲染测试）
// 断言 WAI-ARIA tablist 契约：aria-controls / aria-selected / roving tabindex /
// 方向键（自动激活）与 Home/End。

import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TimelineToolbar, type TimelineViewMode } from "./TimelineToolbar";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [viewMode, setViewMode] = useState<TimelineViewMode>("segments");
  return createElement(TimelineToolbar, {
    dateKey: "2026-08-02",
    viewMode,
    onViewModeChange: (mode) => setViewMode(mode),
    onlyWork: false,
    onOnlyWorkChange: () => undefined,
    searchKeyword: "",
    onSearchKeywordChange: () => undefined,
  });
}

let host: HTMLDivElement;
let root: Root;

function getTabs(): HTMLButtonElement[] {
  const tablist = host.querySelector('[role="tablist"]');
  if (!tablist) throw new Error("tablist 未渲染");
  return Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

function fireKeydown(target: HTMLElement, key: string) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}

describe("TimelineToolbar tablist", () => {
  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root.render(createElement(Harness));
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("tablist 契约：aria-controls 指向面板、激活 tab aria-selected=true 且 tabindex=0", () => {
    const tabs = getTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].tabIndex).toBe(-1);
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe("timeline-view-panel");
    }
  });

  it("ArrowRight 移动焦点并激活下一个 tab（自动激活 + roving tabindex）", async () => {
    const tabs = getTabs();
    tabs[0].focus();
    expect(document.activeElement).toBe(tabs[0]);

    await act(async () => {
      fireKeydown(tabs[0], "ArrowRight");
    });

    const after = getTabs();
    expect(document.activeElement).toBe(after[1]);
    expect(after[1].getAttribute("aria-selected")).toBe("true");
    expect(after[1].tabIndex).toBe(0);
    expect(after[0].tabIndex).toBe(-1);
  });

  it("ArrowLeft 从第二个 tab 回到第一个", async () => {
    const tabs = getTabs();
    tabs[1].focus();

    await act(async () => {
      fireKeydown(tabs[1], "ArrowLeft");
    });

    const after = getTabs();
    expect(document.activeElement).toBe(after[0]);
    expect(after[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Home / End 跳到首 / 尾", async () => {
    const tabs = getTabs();
    tabs[0].focus();

    await act(async () => {
      fireKeydown(tabs[0], "End");
    });
    const afterEnd = getTabs();
    expect(document.activeElement).toBe(afterEnd[1]);
    expect(afterEnd[1].getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      fireKeydown(afterEnd[1], "Home");
    });
    const afterHome = getTabs();
    expect(document.activeElement).toBe(afterHome[0]);
    expect(afterHome[0].getAttribute("aria-selected")).toBe("true");
  });

  it("非导航键不触发切换", async () => {
    const tabs = getTabs();
    await act(async () => {
      fireKeydown(tabs[0], "ArrowDown");
    });
    expect(getTabs()[0].getAttribute("aria-selected")).toBe("true");
  });
});
