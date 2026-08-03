// src/main/ipc/handlers/updateHandlers.test.ts
// P0 安全回归：update:installAndQuit 不得接受渲染层传入的 installerPath
// 覆盖：
// (a) 渲染层传 { installerPath } → schema_invalid，installAndQuit 不被调用
// (b) 未下载时 installAndQuit() → 抛错，shell.openPath 不被调用
// (c) 下载完成后 installAndQuit() 使用主进程内部路径（无参调用）
// (d) isInsideUpdatesDir：目录内放行 / 目录外拒绝 / 符号链接逃逸拒绝

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  app: { getPath: vi.fn(), quit: vi.fn(), getVersion: vi.fn(() => "0.0.0-test") },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
  net: { fetch: vi.fn() },
}));

// macOS 分支 installAndQuit 走 spawn("open")；mock 让 exit(code 0) 立即回调，
// 避免真实 spawn 在 macOS CI 上对无效 DMG 文件返回非零退出码。
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    once: (event: string, cb: (code?: number) => void) => {
      if (event === "exit") queueMicrotask(() => cb(0));
    },
  })),
}));

import { app, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { IpcValidationError } from "../validated";
import { addTrustedWebContents, resetTrustedWebContents } from "../trustedWebContents";
import { registerUpdateHandlers } from "./updateHandlers";
import { UpdateService, isInsideUpdatesDir } from "../../services/UpdateService";
import type { UpdateInfo } from "../../../shared/updateTypes";

/** 构造通过 isTrustedSender 校验的伪事件（todo 5 sender 校验） */
function trustedEvent(): { sender: { id: number; mainFrame: object }; senderFrame: object } {
  const mainFrame = {};
  return { sender: { id: 1, mainFrame }, senderFrame: mainFrame };
}

/** 取 ipcMain.handle 注册的 channel 处理器（最后一次注册，removeHandler 调用被忽略） */
function getIpcHandler(channel: string): (event: unknown, rawInput?: unknown) => Promise<unknown> {
  const calls = vi.mocked(ipcMain.handle).mock.calls.filter(([ch]) => ch === channel);
  const call = calls.at(-1);
  if (!call) throw new Error(`handler not registered: ${channel}`);
  return call[1] as (event: unknown, rawInput?: unknown) => Promise<unknown>;
}

let updatesRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  resetTrustedWebContents();
  addTrustedWebContents(1);
  updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-updates-test-"));
  // getUpdatesDir() = app.getPath("userData")/updates
  vi.mocked(app.getPath).mockReturnValue(updatesRoot);
  vi.mocked(shell.openPath).mockResolvedValue("");
});

/** 用真实 UpdateService（electron 已 mock），settingsService 用最小 fake */
function createService(): UpdateService {
  return new UpdateService({
    settingsService: {
      getAll: () => ({ update: null }),
      setUpdateSettings: vi.fn(),
    } as never,
  });
}

// 安装包文件名与 UpdateService.downloadUpdate 的平台推导保持一致：
// Windows .exe / macOS .dmg（makeInfo 默认 downloadUrl 在 macOS 上为 .dmg）。
const INSTALLER_NAME =
  process.platform === "win32"
    ? "Recall-0.5.6-installer.exe"
    : "Recall-0.5.6-installer.dmg";

function makeInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    hasUpdate: true,
    currentVersion: "0.5.5",
    latestVersion: "0.5.6",
    downloadUrl:
      process.platform === "win32"
        ? "/download/Recall-0.5.6-installer.exe"
        : "/download/Recall-0.5.6-installer.dmg",
    sha256: "deadbeef",
    releaseNotes: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("update:installAndQuit 契约（P0：拒绝渲染层路径输入）", () => {
  it("渲染层传 { installerPath } → schema_invalid，installAndQuit 不被调用", async () => {
    const installAndQuit = vi.fn();
    registerUpdateHandlers({
      updateService: { installAndQuit, getStatus: () => ({ state: "idle" }) } as never,
      getMainWindow: () => undefined,
    } as never);

    const handler = getIpcHandler("update:installAndQuit");
    const attempt = handler(trustedEvent(), { installerPath: "C:\\Windows\\System32\\cmd.exe" });

    await expect(attempt).rejects.toBeInstanceOf(IpcValidationError);
    await expect(attempt).rejects.toMatchObject({ code: "schema_invalid" });
    expect(installAndQuit).not.toHaveBeenCalled();
  });

  it("无输入（undefined）→ 无参调用 installAndQuit 并返回 ok", async () => {
    const installAndQuit = vi.fn().mockResolvedValue(undefined);
    registerUpdateHandlers({
      updateService: { installAndQuit, getStatus: () => ({ state: "idle" }) } as never,
      getMainWindow: () => undefined,
    } as never);

    const handler = getIpcHandler("update:installAndQuit");
    const result = await handler(trustedEvent(), undefined);

    expect(result).toEqual({ ok: true });
    expect(installAndQuit).toHaveBeenCalledTimes(1);
    expect(installAndQuit).toHaveBeenCalledWith();
  });
});

describe("UpdateService.installAndQuit 内部路径（P0）", () => {
  it("未下载任何安装包时调用 → 抛错，shell.openPath 不被调用", async () => {
    const svc = createService();

    await expect(svc.installAndQuit()).rejects.toThrow(/no installer downloaded/i);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: "error" });
  });

  it("下载成功后无参调用 → 启动 updates 目录内的安装包（内部路径）", async () => {
    const content = Buffer.from(`fake-installer-bytes-${Date.now()}`);
    const installerPath = path.join(updatesRoot, "updates", INSTALLER_NAME);
    fs.mkdirSync(path.dirname(installerPath), { recursive: true });
    fs.writeFileSync(installerPath, content);
    const info = makeInfo({ sha256: crypto.createHash("sha256").update(content).digest("hex") });

    const svc = createService();
    const downloaded = await svc.downloadUpdate(info, vi.fn());
    expect(downloaded).toBe(installerPath);

    await svc.installAndQuit();

    if (process.platform === "darwin") {
      // macOS：spawn("open") 挂载 DMG，不立即 app.quit
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith("open", [installerPath], { stdio: "ignore" });
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
    } else {
      expect(shell.openPath).toHaveBeenCalledTimes(1);
      expect(shell.openPath).toHaveBeenCalledWith(installerPath);
      expect(app.quit).toHaveBeenCalledTimes(1);
    }
  });

  it("内部路径不在 updates 目录内 → 抛错，不启动", async () => {
    // 直接构造：绕过 downloadUpdate，把 lastInstallerPath 指向外部路径
    const outside = path.join(updatesRoot, "evil.exe");
    fs.writeFileSync(outside, "x");
    const svc = createService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).lastInstallerPath = outside;

    await expect(svc.installAndQuit()).rejects.toThrow(/outside the updates directory/i);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: "error" });
  });
});

describe("isInsideUpdatesDir", () => {
  it("updates 目录内的路径 → true", () => {
    const dir = path.join(updatesRoot, "updates");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "inside.exe");
    fs.writeFileSync(file, "x");

    expect(isInsideUpdatesDir(file)).toBe(true);
  });

  it("updates 目录外的路径 → false", () => {
    const file = path.join(updatesRoot, "outside.exe");
    fs.writeFileSync(file, "x");

    expect(isInsideUpdatesDir(file)).toBe(false);
  });

  it("不存在的路径 → false", () => {
    expect(isInsideUpdatesDir(path.join(updatesRoot, "updates", "nope.exe"))).toBe(false);
  });
});

// Windows 未开开发者模式时 symlink 创建会失败（EPERM），此时跳过符号链接用例
const symlinkSupported = (() => {
  try {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-symlink-probe-"));
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    fs.writeFileSync(a, "x");
    fs.symlinkSync(a, b);
    fs.rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

describe("isInsideUpdatesDir 符号链接逃逸", () => {
  it.skipIf(!symlinkSupported)("updates 目录内的符号链接指向目录外文件 → false", () => {
    const dir = path.join(updatesRoot, "updates");
    fs.mkdirSync(dir, { recursive: true });
    const outside = path.join(updatesRoot, "target.exe");
    fs.writeFileSync(outside, "x");
    const link = path.join(dir, "escape-link.exe");
    fs.symlinkSync(outside, link);

    expect(isInsideUpdatesDir(link)).toBe(false);
  });
});
