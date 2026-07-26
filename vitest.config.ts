import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/main/**/*.test.ts", "src/renderer/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // 只统计被测试实际加载到的模块。全量 all:true 会把 UI 页面、迁移脚本
      // 这些当前无单测的大文件拉进分母，阈值就只能定在没有约束力的低位。
      all: false,
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        "src/renderer/main.tsx",
        "scripts/prototype-*.ts",
      ],
      // 棘轮地板：取 2026-07 实测基线（语句 56.0 / 分支 69.3 / 函数 60.6）下调
      // 约 2 个百分点，留出重构时的正常抖动。补了测试就把地板往上抬，只准涨不准跌。
      thresholds: {
        statements: 54,
        branches: 67,
        functions: 58,
        lines: 54,
      },
    },
  },
});
