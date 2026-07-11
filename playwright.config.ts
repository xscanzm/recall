import { defineConfig } from "@playwright/test";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  use: { trace: "retain-on-failure" },
  outputDir: path.join(os.tmpdir(), "recall-playwright-results"),
});
