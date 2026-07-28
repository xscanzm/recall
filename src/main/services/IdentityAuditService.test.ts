// src/main/services/IdentityAuditService.test.ts
import { describe, expect, it, vi } from "vitest";
import { IdentityAuditService } from "./IdentityAuditService";

describe("IdentityAuditService 只读 dry-run 重复对象审计", () => {
  it("正确识别 仅归一化名称相同、强字段一致、强字段冲突 三种结果且不执行写操作", () => {
    const projects = [
      { id: "p-1", name: "Recall", summary: "项目摘要 A" },
      { id: "p-2", name: "recall ", summary: "项目摘要 A" },
      { id: "p-3", name: "Recall ", summary: "完全不同的摘要 B" },
    ];

    const people = [
      // 组 A: 强字段一致
      { id: "person-1", name: "李四", role: "架构师", organization: "Recall", summary: null },
      { id: "person-2", name: " 李四 ", role: "架构师", organization: "Recall", summary: null },
      // 组 B: 冲突 (同名但角色/组织不同)
      { id: "person-3", name: "王五", role: "PM", organization: "Company A", summary: null },
      { id: "person-4", name: "王五", role: "Dev", organization: "Company B", summary: null },
      // 组 C: 仅归一化名称相同 (缺少角色/组织)
      { id: "person-5", name: "赵六", role: null, organization: null, summary: null },
      { id: "person-6", name: " 赵六 ", role: null, organization: null, summary: null },
    ];

    const dbPrepare = vi.fn((sql: string) => {
      if (sql.includes("FROM projects")) return { all: () => projects };
      if (sql.includes("FROM people")) return { all: () => people };
      return { all: () => [] };
    });

    const db = { prepare: dbPrepare };

    const report = IdentityAuditService.audit(db as never);

    // 确认调用的均为 SELECT 查询
    expect(dbPrepare).toHaveBeenCalledTimes(2);
    expect(dbPrepare.mock.calls[0][0]).toContain("SELECT");
    expect(dbPrepare.mock.calls[1][0]).toContain("SELECT");

    // 验证扫描统计
    expect(report.scannedProjectsCount).toBe(3);
    expect(report.scannedPeopleCount).toBe(6);

    // 验证项目分组与候选分类（项目同名只归类为 normalized_name_match，不判定冲突）
    expect(report.projectDuplicateGroups).toHaveLength(1);
    expect(report.projectDuplicateGroups[0].classification).toBe("normalized_name_match");

    // 验证人物分组分类
    expect(report.personDuplicateGroups).toHaveLength(3);

    const groupLiSi = report.personDuplicateGroups.find((g) => g.normalizedName === "李四");
    expect(groupLiSi?.classification).toBe("strong_field_match");

    const groupWangWu = report.personDuplicateGroups.find((g) => g.normalizedName === "王五");
    expect(groupWangWu?.classification).toBe("conflict_detected");

    const groupZhaoLiu = report.personDuplicateGroups.find((g) => g.normalizedName === "赵六");
    expect(groupZhaoLiu?.classification).toBe("normalized_name_match");
  });
});
