import { describe, expect, it } from "vitest";
import { assertBatchStage, assertObjectTable, BATCH_STAGES, OBJECT_TABLES } from "./sqlIdentifiers";

describe("sqlIdentifiers allowlist runtime validation", () => {
  describe("assertBatchStage", () => {
    // 硬编码期望集：与 CaptureInboxRepository.ts:12 的 BatchStage 联合类型
    // （observer | episode | atom | linker）保持一致。任何一侧的成员增删都会使
    // toEqual 失败，防止合法值被误删导致运行时崩溃。
    const EXPECTED = ["observer", "episode", "atom", "linker"] as const;

    it("exports a constant identical to the BatchStage union", () => {
      expect([...BATCH_STAGES]).toEqual([...EXPECTED]);
    });

    it("passes every allowlist member (one case per value)", () => {
      for (const stage of EXPECTED) {
        expect(assertBatchStage(stage)).toBe(stage);
        expect(assertBatchStage(stage)).not.toContain(";");
      }
    });

    it("throws on illegal values instead of interpolating them", () => {
      for (const bad of [
        "; DROP TABLE--",
        "observer; DROP TABLE--",
        "observer_status",
        "OBSERVER",
        "Observer",
        "",
        "projects",
        "linker ",
        "linker;--",
        "atom' OR '1'='1",
      ]) {
        expect(() => assertBatchStage(bad)).toThrow();
      }
    });
  });

  describe("assertObjectTable", () => {
    // 硬编码期望集：由实际代码推导的联合表名集合——
    // MemoryObjectRepository.ts:850（projects/tasks/decisions）、:933
    // （projects/tasks/people/decisions）的 ternary 映射，以及
    // MemoryEdgeRepository.ts:186-190 ENDPOINT_TABLES 的值
    // （observations/facts/scenes/projects/tasks/people/decisions/reports）。
    const EXPECTED = [
      "projects",
      "tasks",
      "people",
      "decisions",
      "observations",
      "facts",
      "scenes",
      "reports",
    ] as const;

    it("exports a constant identical to the derived table mapping", () => {
      expect([...OBJECT_TABLES]).toEqual([...EXPECTED]);
    });

    it("passes every allowlist member (one case per value)", () => {
      for (const table of EXPECTED) {
        expect(assertObjectTable(table)).toBe(table);
      }
    });

    it("throws on illegal values instead of interpolating them", () => {
      for (const bad of [
        "; DROP TABLE--",
        "projects; DROP TABLE projects--",
        "PROJECTS",
        "Project",
        "project",
        "",
        "users",
        "memories",
        "projects ",
        "projects, users",
        "sqlite_master",
      ]) {
        expect(() => assertObjectTable(bad)).toThrow();
      }
    });
  });
});
