// src/main/utils/identity.test.ts
import { describe, expect, it } from "vitest";
import { normalizeIdentity, comparePersonIdentity } from "../../shared/identity";

describe("normalizeIdentity", () => {
  it("处理前后空格", () => {
    expect(normalizeIdentity("  Recall  ")).toBe("recall");
  });

  it("折叠多个内部空格", () => {
    expect(normalizeIdentity("Recall   Project")).toBe("recall project");
    expect(normalizeIdentity("  项目  A   测试  ")).toBe("项目 a 测试");
  });

  it("ASCII 大小写归一", () => {
    expect(normalizeIdentity("Recall PROJ")).toBe("recall proj");
    expect(normalizeIdentity("ABCdef")).toBe("abcdef");
  });

  it("全角/半角括号归一 (Unicode NFKC)", () => {
    expect(normalizeIdentity("Recall（v1.0）")).toBe("recall(v1.0)");
    expect(normalizeIdentity("Recall（v1.0）")).toBe(normalizeIdentity("Recall(v1.0)"));
    expect(normalizeIdentity("项目 (测试)")).toBe("项目 (测试)");
    expect(normalizeIdentity("项目（测试）")).toBe(normalizeIdentity("项目(测试)"));
  });

  it("中文名称保持稳定", () => {
    expect(normalizeIdentity("回声项目")).toBe("回声项目");
    expect(normalizeIdentity("张三")).toBe("张三");
  });

  it("标点不同不会被错误吞掉", () => {
    expect(normalizeIdentity("Recall-v1.0")).toBe("recall-v1.0");
    expect(normalizeIdentity("Recall.v1.0")).toBe("recall.v1.0");
    expect(normalizeIdentity("Recall-v1.0")).not.toBe(normalizeIdentity("Recall.v1.0"));
  });
});

describe("comparePersonIdentity", () => {
  it("名字不同判定为 different_name", () => {
    const res = comparePersonIdentity(
      { name: "张三" },
      { name: "李四" }
    );
    expect(res.classification).toBe("different_name");
    expect(res.isSameIdentity).toBe(false);
  });

  it("仅归一化名称相同（无强字段或单边缺失）判定为 normalized_name_match，isSameIdentity 为 false", () => {
    const res = comparePersonIdentity(
      { name: "张三 ", role: "前端工程师" },
      { name: " 张三" }
    );
    expect(res.classification).toBe("normalized_name_match");
    expect(res.isSameIdentity).toBe(false);
  });

  it("名称及角色/组织强字段一致判定为 strong_field_match", () => {
    const res = comparePersonIdentity(
      { name: "李四", role: "架构师", organization: "Recall Team" },
      { name: " 李四 ", role: "架构师", organization: "Recall Team" }
    );
    expect(res.classification).toBe("strong_field_match");
    expect(res.isSameIdentity).toBe(true);
  });

  it("同名但组织或角色不同的人判定为 conflict_detected，不会被自动判定为同一身份", () => {
    const resRoleConflict = comparePersonIdentity(
      { name: "王五", role: "产品经理", organization: "公司 A" },
      { name: "王五", role: "测试工程师", organization: "公司 A" }
    );
    expect(resRoleConflict.classification).toBe("conflict_detected");
    expect(resRoleConflict.isSameIdentity).toBe(false);

    const resOrgConflict = comparePersonIdentity(
      { name: "王五", role: "开发", organization: "公司 A" },
      { name: "王五", role: "开发", organization: "公司 B" }
    );
    expect(resOrgConflict.classification).toBe("conflict_detected");
    expect(resOrgConflict.isSameIdentity).toBe(false);
  });
});
