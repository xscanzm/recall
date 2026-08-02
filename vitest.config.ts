import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      TZ: "Asia/Shanghai",
    },
    include: ["src/main/**/*.test.ts", "src/renderer/**/*.test.ts", "scripts/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      // 真实覆盖率口径（todo 17）：all:true 对 src/**/*.ts 全量统计，
      // 不再只看"被测试加载到的模块"。基线数值见下方 thresholds 注释。
      all: true,
      include: ["src/**/*.ts"],
      exclude: [
        // vitest 默认排除项（node_modules / dist / 配置文件等）
        "**/node_modules/**",
        "**/dist/**",
        "**/cypress/**",
        "**/.{idea,git,cache,output,temp}/**",
        "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
        // 测试文件与类型声明不计入分母
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
      ],
      // ── 阈值基线（可审计，F1 可按此复算）──────────────────────────────
      // 基线日期：2026-08-02（本 todo 首次启用 all:true 后的实测值，
      //   `npm run test:coverage` text-summary 输出）
      // 基线（statements / branches / functions / lines）=
      //   31.9 / 68.66 / 55.36 / 31.9
      // 推导：阈值 = round(基线 × 0.9)（语句 31.9→28.71→29、分支 68.66→61.79→62、
      //   函数 55.36→49.82→50、行 31.9→28.71→29），为测试补强留出抖动余量。
      // ratchet 约定「只升不降」：此后阈值只允许上调；本次初始重定基线是
      //   唯一一次一次性下调校正，已在此记录（旧阈值 54/67/58/54 为
      //   all:false 失真口径，于 2026-08-02 作废，仅记录不沿用）。
      thresholds: {
        statements: 29, // 基线 31.9 × 0.9 = 28.71 → 29
        branches: 62, // 基线 68.66 × 0.9 = 61.79 → 62
        functions: 50, // 基线 55.36 × 0.9 = 49.82 → 50
        lines: 29, // 基线 31.9 × 0.9 = 28.71 → 29
      },
    },
  },
});
