import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("renders project and person admission flows", async () => {
  test.setTimeout(120_000);
  const root = process.cwd();
  const electron = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const captureDir = path.join(os.tmpdir(), "recall-playwright-admission");
  const { stdout } = await execFileAsync(
    electron,
    [path.join(root, "scripts", "smoke-renderer-memory-ui.js")],
    {
      cwd: root,
      env: {
        ...process.env,
        RECALL_CAPTURE_DIR: captureDir,
        RECALL_STANDARD_CAPTURE: "1",
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );

  expect(stdout).toContain('"ok": true');
  expect(stdout).toContain('"项目"');
  expect(stdout).toContain('"人物"');
});
