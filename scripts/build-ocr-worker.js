#!/usr/bin/env node
/**
 * 跨平台 OCR worker 构建调度器
 *
 * 根据当前平台选择对应的构建脚本：
 * - Windows：调用 scripts/build-rapidocr-worker.ps1（PowerShell）
 * - macOS / Linux：调用 scripts/build-rapidocr-worker.sh（Bash）
 *
 * 这样 `npm run build:ocr-worker` 在任何平台都能工作，
 * `package` 与 `package:mac` 都可以共用这个入口。
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const isWin = process.platform === "win32";
const repoRoot = path.resolve(__dirname, "..");

let cmd;
let args;
if (isWin) {
  cmd = "pwsh";
  args = ["-NoProfile", "-File", "scripts/build-rapidocr-worker.ps1"];
} else {
  cmd = "bash";
  args = ["scripts/build-rapidocr-worker.sh"];
}

const result = spawnSync(cmd, args, {
  cwd: repoRoot,
  stdio: "inherit",
  // Windows 上 pwsh 直接执行无需 shell；Unix 上 bash 通常在 PATH 中
  shell: !isWin,
});

if (result.error) {
  console.error(`Failed to spawn ${cmd}: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
