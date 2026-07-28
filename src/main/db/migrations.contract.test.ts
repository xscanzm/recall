import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 迁移编号 append-only 守卫
 *
 * runMigrations 按文件名排序执行，且已执行的版本记在 _migrations 表里跳过。
 * 因此回填一个比现有最大值更小的编号会造成两批用户的 schema 演化顺序不一致：
 * - 老库：新文件排在已执行的所有迁移之后执行
 * - 新装库：新文件按编号排在中间执行
 *
 * 现有序列缺 007（历史上从未存在）。这个测试冻结当前最大编号，
 * 强制新迁移只能往后加，不能填补历史空洞。
 */
const MIGRATIONS_DIR = resolve(process.cwd(), "src/main/db/migrations");

/** 当前已发布的最大迁移编号。新增迁移时同步上调此值。 */
const HIGHEST_RELEASED_MIGRATION = 29;

/** 历史上跳过、永久不得回填的编号。 */
const PERMANENTLY_SKIPPED = [7];

function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function migrationNumber(fileName: string): number {
  const match = /^(\d+)_/.exec(fileName);
  if (!match) throw new Error(`迁移文件名必须以数字编号加下划线开头: ${fileName}`);
  return Number.parseInt(match[1], 10);
}

describe("migration numbering contract", () => {
  const files = listMigrationFiles();

  it("每个迁移文件都有合法的数字前缀", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(() => migrationNumber(file)).not.toThrow();
      expect(/^\d{3}_/.test(file)).toBe(true);
    }
  });

  it("编号唯一，不存在重复", () => {
    const numbers = files.map(migrationNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("按文件名排序与按编号排序一致", () => {
    // 保证 readdirSync().sort() 的执行顺序等于编号语义顺序。
    // 三位数零填充下二者天然一致；一旦有人用 1_ 或 0028_ 破坏格式，这里会失败。
    const byName = files.map(migrationNumber);
    const byNumber = [...byName].sort((a, b) => a - b);
    expect(byName).toEqual(byNumber);
  });

  it("不得回填历史跳过的编号", () => {
    const numbers = new Set(files.map(migrationNumber));
    for (const skipped of PERMANENTLY_SKIPPED) {
      expect(numbers.has(skipped)).toBe(false);
    }
  });

  it("新增迁移必须大于已发布的最大编号", () => {
    const max = Math.max(...files.map(migrationNumber));
    // 新增迁移时：把文件编号设为 HIGHEST_RELEASED_MIGRATION + 1，并同步上调常量。
    expect(max).toBe(HIGHEST_RELEASED_MIGRATION);
  });
});
