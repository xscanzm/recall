// src/main/services/UpdateService.test.ts
// P0 核心单测：更新下载管线（plan todo 18）
//
// 覆盖（plan 要求，mock net.fetch 可控响应序列）：
// ① Accept-Ranges 探测 + 4MB Range 分片拼接正确（字节顺序 + Range 头）
// ② 单片超时 → 单片重试退避 5 次 → 轮次耗尽抛错（断言尝试次数）
// ③ .part + .meta.json 断点续传（Range 头从记录偏移开始）
// ④ SHA256 校验失败 → 抛错、产物清理、安装器不启动（shell.openPath 未调用）
// ⑤ 服务器不支持 Range → 回退流式下载
// ⑥ 主机白名单拒绝（复用 todo 6 已合入的 isAllowedUpdateHost + 接线断言）
// ⑦ installAndQuit：未下载抛错 / 下载后使用内部 lastInstallerPath /
//    isInsideUpdatesDir 目录外路径兜底拒绝
// 附加：checkForUpdates / dismissVersion / cleanupIncompleteDownloads
//      （同一服务，补足函数覆盖率至 >60% 门禁）
//
// 与 UpdateServiceHostAllowlist.test.ts（todo 6）分工：该文件只测白名单纯函数
// 与接线点，本文件专注下载管线本身；主机拒绝用例在此仅作接线复述。
//
// 平台说明：测试平台无关。安装包文件名按 UpdateService.downloadUpdate 的
// 平台推导（Windows .exe / macOS .dmg）由 INSTALLER_NAME 生成，避免 macOS
// 上硬编码 .exe 导致路径断言失败；installAndQuit 断言按平台分支
// （darwin → spawn("open") 挂载 DMG，其余 → shell.openPath + app.quit）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

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

// macOS 分支 installAndQuit 走 spawn("open")；mock 让 exit(code 0) 立即回调，
// 避免真实 spawn 在 macOS CI 上对无效 DMG 文件返回非零退出码。
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    once: (event: string, cb: (code?: number) => void) => {
      if (event === "exit") queueMicrotask(() => cb(0));
    },
  })),
}));

import { shell } from "electron";
import { spawn } from "node:child_process";
import { UpdateService, isAllowedUpdateHost, isInsideUpdatesDir } from "./UpdateService";
import type { UpdateInfo } from "../../shared/updateTypes";

const CHUNK = 4 * 1024 * 1024; // 4MB，与 UpdateService.CHUNK_SIZE 一致
const DEFAULT_HOST = "recall-update.ppclaw.online";
const EVIL_URL = "https://evil.example.com/payload";

// 安装包文件名与 UpdateService.downloadUpdate 的平台推导保持一致：
// - Windows：固定 .exe
// - 其余（macOS）：downloadUrl 以 .zip/.dmg 结尾则沿用，否则回退 .dmg；
//   本文件 makeInfo 默认 downloadUrl 在 macOS 上为 .dmg → 文件名 .dmg。
const INSTALLER_NAME =
  process.platform === "win32"
    ? "Recall-0.5.6-installer.exe"
    : "Recall-0.5.6-installer.dmg";

function sha256hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    hasUpdate: true,
    currentVersion: "0.5.5",
    latestVersion: "0.5.6",
    downloadUrl: "/download/Recall-0.5.6-installer.exe",
    sha256: "deadbeef",
    releaseNotes: "",
    publishedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
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

/**
 * 可用的 HEAD + Range 分片响应序列：
 * - HEAD → 200 + accept-ranges: bytes + content-length
 * - Range 请求 → 206，片内容由 fillByteFor(start) 生成（每片独立可辨识）
 */
function mockRangeServer(
  bytesTotal: number,
  fillByteFor: (chunkStart: number) => number,
): void {
  electronMocks.fetch.mockImplementation(
    (
      url: string,
      opts?: { method?: string; headers?: Record<string, string> },
    ) => {
      if (opts?.method === "HEAD") {
        return Promise.resolve(
          new Response(null, {
            status: 200,
            headers: {
              "accept-ranges": "bytes",
              "content-length": String(bytesTotal),
            },
          }),
        );
      }
      const m = /^bytes=(\d+)-(\d+)$/.exec(opts?.headers?.Range ?? "");
      if (!m) return Promise.resolve(new Response(null, { status: 400 }));
      const start = Number(m[1]);
      const end = Number(m[2]);
      const len = end - start + 1;
      return Promise.resolve(
        new Response(Buffer.alloc(len, fillByteFor(start)), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${bytesTotal}` },
        }),
      );
    },
  );
}

/** 收集所有带 Range 头的 fetch 调用及其 Range 值 */
function rangeRequests(): Array<{ url: string; range: string }> {
  return electronMocks.fetch.mock.calls
    .filter(([, opts]) => opts?.headers?.Range)
    .map(([url, opts]) => ({ url: url as string, range: opts.headers.Range as string }));
}

let updatesRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  updatesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "recall-update-svc-test-"));
  // getUpdatesDir() = app.getPath("userData")/updates
  electronMocks.getPath.mockReturnValue(updatesRoot);
  electronMocks.openPath.mockResolvedValue("");
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(updatesRoot, { recursive: true, force: true });
});

// ============================================================================
// ① Accept-Ranges 探测 + 分片下载拼接
// ============================================================================
describe("downloadUpdate：Range 分片下载", () => {
  it("HEAD 探测后 3 个 4MB 分片按序拼接，Range 头正确，进度逐片推送", async () => {
    const bytesTotal = 3 * CHUNK; // 12MB
    // 第 i 片（start=i*CHUNK）内容为全片字节 i+1，用于断言拼接顺序
    const expected = Buffer.concat([
      Buffer.alloc(CHUNK, 1),
      Buffer.alloc(CHUNK, 2),
      Buffer.alloc(CHUNK, 3),
    ]);
    mockRangeServer(bytesTotal, (start) => start / CHUNK + 1);

    const svc = createService();
    const onProgress = vi.fn();
    const installerPath = await svc.downloadUpdate(
      makeInfo({ sha256: sha256hex(expected) }),
      onProgress,
    );

    expect(installerPath).toBe(
      path.join(updatesRoot, "updates", INSTALLER_NAME),
    );
    const file = fs.readFileSync(installerPath);
    expect(file.length).toBe(bytesTotal);
    // 字节顺序：三片内容互不混淆
    expect(file.readUInt8(0)).toBe(1);
    expect(file.readUInt8(CHUNK)).toBe(2);
    expect(file.readUInt8(2 * CHUNK)).toBe(3);
    expect(file.readUInt8(CHUNK - 1)).toBe(1);
    expect(file.readUInt8(2 * CHUNK - 1)).toBe(2);

    // Range 头逐片正确（含 HEAD 探测在前）
    const ranges = rangeRequests();
    expect(ranges.map((r) => r.range)).toEqual([
      `bytes=0-${CHUNK - 1}`,
      `bytes=${CHUNK}-${2 * CHUNK - 1}`,
      `bytes=${2 * CHUNK}-${3 * CHUNK - 1}`,
    ]);
    expect(ranges.every((r) => r.url.startsWith(`https://${DEFAULT_HOST}`))).toBe(true);
    // HEAD 探测请求确实发出
    expect(
      electronMocks.fetch.mock.calls.some(
        ([, opts]) => opts?.method === "HEAD",
      ),
    ).toBe(true);

    // 进度回调逐片递增
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls.map((c) => c[0].bytesDownloaded)).toEqual([
      CHUNK,
      2 * CHUNK,
      3 * CHUNK,
    ]);

    // 临时文件清理 + 状态
    expect(svc.getStatus()).toMatchObject({ state: "downloaded" });
    const dir = fs.readdirSync(path.join(updatesRoot, "updates"));
    expect(dir).not.toContain(expect.stringMatching(/\.(part|meta\.json)$/));
  });

  it("单片少于 4MB（最后一片）也能正确收尾", async () => {
    const bytesTotal = CHUNK + 1; // 4MB + 1B
    const expected = Buffer.concat([Buffer.alloc(CHUNK, 7), Buffer.alloc(1, 8)]);
    mockRangeServer(bytesTotal, (start) => (start === 0 ? 7 : 8));

    const svc = createService();
    const installerPath = await svc.downloadUpdate(
      makeInfo({ sha256: sha256hex(expected) }),
      vi.fn(),
    );

    const file = fs.readFileSync(installerPath);
    expect(file.length).toBe(bytesTotal);
    expect(file.readUInt8(0)).toBe(7);
    expect(file.readUInt8(CHUNK)).toBe(8);
    expect(rangeRequests().map((r) => r.range)).toEqual([
      `bytes=0-${CHUNK - 1}`,
      `bytes=${CHUNK}-${CHUNK}`,
    ]);
  });
});

// ============================================================================
// ③ 断点续传
// ============================================================================
describe("downloadUpdate：断点续传", () => {
  it("已有 .part + .meta.json → 从记录偏移续传（Range 头从偏移开始，不重下已得片）", async () => {
    const bytesTotal = 2 * CHUNK; // 8MB
    const offset = CHUNK; // 已下载第一片
    const installerPath = path.join(
      updatesRoot,
      "updates",
      INSTALLER_NAME,
    );
    const partPath = installerPath + ".part";
    const metaPath = installerPath + ".meta.json";

    const expected = Buffer.alloc(bytesTotal, 0); // 两片均为零字节
    // 预置断点：.part 恰为 4MB，meta 记录 bytesDownloaded=4MB（sha256 必须与
    // info 一致，否则 readDownloadMeta 判定断点无效而整包重下）
    fs.mkdirSync(path.dirname(partPath), { recursive: true });
    fs.writeFileSync(partPath, Buffer.alloc(offset, 0));
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        version: "0.5.6",
        sha256: sha256hex(expected),
        bytesTotal,
        bytesDownloaded: offset,
        chunkSize: CHUNK,
        updatedAt: "2026-07-30T00:00:00.000Z",
      }),
    );
    mockRangeServer(bytesTotal, () => 0);

    const svc = createService();
    const result = await svc.downloadUpdate(
      makeInfo({ sha256: sha256hex(expected) }),
      vi.fn(),
    );

    expect(result).toBe(installerPath);
    // 只请求了第二片，且 Range 头从记录偏移开始
    const ranges = rangeRequests();
    expect(ranges).toHaveLength(1);
    expect(ranges[0].range).toBe(`bytes=${offset}-${bytesTotal - 1}`);
    // 续传结果完整
    expect(fs.readFileSync(installerPath).length).toBe(bytesTotal);
  });
});

// ============================================================================
// ② 单片超时重试
// ============================================================================
describe("downloadUpdate：单片超时重试", () => {
  // timeout 30s：假定时器驱动退避与轮次等待（6 轮 × 单片 31s 退避 ≈ 228s 假时间，
  // 真实耗时毫秒级）；即使某平台假定时器失效，30s 上限也留出兜底余量。
  it(
    "单片超时 → 单片 5 次尝试（退避）→ 6 轮耗尽后抛错",
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers();
      const bytesTotal = CHUNK;
      // HEAD 正常；分片请求立即以超时错误拒绝（等效于 30s 单片超时触发，
      // 不再依赖 30 个 AbortController 假定时器，macOS 上更稳健）
      electronMocks.fetch.mockImplementation(
        (url: string, opts?: { method?: string }) => {
          if (opts?.method === "HEAD") {
            return Promise.resolve(
              new Response(null, {
                status: 200,
                headers: {
                  "accept-ranges": "bytes",
                  "content-length": String(bytesTotal),
                },
              }),
            );
          }
          return Promise.reject(new Error("aborted: chunk timed out"));
        },
      );

      const svc = createService();
      const info = makeInfo({ sha256: sha256hex(Buffer.alloc(bytesTotal, 1)) });
      const promise = svc.downloadUpdate(info, vi.fn());
      // 先注册拒绝处理器（否则 runAllTimersAsync 期间已拒绝会触发
      // Node unhandled-rejection 告警），再推进假定时器
      const rejection = expect(promise).rejects.toThrow(/failed after 6 rounds/);
      promise.catch(() => {});

      await vi.runAllTimersAsync();
      await rejection;

      // 每轮该片尝试 5 次：6 轮 × 5 = 30 次 Range 请求（外加 1 次 HEAD）
      expect(rangeRequests()).toHaveLength(30);
      expect(electronMocks.fetch).toHaveBeenCalledTimes(31);
      expect(svc.getStatus()).toMatchObject({ state: "error", code: "download_failed" });
    },
  );
});

// ============================================================================
// ④ SHA256 校验失败
// ============================================================================
describe("downloadUpdate：SHA256 校验", () => {
  it("校验和不匹配 → 抛错、产物清理、安装器不启动（shell.openPath 未调用）", async () => {
    const bytesTotal = 1024 * 1024; // 1MB 单片
    mockRangeServer(bytesTotal, () => 0xab);

    const svc = createService();
    const installerPath = path.join(
      updatesRoot,
      "updates",
      INSTALLER_NAME,
    );

    await expect(
      svc.downloadUpdate(makeInfo({ sha256: "00".repeat(32) }), vi.fn()),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(svc.getStatus()).toMatchObject({ state: "error", code: "sha_mismatch" });

    // 产物全部清理：无 .exe / .part / .meta.json
    const dir = fs.readdirSync(path.join(updatesRoot, "updates"));
    expect(dir).toHaveLength(0);

    // 安装器不得启动
    await expect(svc.installAndQuit()).rejects.toThrow(/no installer downloaded/i);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(fs.existsSync(installerPath)).toBe(false);
  });
});

// ============================================================================
// ⑤ 非 Range 支持回退流式
// ============================================================================
describe("downloadUpdate：非 Range 服务器回退流式", () => {
  it("HEAD 无 accept-ranges → 流式下载成功，无 Range 头请求", async () => {
    const bytesTotal = 1024 * 1024;
    const content = Buffer.alloc(bytesTotal, 0x42);
    electronMocks.fetch.mockImplementation(
      (url: string, opts?: { method?: string }) => {
        if (opts?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, {
              status: 200,
              headers: {
                "accept-ranges": "none",
                "content-length": String(bytesTotal),
              },
            }),
          );
        }
        return Promise.resolve(
          new Response(content, {
            status: 200,
            headers: { "content-length": String(bytesTotal) },
          }),
        );
      },
    );

    const svc = createService();
    const onProgress = vi.fn();
    const installerPath = await svc.downloadUpdate(
      makeInfo({ sha256: sha256hex(content) }),
      onProgress,
    );

    expect(fs.readFileSync(installerPath).equals(content)).toBe(true);
    // 无任何 Range 请求
    expect(rangeRequests()).toHaveLength(0);
    // 无 .part 残留
    const dir = fs.readdirSync(path.join(updatesRoot, "updates"));
    expect(dir).not.toContain(expect.stringMatching(/\.part$/));
    // 进度上报 100%
    expect(onProgress.mock.calls.at(-1)?.[0].percent).toBe(100);
  });
});

// ============================================================================
// ⑥ 主机白名单（todo 6 已合入：直接引用正式函数）
// ============================================================================
describe("downloadUpdate：主机白名单接线", () => {
  it("downloadUrl 指向非允许 host → 拒绝且不发起下载（复用 isAllowedUpdateHost）", async () => {
    expect(isAllowedUpdateHost(`https://${DEFAULT_HOST}/download/latest`)).toBe(true);
    expect(isAllowedUpdateHost(EVIL_URL)).toBe(false);

    const svc = createService();
    await expect(svc.downloadUpdate(makeInfo({ downloadUrl: EVIL_URL }), vi.fn()))
      .rejects.toThrow(/host not allowed/);
    expect(electronMocks.fetch).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: "error", code: "host_not_allowed" });
  });
});

// ============================================================================
// ⑦ installAndQuit
// ============================================================================
describe("installAndQuit", () => {
  it("未下载任何安装包 → 抛错，shell.openPath 未被调用", async () => {
    const svc = createService();
    await expect(svc.installAndQuit()).rejects.toThrow(/no installer downloaded/i);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({ state: "error", code: "installer_missing" });
  });

  it("成功下载后 → 使用内部 lastInstallerPath 启动安装器（按平台分支断言）", async () => {
    const bytesTotal = 1024 * 1024;
    const content = Buffer.alloc(bytesTotal, 0x33);
    mockRangeServer(bytesTotal, () => 0x33);

    const svc = createService();
    const installerPath = await svc.downloadUpdate(
      makeInfo({ sha256: sha256hex(content) }),
      vi.fn(),
    );

    await svc.installAndQuit();

    if (process.platform === "darwin") {
      // macOS：spawn("open") 挂载 DMG，不立即 app.quit（等用户拖拽完成安装）
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith("open", [installerPath], { stdio: "ignore" });
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(electronMocks.quit).not.toHaveBeenCalled();
    } else {
      expect(shell.openPath).toHaveBeenCalledTimes(1);
      expect(shell.openPath).toHaveBeenCalledWith(installerPath);
      expect(electronMocks.quit).toHaveBeenCalledTimes(1);
    }
  });

  it("isInsideUpdatesDir 兜底：目录外路径 → 拒绝且不启动", async () => {
    // 直接构造：绕过 downloadUpdate 把 lastInstallerPath 指向外部路径
    const outside = path.join(updatesRoot, "evil.exe");
    fs.writeFileSync(outside, "x");
    const svc = createService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).lastInstallerPath = outside;

    await expect(svc.installAndQuit()).rejects.toThrow(/outside the updates directory/i);
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(svc.getStatus()).toMatchObject({
      state: "error",
      code: "installer_path_rejected",
    });
  });
});

describe("isInsideUpdatesDir", () => {
  it("updates 目录内 → true；目录外 / 不存在 → false", () => {
    const dir = path.join(updatesRoot, "updates");
    fs.mkdirSync(dir, { recursive: true });
    const inside = path.join(dir, "inside.exe");
    fs.writeFileSync(inside, "x");
    const outside = path.join(updatesRoot, "outside.exe");
    fs.writeFileSync(outside, "x");

    expect(isInsideUpdatesDir(inside)).toBe(true);
    expect(isInsideUpdatesDir(outside)).toBe(false);
    expect(isInsideUpdatesDir(path.join(dir, "nope.exe"))).toBe(false);
  });
});

// ============================================================================
// 附加：checkForUpdates / 状态管理 / 清理（补足服务函数覆盖率）
// ============================================================================
describe("checkForUpdates", () => {
  function mockCheckResponse(hasUpdate: boolean): void {
    electronMocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          hasUpdate,
          currentVersion: "0.5.6",
          latestVersion: "0.5.6",
    downloadUrl:
      process.platform === "win32"
        ? "/download/Recall-0.5.6-installer.exe"
        : "/download/Recall-0.5.6-installer.dmg",
          sha256: "abc123",
          releaseNotes: "notes",
          publishedAt: "2026-01-02T00:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
  }

  it("返回 hasUpdate 信息并持久化检查结果", async () => {
    mockCheckResponse(true);
    const setUpdateSettings = vi.fn();
    const svc = new UpdateService({
      settingsService: {
        getAll: () => ({ update: null }),
        setUpdateSettings,
      } as never,
    });

    const info = await svc.checkForUpdates();

    expect(info.hasUpdate).toBe(true);
    expect(info.latestVersion).toBe("0.5.6");
    expect(svc.getStatus()).toMatchObject({ state: "hasUpdate" });
    expect(setUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: "0.5.6" }),
    );
    expect(svc.getLastCheckInfo()).toBe(info);
  });

  it("已被忽略的版本不触发 hasUpdate", async () => {
    mockCheckResponse(true);
    const svc = new UpdateService({
      settingsService: {
        getAll: () => ({
          update: { dismissedVersion: "0.5.6" },
        }),
        setUpdateSettings: vi.fn(),
      } as never,
    });

    const info = await svc.checkForUpdates();

    expect(info.hasUpdate).toBe(false);
    expect(svc.getStatus()).toMatchObject({ state: "noUpdate" });
  });
});

describe("状态管理与清理", () => {
  it("dismissVersion 持久化，忽略当前最新版本时回到 idle", async () => {
    const setUpdateSettings = vi.fn();
    const svc = new UpdateService({
      settingsService: {
        getAll: () => ({ update: null }),
        setUpdateSettings,
      } as never,
    });

    svc.dismissVersion("9.9.9");
    expect(setUpdateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ dismissedVersion: "9.9.9" }),
    );

    // 走 checkForUpdates 置 hasUpdate 后忽略该版本 → idle
    electronMocks.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          hasUpdate: true,
          latestVersion: "0.5.6",
          downloadUrl: "/download/x.exe",
          sha256: "abc",
          releaseNotes: "",
          publishedAt: "2026-01-01T00:00:00.000Z",
        }),
        { status: 200 },
      ),
    );
    await svc.checkForUpdates();
    expect(svc.getStatus()).toMatchObject({ state: "hasUpdate" });

    svc.dismissVersion("0.5.6");
    expect(svc.getStatus()).toMatchObject({ state: "idle" });
  });

  it("cleanupIncompleteDownloads 删除 .tmp 但保留 .part/.meta.json", () => {
    const dir = path.join(updatesRoot, "updates");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "half.tmp"), "x");
    fs.writeFileSync(path.join(dir, "keep.part"), "y");
    fs.writeFileSync(path.join(dir, "keep.meta.json"), "{}");

    const svc = createService();
    svc.cleanupIncompleteDownloads();

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(["keep.meta.json", "keep.part"]);
  });
});
