import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: { trace: "retain-on-failure" },
  // 仓库内相对路径，CI 失败后可经 upload-artifact 上传排查；不再写系统临时目录。
  outputDir: "test-results",
});
