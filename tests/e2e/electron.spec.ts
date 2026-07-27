import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let userDataDir: string;
let app: ElectronApplication | undefined;

async function launch() {
  app = await electron.launch({
    args: [".", `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: "production", RECALL_OPEN_DEVTOOLS: "0" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page;
}

async function closeApp() {
  if (!app) return;
  const closing = app;
  await Promise.all([
    new Promise<void>((resolve) => closing.once("close", resolve)),
    closing.close(),
  ]);
  app = undefined;
}

async function dragWindowFrom(page: Awaited<ReturnType<typeof launch>>, selector: string) {
  const region = page.locator(selector);
  const box = await region.boundingBox();
  if (!box) throw new Error(`Missing drag region: ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 50, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
}

async function mainWindowBounds() {
  if (!app) throw new Error("Electron app is not running");
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Main window is missing");
    return window.getBounds();
  });
}

test.beforeAll(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-e2e-"));
});

test.afterEach(async () => {
  await closeApp().catch(() => undefined);
});

test.afterAll(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

test("first-run choice persists, observation intent restores, and core renderer pages load", async () => {
  let page = await launch();
  await expect(page.getByRole("heading", { name: "欢迎使用 Recall" })).toBeVisible();
  await page.getByRole("button", { name: "跳过引导" }).first().click();
  await expect(page.getByRole("button", { name: "今日" })).toBeVisible();

  await page.getByRole("button", { name: "设置" }).click();
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  const autoResume = page.getByLabel("开机后自动恢复观察");
  await autoResume.check();
  await expect(autoResume).toBeChecked();
  await expect(page.getByText("登录 Windows 后自动启动 Recall")).toBeVisible();

  await closeApp();
  page = await launch();
  await expect(page.locator(".app-shell__topbar").getByRole("button", { name: "暂停观察" })).toBeVisible();
  await page.getByRole("button", { name: "记忆库" }).click();
  await expect(page.locator("body")).toContainText("记忆");
  await page.getByRole("button", { name: "报告" }).click();
  await expect(page.locator("body")).toContainText("报告");
  await page.getByRole("button", { name: "今日" }).click();
  await expect(page.getByRole("main", { name: "今日时间轴" })).toBeVisible();
  await expect(page.getByText("回声 Recall", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "最小化" })).toBeVisible();
  await expect(page.getByRole("button", { name: "最大化或还原" })).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭" })).toBeVisible();

  if (process.platform === "win32") {
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize());
    await page.waitForTimeout(200);

    const beforeTopbarDrag = await mainWindowBounds();
    await dragWindowFrom(page, ".app-shell__topbar");
    const afterTopbarDrag = await mainWindowBounds();
    expect(Math.abs(afterTopbarDrag.width - beforeTopbarDrag.width)).toBeLessThanOrEqual(4);
    expect(Math.abs(afterTopbarDrag.height - beforeTopbarDrag.height)).toBeLessThanOrEqual(4);
    expect([afterTopbarDrag.x, afterTopbarDrag.y]).not.toEqual([
      beforeTopbarDrag.x,
      beforeTopbarDrag.y,
    ]);

    const beforeBrandDrag = afterTopbarDrag;
    await dragWindowFrom(page, ".app-shell__brand");
    const afterBrandDrag = await mainWindowBounds();
    expect([afterBrandDrag.x, afterBrandDrag.y]).not.toEqual([
      beforeBrandDrag.x,
      beforeBrandDrag.y,
    ]);
  }
});
