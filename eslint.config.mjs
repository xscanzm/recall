// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * 扁平配置（ESLint 9）
 *
 * 分层思路：
 * - src/main + src/shared 走 tsconfig.node.json，src/renderer 走 tsconfig.web.json；
 *   两边 lib / module 不同，混用会让类型感知规则误判。
 * - 只开真能抓到 bug 的类型感知规则（floating promise / misused promise / await 非
 *   thenable）。风格类规则交给 tsc + review，避免一次性引入几千条噪声。
 * - 脚本目录是 CommonJS 的构建工具代码，只做基础语法检查。
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "release/**",
      "coverage/**",
      "node_modules/**",
      "cloudflare/worker/node_modules/**",
      "resources/**",
      "scripts/output/**",
      "**/*.d.ts",
    ],
  },

  // 主进程 / 共享层
  {
    files: ["src/main/**/*.ts", "src/shared/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { project: "./tsconfig.node.json", tsconfigRootDir: import.meta.dirname },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // 下划线前缀是本仓库既有的“故意不用”约定
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },

  // 渲染进程
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.web.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },

  // 不在两个主 tsconfig 覆盖范围内的 TS：Worker、构建脚本测试、e2e。
  // 只做语法 + 非类型感知检查，避免为它们各配一套 project。
  {
    files: ["cloudflare/worker/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { project: false },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // 原型脚本 / Worker 里 require 是刻意的动态加载
      "@typescript-eslint/no-require-imports": "off",
    },
  },

  // 原型脚本：一次性实验代码，留着未走通的分支是刻意的，不按生产标准要求
  {
    files: ["scripts/prototype-*.ts"],
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },

  // 测试：断言里大量 as never / 空函数，放宽到不影响正确性的程度
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-function": "off",
      "no-console": "off",
    },
  },

  // 构建脚本（CommonJS / ESM 混杂，无类型工程）
  {
    files: ["scripts/**/*.{js,mjs}", "*.config.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: "commonjs",
    },
    rules: { "no-console": "off" },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { sourceType: "module" },
  },
);
