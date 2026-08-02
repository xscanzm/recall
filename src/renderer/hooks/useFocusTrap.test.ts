// @vitest-environment happy-dom
// useFocusTrap 单测（plan todo 15 验收：useFocusTrap 单测全绿）
// 仓库 renderer 测试基线为 node 环境（无 DOM），本测试按 todo 15 MODIFICATION
// SPEC 使用 happy-dom（devDependency），挂载真实组件 + 真实 KeyboardEvent。

import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusTrap, setupFocusTrap } from "./useFocusTrap";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function TrapHarness(props: {
  enabled: boolean;
  onEscape: () => void;
  focusable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { enabled: props.enabled, onEscape: props.onEscape });
  return createElement(
    "div",
    { ref, "data-testid": "trap-container" },
    props.focusable === false
      ? null
      : [
          createElement("button", { key: "a" }, "第一"),
          createElement("button", { key: "b" }, "第二"),
          createElement("input", { key: "c", type: "text" }),
        ]
  );
}

let host: HTMLDivElement;
let root: Root;

function mount(props: { enabled: boolean; onEscape: () => void; focusable?: boolean }) {
  return act(async () => {
    root.render(createElement(TrapHarness, props));
  });
}

function fireKeydown(key: string, extra: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, ...extra });
  document.dispatchEvent(event);
  return event;
}

describe("useFocusTrap", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it("打开时保存外部焦点并把焦点移入容器内第一个可聚焦元素", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await mount({ enabled: true, onEscape: vi.fn() });

    expect(document.activeElement?.textContent).toBe("第一");
    outside.remove();
  });

  // 注意：happy-dom 的 dispatchEvent 会克隆事件对象，无法可靠读取原始事件的
  // defaultPrevented；且 happy-dom 不实现原生 Tab 焦点移动。因此回绕/不拦截
  // 行为一律断言焦点落点（即用户可感知的 a11y 结果）。

  it("Tab 在最后一个元素时回绕到第一个", async () => {
    await mount({ enabled: true, onEscape: vi.fn() });
    const inputs = host.querySelectorAll("input");
    (inputs[0] as HTMLInputElement).focus();

    fireKeydown("Tab");

    expect(document.activeElement?.textContent).toBe("第一");
  });

  it("Shift+Tab 在第一个元素时回绕到最后一个", async () => {
    await mount({ enabled: true, onEscape: vi.fn() });
    const buttons = host.querySelectorAll("button");
    (buttons[0] as HTMLButtonElement).focus();

    fireKeydown("Tab", { shiftKey: true });

    expect((document.activeElement as HTMLInputElement).type).toBe("text");
  });

  it("Escape 调用 onEscape", async () => {
    const onEscape = vi.fn();
    await mount({ enabled: true, onEscape });

    fireKeydown("Escape");

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("容器内 Tab 在中间元素时不拦截（焦点自然移动）", async () => {
    await mount({ enabled: true, onEscape: vi.fn() });
    const buttons = host.querySelectorAll("button");
    (buttons[1] as HTMLButtonElement).focus();

    fireKeydown("Tab");

    // happy-dom 无原生 Tab 移动：未被陷阱拦截 = 焦点原地不动（未被回绕）
    expect(document.activeElement).toBe(buttons[1]);
  });

  it("禁用后恢复打开前保存的焦点", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    await mount({ enabled: true, onEscape: vi.fn() });
    expect(document.activeElement?.textContent).toBe("第一");

    await mount({ enabled: false, onEscape: vi.fn() });

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("卸载时恢复打开前保存的焦点", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    await mount({ enabled: true, onEscape: vi.fn() });
    expect(document.activeElement?.textContent).toBe("第一");

    await act(async () => {
      root.unmount();
    });

    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("容器内没有可聚焦元素时焦点落到容器本身", async () => {
    await mount({ enabled: true, onEscape: vi.fn(), focusable: false });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="trap-container"]'));
  });

  it("enabled=false 时不注册监听（Escape 不触发回调）", async () => {
    const onEscape = vi.fn();
    await mount({ enabled: false, onEscape });
    fireKeydown("Escape");
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe("setupFocusTrap", () => {
  it("清理函数移除监听并恢复焦点（直接调用核心逻辑）", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    const container = document.createElement("div");
    const inner = document.createElement("button");
    inner.textContent = "内部";
    container.appendChild(inner);
    document.body.appendChild(container);

    const onEscape = vi.fn();
    const cleanup = setupFocusTrap(container, { onEscape });
    expect(document.activeElement).toBe(inner);

    fireKeydown("Escape");
    expect(onEscape).toHaveBeenCalledTimes(1);

    cleanup();
    expect(document.activeElement).toBe(outside);

    outside.remove();
    container.remove();
  });
});
