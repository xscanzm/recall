// MergeDialog 渲染冒烟测试（plan todo 15 验收：目标组件渲染测试）
// 仓库 renderer 测试基线为 node 环境，沿用 ReportRequirementsPanel.test.ts 的
// renderToStaticMarkup 模式（SSR 不跑 effect，只验证结构渲染不崩溃）。

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { MergeDialog } from "./MergeDialog";

const baseProps = {
  objectType: "person" as const,
  fromId: "person_1",
  fromName: "张三",
  onClose: () => undefined,
};

describe("MergeDialog", () => {
  it("打开时渲染 role=dialog 结构、关闭按钮与操作按钮", () => {
    const html = renderToStaticMarkup(
      createElement(MergeDialog, { ...baseProps, open: true })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("合并人物");
    expect(html).toContain("确认合并");
    expect(html).toContain("取消");
    expect(html).toContain("关闭");
  });

  it("关闭时不渲染任何内容", () => {
    const html = renderToStaticMarkup(
      createElement(MergeDialog, { ...baseProps, open: false })
    );
    expect(html).toBe("");
  });
});
