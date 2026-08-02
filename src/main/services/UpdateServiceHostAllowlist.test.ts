// src/main/services/UpdateServiceHostAllowlist.test.ts
// P1 安全：更新下载 URL 主机白名单（plan todo 6）
//
// 独立测试文件（不并入 UpdateService.test.ts）：todo 18（UpdateService 核心单测）
// 可能并发创建同名文件，本文件只测 todo 6 的 isAllowedUpdateHost 及 downloadUpdate
// 接线点，避免与 todo 18 的 mock 序列冲突。
//
// 覆盖（plan 要求）：
// (a) 合法 host（默认 UPDATE_WORKER_URL）放行
// (b) 任意其他 host（https://evil.example.com/payload）→ 抛错且不发起下载
// (c) 相对路径拼接后仍落在允许 host 上
// (d) 畸形 URL → 拒绝（false，不抛出解析异常）
// 附加：配置的 UPDATE_WORKER_URL host 与默认不同时同样放行（env 覆盖分支）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

const electronMocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  getVersion: vi.fn(() => "0.0.0-test"),
  quit: vi.fn(),
  fetch: vi.fn(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: electronMocks.getPath,
    getVersion: electronMocks.getVersion,
    quit: electronMocks.quit,
  },
  net: { fetch: electronMocks.fetch },
  shell: { openPath: electronMocks.openPath },
}));

import { UpdateService, isAllowedUpdateHost } from "./UpdateService";
import type { UpdateInfo } from "../../shared/updateTypes";

const DEFAULT_HOST = "recall-update.ppclaw.online";
const EVIL_URL = "https://evil.example.com/payload";

function makeInfo(downloadUrl: string): UpdateInfo {
  return {
    hasUpdate: true,
    currentVersion: "0.5.5",
    latestVersion: "0.5.6",
    downloadUrl,
    sha256: "deadbeef",
    releaseNotes: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createService(): UpdateService {
  return new UpdateService({
    settingsService: {
      getAll: () => ({ update: null }),
      setUpdateSettings: vi.fn(),
    } as never,
  });
}

let updatesRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-host-allow-test-"));
  electronMocks.getPath.mockReturnValue(updatesRoot);
  // HEAD 探测失败 → 回退流式下载 → 仍失败；用于断言"已越过 host 校验进入下载流程"
  electronMocks.fetch.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAllowedUpdateHost（纯函数）", () => {
  it("(a) 默认允许 host 通过", () => {
    expect(isAllowedUpdateHost(`https://${DEFAULT_HOST}/download/latest`)).toBe(true);
    expect(isAllowedUpdateHost(`https://${DEFAULT_HOST}/api/check?currentVersion=0.5.6`)).toBe(
      true,
    );
  });

  it("(b) 任意其他 host 被拒绝（含前缀伪装与子域）", () => {
    expect(isAllowedUpdateHost(EVIL_URL)).toBe(false);
    expect(isAllowedUpdateHost("https://recall-update.ppclaw.online.evil.com/x")).toBe(false);
    expect(isAllowedUpdateHost("https://sub.ppclaw.online/x")).toBe(false);
  });

  it("(c) 相对路径单独传入不可解析 → false（由接线处先拼完整 URL 再校验）", () => {
    expect(isAllowedUpdateHost("/download/Recall-0.5.6-installer.exe")).toBe(false);
  });

  it("(d) 畸形 URL 返回 false 而非抛出", () => {
    expect(isAllowedUpdateHost("https://")).toBe(false);
    expect(isAllowedUpdateHost("not a url")).toBe(false);
    expect(isAllowedUpdateHost("")).toBe(false);
  });

  it("(e) 配置的 UPDATE_WORKER_URL host 与默认不同时同样放行", async () => {
    vi.resetModules();
    vi.stubEnv("RECALL_UPDATE_WORKER_URL", "https://updates.custom.example.com");
    const mod = await import("./UpdateService");
    expect(mod.isAllowedUpdateHost("https://updates.custom.example.com/Recall-setup.exe")).toBe(
      true,
    );
    // 默认 host 始终放行
    expect(mod.isAllowedUpdateHost(`https://${DEFAULT_HOST}/x`)).toBe(true);
    expect(mod.isAllowedUpdateHost(EVIL_URL)).toBe(false);
  });
});

describe("downloadUpdate 主机白名单接线", () => {
  it("(a) 绝对合法 URL 通过校验并按原 URL 发起下载（不抛 host 错误）", async () => {
    const svc = createService();
    const legit = `https://${DEFAULT_HOST}/download/Recall-0.5.6-installer.exe`;
    // fetch 恒 404 → 下载流程报 HTTP 错而非 host 错，证明已越过校验
    await expect(svc.downloadUpdate(makeInfo(legit), vi.fn())).rejects.toThrow(/HTTP/);
    const urls = electronMocks.fetch.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain(legit);
  });

  it("(c) 相对路径拼接后仍落在允许 host 上", async () => {
    const svc = createService();
    const rel = "/download/Recall-0.5.6-installer.exe";
    await expect(svc.downloadUpdate(makeInfo(rel), vi.fn())).rejects.toThrow(/HTTP/);
    const firstUrl = electronMocks.fetch.mock.calls[0]?.[0];
    expect(firstUrl).toBe(`https://${DEFAULT_HOST}${rel}`);
  });

  it("(b) 指向任意其他 host → 抛错（消息含 host），且不发起任何下载", async () => {
    const svc = createService();
    await expect(svc.downloadUpdate(makeInfo(EVIL_URL), vi.fn())).rejects.toThrow(
      /evil\.example\.com/,
    );
    expect(electronMocks.fetch).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: "error", code: "host_not_allowed" });
  });

  it("(d) 畸形 URL → 拒绝且不发起下载", async () => {
    const svc = createService();
    await expect(svc.downloadUpdate(makeInfo("https://"), vi.fn())).rejects.toThrow(
      /host not allowed/,
    );
    expect(electronMocks.fetch).not.toHaveBeenCalled();
  });
});
