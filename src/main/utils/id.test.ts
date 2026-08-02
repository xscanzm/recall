import { describe, expect, it } from "vitest";
import { generateId } from "./id";

describe("generateId", () => {
  it("格式为 {prefix}_{base36-ts}_{base36-rand8}", () => {
    // 与统一前 16 处实现的输出格式一致（接受单测断言格式不变）
    for (const prefix of ["fact", "obs", "qj", "cap", "proj", "rsel", "ut", "tb"]) {
      const id = generateId(prefix);
      expect(id).toMatch(/^[a-z]+_[0-9a-z]+_[0-9a-z]{8}$/);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
    }
  });

  it("保留传入前缀原样", () => {
    expect(generateId("fact")).toMatch(/^fact_/);
    expect(generateId("cap")).toMatch(/^cap_/);
    expect(generateId("qj_")).toMatch(/^qj__/);
  });

  it("大量调用下唯一", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = generateId("fact");
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });
});
