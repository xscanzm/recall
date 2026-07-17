import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { createEmptyReportRequirements } from "../../shared/reportRequirements";
import { ReportRequirementsPanel } from "./ReportRequirementsPanel";

describe("ReportRequirementsPanel", () => {
  it("renders the four report types and long-term requirement fields", () => {
    const requirements = createEmptyReportRequirements();
    requirements.weekly.focus = "重点统计客户沟通";

    const html = renderToStaticMarkup(createElement(ReportRequirementsPanel, {
      initialType: "weekly",
      requirements,
      onSave: async () => undefined,
      onClose: () => undefined,
    }));

    expect(html).toContain("维护报告要求");
    expect(html).toContain("我的复盘");
    expect(html).toContain("工作日报");
    expect(html).toContain("周报");
    expect(html).toContain("月报");
    expect(html).toContain("重点关注");
    expect(html).toContain("呈现要求");
    expect(html).toContain("注意提醒");
    expect(html).toContain("重点统计客户沟通");
  });
});
