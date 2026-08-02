// src/main/services/UpdateService.ts
// 版本更新服务
//
// 职责：
// - checkForUpdates: 调用 CF Worker /api/check 检查新版本
// - downloadUpdate: net.fetch 流式下载安装包到本地，校验 SHA256
// - installAndQuit: shell.openPath 启动 NSIS 安装程序并退出当前应用
// - pingStats: 上报版本统计（fire-and-forget）
// - dismissVersion: 标记忽略某版本
//
// 网络层用 net.fetch（Electron 32 自带，自动跟随系统代理）
// 下载路径：app.getPath("userData")/updates/Recall-{version}-setup.exe

import { app, net, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { logger } from "./Logger";
import type { SettingsService } from "./SettingsService";
import type {
  UpdateInfo,
  DownloadProgress,
  UpdateStatus,
  UpdateSettings,
} from "../../shared/updateTypes";

/**
 * CF Worker URL
 * - 生产环境通过 RECALL_UPDATE_WORKER_URL 环境变量覆盖
 * - 默认指向已绑定的自定义域名（国内可访问）
 */
const UPDATE_WORKER_URL =
  process.env.RECALL_UPDATE_WORKER_URL || "https://recall-update.ppclaw.online";

/**
 * 更新下载 host 白名单（P1，见 .omo/plans/codebase-audit.md todo 6）
 *
 * 允许集合：
 * - 默认 UPDATE_WORKER_URL 的 host：recall-update.ppclaw.online
 *   （与上方 UPDATE_WORKER_URL 默认值保持同步，改动需两处一致）
 * - 通过 RECALL_UPDATE_WORKER_URL 配置的 worker host（与默认不同时追加）
 *
 * 其余一律拒绝（fail-closed）；URL 无法解析返回 false，不抛出。
 * 相对路径（如 "/download/x"）由调用方先拼接为完整 URL 再校验——本函数
 * 只接受绝对 URL。
 */
const DEFAULT_UPDATE_HOST = "recall-update.ppclaw.online";

function parseUpdateHost(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

const ALLOWED_UPDATE_HOSTS: ReadonlySet<string> = (() => {
  const hosts = new Set<string>([DEFAULT_UPDATE_HOST]);
  const configured = parseUpdateHost(UPDATE_WORKER_URL);
  if (configured) hosts.add(configured);
  return hosts;
})();

/**
 * 校验更新下载 URL 的 host 是否在允许集合内
 * - 仅允许默认 worker host 与配置的 UPDATE_WORKER_URL host
 * - 无法解析的 URL（含裸相对路径）一律返回 false
 */
export function isAllowedUpdateHost(url: string): boolean {
  const host = parseUpdateHost(url);
  return host !== null && ALLOWED_UPDATE_HOSTS.has(host);
}

/** 提取 host 用于错误信息/日志——只记 host，绝不记完整 URL（防敏感路径泄漏） */
function hostOf(url: string): string {
  return parseUpdateHost(url) ?? "unknown";
}

/**
 * 下载目录：与 logs/ 同级
 */
function getUpdatesDir(): string {
  const dir = path.join(app.getPath("userData"), "updates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 版本比较（与 CF Worker 端实现一致）
 * - 解析 "x.y.z" 为 [major, minor, patch]
 * - 容错：忽略 "v" 前缀，缺失段视为 0
 */
function parseVersion(v: string): [number, number, number] {
  const clean = v.replace(/^v/i, "").trim();
  const parts = clean.split(".");
  const major = Number.parseInt(parts[0] ?? "0", 10) || 0;
  const minor = Number.parseInt(parts[1] ?? "0", 10) || 0;
  const patch = Number.parseInt(parts[2] ?? "0", 10) || 0;
  return [major, minor, patch];
}

function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMaj, aMin, aPat] = parseVersion(a);
  const [bMaj, bMin, bPat] = parseVersion(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  return 0;
}

/**
 * 计算文件 SHA256
 */
function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ============================================================================
// 分片 + 断点续传下载相关
// ============================================================================
//
// 国内访问 Cloudflare R2 下载大文件（180MB+）易中断，单次流式下载失败率高。
// 采用 Range 请求分片下载 + 断点续传：
//   - 每片 4MB
//   - 单片超时 30s 自动重试
//   - 单片最多重试 5 次，退避 1s/2s/4s/8s/16s
//   - 中断后下次启动从断点继续
//
// 文件布局：
//   updates/Recall-{version}-setup.exe          最终安装包
//   updates/Recall-{version}-setup.exe.part     下载中的分片合并文件
//   updates/Recall-{version}-setup.exe.meta.json 断点续传元数据
//
// 元数据格式：
//   {
//     "version": "0.5.5",
//     "sha256": "abc...",
//     "bytesTotal": 193981440,
//     "bytesDownloaded": 8388608,
//     "chunkSize": 4194304,
//     "updatedAt": "2026-07-30T...Z"
//   }

/** 单片大小：4MB */
const CHUNK_SIZE = 4 * 1024 * 1024;
/** 单片超时：30 秒 */
const CHUNK_TIMEOUT_MS = 30_000;
/** 单片最大重试次数（含首次） */
const CHUNK_MAX_ATTEMPTS = 5;
/** 单片重试退避（毫秒）：1s/2s/4s/8s/16s */
const CHUNK_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
/** 整体下载最大重试轮次（每轮从断点继续） */
const DOWNLOAD_MAX_ROUNDS = 6;

interface DownloadMeta {
  version: string;
  sha256: string;
  bytesTotal: number;
  bytesDownloaded: number;
  chunkSize: number;
  updatedAt: string;
}

/**
 * 读取断点续传元数据
 * - .part 和 .meta.json 必须同时存在才有效
 * - 元数据中的 sha256/version 必须与当前 info 匹配
 */
function readDownloadMeta(
  partPath: string,
  metaPath: string,
  info: UpdateInfo
): DownloadMeta | null {
  if (!fs.existsSync(partPath) || !fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const meta = JSON.parse(raw) as DownloadMeta;
    // 校验元数据与当前 info 一致，避免不同版本/不同 SHA 的断点被误用
    if (meta.version !== info.latestVersion) return null;
    if (meta.sha256 !== info.sha256) return null;
    if (meta.chunkSize !== CHUNK_SIZE) return null;
    if (!Number.isFinite(meta.bytesTotal) || meta.bytesTotal <= 0) return null;
    if (!Number.isFinite(meta.bytesDownloaded) || meta.bytesDownloaded < 0) return null;
    if (meta.bytesDownloaded > meta.bytesTotal) return null;
    // 校验 .part 文件实际大小与元数据一致
    const actualSize = fs.statSync(partPath).size;
    if (actualSize !== meta.bytesDownloaded) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * 写入断点续传元数据
 */
function writeDownloadMeta(metaPath: string, meta: DownloadMeta): void {
  const payload: DownloadMeta = { ...meta, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2), "utf8");
}

/**
 * 删除断点续传的临时文件（.part + .meta.json）
 */
function removeDownloadPartFiles(partPath: string, metaPath: string): void {
  try {
    if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
  } catch {
    // 忽略
  }
  try {
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {
    // 忽略
  }
}

/**
 * 下载单个分片（带超时保护）
 * - 使用 Range 请求 [start, end)
 * - AbortController 控制单片超时
 * - 返回该片的 Buffer
 */
async function downloadChunkWithTimeout(
  url: string,
  start: number,
  end: number,
  timeoutMs: number
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await net.fetch(url, {
      headers: {
        Range: `bytes=${start}-${end - 1}`,
        Accept: "application/octet-stream",
      },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`chunk HTTP ${response.status} ${response.statusText}`);
    }
    // 206 Partial Content 才是正常分片响应；200 表示服务器忽略了 Range
    if (response.status !== 206) {
      throw new Error(`unexpected chunk status ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateServiceDeps {
  settingsService: SettingsService;
}

/**
 * 校验绝对路径位于 updates 目录内（含符号链接逃逸防御）
 *
 * P0 安全兜底：installAndQuit 只允许启动本服务下载的安装包。
 * - 通过 realpathSync 解析真实路径后比较，符号链接指向目录外（如指向系统
 *   目录/任意文件）时 realpath 会落到 updates 目录之外 → 拒绝
 * - 目标不存在或解析失败一律拒绝（fail-closed）
 */
export function isInsideUpdatesDir(absPath: string): boolean {
  try {
    const updatesReal = fs.realpathSync(getUpdatesDir());
    const targetReal = fs.realpathSync(absPath);
    const relative = path.relative(updatesReal, targetReal);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

export class UpdateService {
  private status: UpdateStatus = { state: "idle" };
  private lastCheckInfo: UpdateInfo | null = null;
  /**
   * 最近一次成功下载（SHA256 校验通过）的安装包路径。
   * 仅由 downloadUpdate 写入，installAndQuit 只信任此内部路径——
   * 渲染层无法通过 IPC 输入影响它（契约已拒绝 installerPath 字段）。
   */
  private lastInstallerPath: string | null = null;

  constructor(private deps: UpdateServiceDeps) {}

  /**
   * 检查更新
   * - 调用 CF Worker /api/check?currentVersion=x
   * - 成功后持久化 lastCheckedAt / latestVersion 到 settings.json
   * - 被忽略的版本（dismissedVersion）不触发 hasUpdate
   */
  async checkForUpdates(): Promise<UpdateInfo> {
    // 状态守卫：下载/安装中不允许检查
    if (this.status.state === "downloading" || this.status.state === "installing") {
      throw new Error(`cannot check while ${this.status.state}`);
    }

    this.status = { state: "checking" };
    const currentVersion = app.getVersion();

    try {
      const platform = process.platform === "darwin" ? "darwin" : "win";
      const params = new URLSearchParams({ currentVersion, platform });
      if (platform === "darwin") {
        params.set("arch", process.arch === "arm64" ? "arm64" : "x64");
      }
      const url = `${UPDATE_WORKER_URL}/api/check?${params.toString()}`;
      const response = await net.fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Client-Version": currentVersion,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as {
        hasUpdate: boolean;
        currentVersion: string;
        latestVersion: string;
        downloadUrl: string;
        sha256: string;
        releaseNotes: string;
        publishedAt: string;
      };

      const info: UpdateInfo = {
        hasUpdate: data.hasUpdate,
        currentVersion: data.currentVersion ?? currentVersion,
        latestVersion: data.latestVersion,
        downloadUrl: data.downloadUrl,
        sha256: data.sha256,
        releaseNotes: data.releaseNotes ?? "",
        publishedAt: data.publishedAt ?? new Date().toISOString(),
      };

      // 检查是否被用户忽略
      const settings = this.deps.settingsService.getAll();
      const dismissed = settings.update?.dismissedVersion;
      if (
        info.hasUpdate &&
        dismissed &&
        compareVersions(info.latestVersion, dismissed) <= 0
      ) {
        // 最新版本已被忽略，不视为有更新
        info.hasUpdate = false;
      }

      this.lastCheckInfo = info;

      if (info.hasUpdate) {
        this.status = { state: "hasUpdate", info };
      } else {
        this.status = { state: "noUpdate", info };
      }

      // 持久化检查结果
      this.persistUpdateSettings({
        lastCheckedAt: new Date().toISOString(),
        latestVersion: info.latestVersion,
      });

      logger.info({
        jobType: "update_check",
        status: "succeeded",
        message: `hasUpdate=${info.hasUpdate}, latest=${info.latestVersion}, current=${currentVersion}`,
      });

      return info;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: "error", message, code: "check_failed" };
      logger.warn({
        jobType: "update_check",
        status: "failed",
        errorCode: "check_failed",
        message,
      });
      throw err;
    }
  }

  /**
   * 下载更新（分片 + 断点续传）
   *
   * 策略：
   * 1. 若最终安装包已存在且 SHA256 匹配 → 直接复用
   * 2. HEAD 请求探测服务器是否支持 Range（Accept-Ranges: bytes）
   *    - 支持 → 分片下载（每片 4MB，单片超时 30s，单片重试 5 次）
   *    - 不支持 → 回退到原流式下载（最多 3 次重试）
   * 3. 分片下载支持断点续传：.part + .meta.json 记录进度，中断后下次从断点继续
   * 4. 下载完成后整体校验 SHA256，不匹配则删除所有临时文件并失败
   *
   * @param info 更新信息
   * @param onProgress 进度回调
   */
  async downloadUpdate(
    info: UpdateInfo,
    onProgress: (p: DownloadProgress) => void
  ): Promise<string> {
    if (this.status.state === "downloading" || this.status.state === "installing") {
      throw new Error(`cannot download while ${this.status.state}`);
    }

    const updatesDir = getUpdatesDir();
    // 文件扩展名按平台 + downloadUrl 推断：
    // - Windows: NSIS 安装包，固定 .exe
    // - macOS: electron-builder 产物可能是 .dmg 或 .zip；优先从 downloadUrl 推断，
    //   缺省回退 .dmg（与 electron-builder mac dmg target 一致）
    const isWin = process.platform === "win32";
    let ext: string;
    if (isWin) {
      ext = ".exe";
    } else {
      const urlLower = info.downloadUrl.toLowerCase();
      if (urlLower.endsWith(".zip")) {
        ext = ".zip";
      } else if (urlLower.endsWith(".dmg")) {
        ext = ".dmg";
      } else {
        ext = ".dmg";
      }
    }
    const installerPath = path.join(
      updatesDir,
      `Recall-${info.latestVersion}-installer${ext}`
    );
    const partPath = installerPath + ".part";
    const metaPath = installerPath + ".meta.json";

    // 1. 已下载过且 SHA256 匹配则直接复用
    if (fs.existsSync(installerPath)) {
      const existingSha = await computeFileSha256(installerPath);
      if (existingSha === info.sha256) {
        this.lastInstallerPath = installerPath;
        this.status = { state: "downloaded", installerPath, info };
        logger.info({
          jobType: "update_download",
          status: "succeeded",
          message: `reused existing installer: ${installerPath}`,
        });
        return installerPath;
      }
      // SHA 不匹配则删除旧文件
      fs.unlinkSync(installerPath);
    }

    this.status = {
      state: "downloading",
      progress: { bytesDownloaded: 0, bytesTotal: 0, percent: 0 },
    };

    const fullUrl = info.downloadUrl.startsWith("http")
      ? info.downloadUrl
      : `${UPDATE_WORKER_URL}${info.downloadUrl}`;

    // P1 主机白名单：相对路径已解析到允许的 worker 上，绝对 URL 必须落在
    // 允许 host 集合内；拒绝时只报/只记 host，绝不记录完整 URL。
    if (!isAllowedUpdateHost(fullUrl)) {
      const host = hostOf(fullUrl);
      this.status = {
        state: "error",
        message: `download host not allowed: ${host}`,
        code: "host_not_allowed",
      };
      logger.error({
        jobType: "update_download",
        status: "failed",
        errorCode: "host_not_allowed",
        message: `download host not allowed: ${host}`,
      });
      throw new Error(`download host not allowed: ${host}`);
    }

    // 2. HEAD 探测是否支持 Range 请求
    let supportsRange = false;
    let bytesTotalFromHead = 0;
    try {
      const headResp = await net.fetch(fullUrl, { method: "HEAD" });
      if (headResp.ok) {
        const acceptRanges = headResp.headers.get("accept-ranges");
        const contentLength = headResp.headers.get("content-length");
        supportsRange = acceptRanges !== null && /bytes/i.test(acceptRanges);
        bytesTotalFromHead =
          Number.parseInt(contentLength ?? "0", 10) || 0;
      }
    } catch (err) {
      // HEAD 失败不致命，回退到流式下载
      logger.warn({
        jobType: "update_download",
        status: "started",
        errorCode: "head_probe_failed",
        message: `HEAD probe failed, fallback to stream: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // 3. 分支：分片下载 / 流式下载
    try {
      if (supportsRange && bytesTotalFromHead > 0) {
        await this.downloadWithRanges(
          fullUrl,
          installerPath,
          partPath,
          metaPath,
          info,
          bytesTotalFromHead,
          onProgress
        );
      } else {
        await this.downloadAsStream(
          fullUrl,
          installerPath,
          partPath,
          metaPath,
          info,
          onProgress
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { state: "error", message, code: "download_failed" };
      logger.error({
        jobType: "update_download",
        status: "failed",
        errorCode: "download_failed",
        message,
      });
      throw err;
    }

    // 4. 校验最终文件 SHA256
    const actualSha = await computeFileSha256(installerPath);
    if (actualSha !== info.sha256) {
      // SHA 不匹配，清理所有产物
      removeDownloadPartFiles(partPath, metaPath);
      try {
        if (fs.existsSync(installerPath)) fs.unlinkSync(installerPath);
      } catch {
        // 忽略
      }
      const message = `sha256 mismatch: expected ${info.sha256}, got ${actualSha}`;
      this.status = { state: "error", message, code: "sha_mismatch" };
      logger.error({
        jobType: "update_download",
        status: "failed",
        errorCode: "sha_mismatch",
        message,
      });
      throw new Error(message);
    }

    this.lastInstallerPath = installerPath;
    this.status = { state: "downloaded", installerPath, info };
    this.persistUpdateSettings({ downloadedInstallerPath: installerPath });
    logger.info({
      jobType: "update_download",
      status: "succeeded",
      message: `downloaded: ${installerPath}`,
    });

    return installerPath;
  }

  /**
   * 分片 + 断点续传下载
   *
   * - 每片 CHUNK_SIZE（4MB）
   * - 单片超时 CHUNK_TIMEOUT_MS（30s），超时自动重试
   * - 单片重试 CHUNK_MAX_ATTEMPTS（5 次），退避 1s/2s/4s/8s/16s
   * - 整体最多 DOWNLOAD_MAX_ROUNDS（6 轮），每轮从断点继续
   * - 每片下载成功后立即追加写入 .part 并更新 .meta.json
   */
  private async downloadWithRanges(
    fullUrl: string,
    installerPath: string,
    partPath: string,
    metaPath: string,
    info: UpdateInfo,
    bytesTotal: number,
    onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    // 读取断点续传元数据
    let meta = readDownloadMeta(partPath, metaPath, info);
    if (meta && meta.bytesTotal !== bytesTotal) {
      // 服务器返回的总大小与元数据不一致，丢弃断点重下
      removeDownloadPartFiles(partPath, metaPath);
      meta = null;
    }
    if (!meta) {
      // 全新下载：创建空的 .part 文件
      meta = {
        version: info.latestVersion,
        sha256: info.sha256,
        bytesTotal,
        bytesDownloaded: 0,
        chunkSize: CHUNK_SIZE,
        updatedAt: new Date().toISOString(),
      };
      // 截断/创建 .part 文件
      const fd = fs.openSync(partPath, "w");
      fs.closeSync(fd);
      writeDownloadMeta(metaPath, meta);
    }

    // 以 append 模式打开 .part 文件，每片下载后追加
    const totalRounds = DOWNLOAD_MAX_ROUNDS;
    let consecutiveChunkFailures = 0;
    const MAX_CONSECUTIVE_CHUNK_FAILURES = CHUNK_MAX_ATTEMPTS * 4; // 多片连续失败兜底

    for (let round = 1; round <= totalRounds; round++) {
      // 读取最新进度（断点续传可能从上次中断处继续）
      const currentMeta = readDownloadMeta(partPath, metaPath, info);
      if (!currentMeta) {
        throw new Error("download meta lost during download");
      }
      let bytesDownloaded = currentMeta.bytesDownloaded;

      if (bytesDownloaded >= bytesTotal) {
        // 已下载完成
        break;
      }

      if (round > 1) {
        logger.info({
          jobType: "update_download",
          status: "started",
          errorCode: "resume_round",
          message: `round ${round}: resuming from ${bytesDownloaded}/${bytesTotal} bytes (${Math.round((bytesDownloaded / bytesTotal) * 100)}%)`,
        });
      }

      // 顺序下载剩余分片
      const writer = fs.createWriteStream(partPath, { flags: "r+", start: bytesDownloaded });

      try {
        while (bytesDownloaded < bytesTotal) {
          const chunkStart = bytesDownloaded;
          const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, bytesTotal);
          const chunkSize = chunkEnd - chunkStart;

          let chunkBuffer: Buffer | null = null;
          let lastChunkErr: unknown = null;

          // 单片重试
          for (let attempt = 1; attempt <= CHUNK_MAX_ATTEMPTS; attempt++) {
            try {
              chunkBuffer = await downloadChunkWithTimeout(
                fullUrl,
                chunkStart,
                chunkEnd,
                CHUNK_TIMEOUT_MS
              );
              if (chunkBuffer.length !== chunkSize) {
                throw new Error(
                  `chunk size mismatch: expected ${chunkSize}, got ${chunkBuffer.length}`
                );
              }
              lastChunkErr = null;
              break;
            } catch (err) {
              lastChunkErr = err;
              if (attempt < CHUNK_MAX_ATTEMPTS) {
                const backoff = CHUNK_BACKOFF_MS[attempt - 1] ?? 1000;
                logger.warn({
                  jobType: "update_download",
                  status: "started",
                  errorCode: "chunk_retry",
                  message: `chunk [${chunkStart},${chunkEnd}) attempt ${attempt}/${CHUNK_MAX_ATTEMPTS} failed, retry in ${backoff}ms: ${err instanceof Error ? err.message : String(err)}`,
                });
                await new Promise((r) => setTimeout(r, backoff));
              }
            }
          }

          if (chunkBuffer === null || lastChunkErr) {
            // 单片重试用尽，关闭 writer，进入下一轮断点续传
            consecutiveChunkFailures++;
            const message = `chunk [${chunkStart},${chunkEnd}) failed after ${CHUNK_MAX_ATTEMPTS} attempts: ${lastChunkErr instanceof Error ? lastChunkErr.message : String(lastChunkErr)}`;
            logger.warn({
              jobType: "update_download",
              status: "started",
              errorCode: "chunk_exhausted",
              message,
            });
            break;
          }

          consecutiveChunkFailures = 0;
          writer.write(chunkBuffer);
          bytesDownloaded = chunkEnd;

          // 更新元数据
          const updatedMeta: DownloadMeta = {
            version: info.latestVersion,
            sha256: info.sha256,
            bytesTotal,
            bytesDownloaded,
            chunkSize: CHUNK_SIZE,
            updatedAt: new Date().toISOString(),
          };
          writeDownloadMeta(metaPath, updatedMeta);

          // 推送进度
          const percent = Math.round((bytesDownloaded / bytesTotal) * 100);
          const progress: DownloadProgress = { bytesDownloaded, bytesTotal, percent };
          if (this.status.state === "downloading") {
            this.status = { state: "downloading", progress };
          }
          onProgress(progress);
        }

        // flush writer
        await new Promise<void>((resolve, reject) => {
          writer.end(() => resolve());
          writer.on("error", reject);
        });

        if (bytesDownloaded >= bytesTotal) {
          // 下载完成，重命名 .part → 最终文件
          fs.renameSync(partPath, installerPath);
          // part 已被 rename 不存在，removeDownloadPartFiles 会安全跳过；
          // 只需清理 meta.json
          removeDownloadPartFiles(partPath, metaPath);
          return;
        }

        // 本轮未完成，检查是否连续失败过多
        if (consecutiveChunkFailures >= MAX_CONSECUTIVE_CHUNK_FAILURES) {
          throw new Error(
            `download aborted: ${consecutiveChunkFailures} consecutive chunk failures`
          );
        }

        // 进入下一轮断点续传前等待
        if (round < totalRounds) {
          const roundBackoff = 2000 * round;
          logger.warn({
            jobType: "update_download",
            status: "started",
            errorCode: "round_backoff",
            message: `round ${round} incomplete (${bytesDownloaded}/${bytesTotal}), waiting ${roundBackoff}ms before next round`,
          });
          await new Promise((r) => setTimeout(r, roundBackoff));
        }
      } finally {
        // 确保 writer 关闭（异常路径）
        try {
          writer.destroy();
        } catch {
          // 忽略
        }
      }
    }

    // 所有轮次用尽
    const finalMeta = readDownloadMeta(partPath, metaPath, info);
    const downloaded = finalMeta?.bytesDownloaded ?? 0;
    throw new Error(
      `download failed after ${totalRounds} rounds: ${downloaded}/${bytesTotal} bytes`
    );
  }

  /**
   * 流式下载（回退方案，服务器不支持 Range 时使用）
   *
   * - 单次 net.fetch 流式下载到 .tmp
   * - 失败重试最多 3 次（退避 1s/2s/4s），每次从头开始
   * - 下载完成后重命名 .tmp → 最终文件
   */
  private async downloadAsStream(
    fullUrl: string,
    installerPath: string,
    partPath: string,
    metaPath: string,
    info: UpdateInfo,
    onProgress: (p: DownloadProgress) => void
  ): Promise<void> {
    // 清理可能残留的断点续传文件
    removeDownloadPartFiles(partPath, metaPath);

    const tmpPath = installerPath + ".tmp";
    const maxAttempts = 3;
    const backoffMs = [1000, 2000, 4000];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await net.fetch(fullUrl);
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const bytesTotal =
          Number.parseInt(response.headers.get("content-length") ?? "0", 10) || 0;
        const writer = fs.createWriteStream(tmpPath);

        let bytesDownloaded = 0;
        const reader = response.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(Buffer.from(value));
          bytesDownloaded += value.byteLength;
          const percent =
            bytesTotal > 0 ? Math.round((bytesDownloaded / bytesTotal) * 100) : 0;
          const progress: DownloadProgress = { bytesDownloaded, bytesTotal, percent };
          if (this.status.state === "downloading") {
            this.status = { state: "downloading", progress };
          }
          onProgress(progress);
        }

        await new Promise<void>((resolve, reject) => {
          writer.end(() => resolve());
          writer.on("error", reject);
        });

        fs.renameSync(tmpPath, installerPath);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // 忽略清理失败
        }

        if (attempt >= maxAttempts) {
          throw err;
        }

        logger.warn({
          jobType: "update_download",
          status: "started",
          errorCode: "stream_retry",
          message: `stream attempt ${attempt} failed, retry in ${backoffMs[attempt - 1]}ms: ${message}`,
        });

        await new Promise((r) => setTimeout(r, backoffMs[attempt - 1]));
      }
    }

    throw new Error("stream download failed: max attempts reached");
  }

  /**
   * 启动安装程序并退出当前应用
   *
   * 平台差异：
   * - Windows：shell.openPath 触发 NSIS 安装向导（oneClick=false 配置）
   * - macOS：electron-builder 产物是 .dmg / .zip，没有 NSIS 那种"自动覆盖安装"流程。
   *   - .dmg：用 `open` 挂载，Finder 会弹出窗口显示 Recall.app + Applications 文件夹快捷方式，
   *     用户拖拽完成安装（mac 应用分发的标准交互）
   *   - .zip：用 `open` 在 Finder 中打开所在目录，提示用户手动解压拖拽
   *   - 安装需要用户手动操作，所以这里只挂载/打开，不立即 app.quit()，
   *     让用户先完成拖拽再手动退出 Recall（避免用户拖拽时源 app 已退出导致困惑）
   */
  async installAndQuit(): Promise<void> {
    this.status = { state: "installing" };

    // P0：只允许启动本服务成功下载（SHA256 校验通过）的安装包，
    // 渲染层无法提供路径——契约已拒绝 installerPath 字段，这里做运行时兜底。
    const installerPath = this.lastInstallerPath;
    if (!installerPath) {
      this.status = {
        state: "error",
        message: "no installer downloaded",
        code: "installer_missing",
      };
      logger.error({
        jobType: "update_install",
        status: "failed",
        errorCode: "installer_missing",
        message: "installAndQuit called before any successful download",
      });
      throw new Error("no installer downloaded");
    }

    if (!isInsideUpdatesDir(installerPath)) {
      this.status = {
        state: "error",
        message: "installer path outside the updates directory",
        code: "installer_path_rejected",
      };
      logger.error({
        jobType: "update_install",
        status: "failed",
        errorCode: "installer_path_rejected",
        message: `installer path rejected: ${installerPath}`,
      });
      throw new Error(`installer path outside the updates directory: ${installerPath}`);
    }

    if (!fs.existsSync(installerPath)) {
      this.status = {
        state: "error",
        message: "installer not found",
        code: "installer_missing",
      };
      logger.error({
        jobType: "update_install",
        status: "failed",
        errorCode: "installer_missing",
        message: `installer not found: ${installerPath}`,
      });
      throw new Error(`installer not found: ${installerPath}`);
    }

    logger.info({
      jobType: "update_install",
      status: "started",
      message: `launching installer: ${installerPath}`,
    });

    const isMac = process.platform === "darwin";

    if (isMac) {
      // macOS：DMG 挂载 / ZIP 在 Finder 中打开
      const ext = path.extname(installerPath).toLowerCase();
      try {
        if (ext === ".dmg") {
          // open 命令挂载 DMG，Finder 自动弹出拖拽窗口
          await this.spawnAsync("open", [installerPath]);
          logger.info({
            jobType: "update_install",
            status: "succeeded",
            message: `DMG mounted: ${installerPath}，请将 Recall.app 拖到 Applications 文件夹完成安装`,
          });
        } else {
          // .zip 或其他：在 Finder 中打开所在目录，让用户手动解压拖拽
          await this.spawnAsync("open", ["-R", installerPath]);
          logger.info({
            jobType: "update_install",
            status: "succeeded",
            message: `installer revealed in Finder: ${installerPath}，请手动解压并拖到 Applications`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.status = {
          state: "error",
          message,
          code: "installer_launch_failed",
        };
        logger.error({
          jobType: "update_install",
          status: "failed",
          errorCode: "installer_launch_failed",
          message,
        });
        throw new Error(`failed to launch installer: ${message}`);
      }

      // macOS 不立即退出：用户需要在 Recall 仍在运行时完成拖拽安装，
      // 新版本 .app 覆盖 /Applications/Recall.app 后，下次启动自然就是新版。
      // 如果立即 quit，用户拖拽时 Recall 主窗口已消失，体验更困惑。
      // 状态保持 "installing"：语义上安装确实在进行（等待用户拖拽），
      // UI 可据此提示"请将 Recall.app 拖到 Applications 文件夹完成安装"。
      // 旧的 downloaded 状态需要 info 字段，installAndQuit 入口时 lastCheckInfo
      // 可能为 null（极端边界），保留 installing 避免类型/空值问题。
      return;
    }

    // Windows：shell.openPath 启动 NSIS 安装向导
    const result = await shell.openPath(installerPath);
    if (result) {
      // openPath 返回非空字符串表示失败
      this.status = {
        state: "error",
        message: result,
        code: "installer_launch_failed",
      };
      logger.error({
        jobType: "update_install",
        status: "failed",
        errorCode: "installer_launch_failed",
        message: result,
      });
      throw new Error(`failed to launch installer: ${result}`);
    }

    // 安装程序已启动，退出当前应用
    app.quit();
  }

  /**
   * 简单的 spawn 包装为 Promise（仅用于 macOS open 命令）
   */
  private spawnAsync(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: "ignore" });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command} exited with code ${code}`));
      });
    });
  }

  /**
   * 上报版本统计（fire-and-forget，失败不影响主流程）
   */
  async pingStats(): Promise<void> {
    try {
      const currentVersion = app.getVersion();
      await net.fetch(`${UPDATE_WORKER_URL}/api/ping`, {
        method: "GET",
        headers: { "X-Client-Version": currentVersion },
      });
    } catch (err) {
      // 静默失败
      logger.info({
        jobType: "update_ping",
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 标记忽略某版本
   * - 写入 settings.update.dismissedVersion
   * - 如果忽略的是当前最新版本，状态回到 idle
   */
  dismissVersion(version: string): void {
    this.persistUpdateSettings({ dismissedVersion: version });
    if (
      this.lastCheckInfo &&
      this.lastCheckInfo.latestVersion === version &&
      this.status.state === "hasUpdate"
    ) {
      this.status = { state: "idle" };
    }
    logger.info({
      jobType: "update_dismiss",
      status: "succeeded",
      message: `dismissed version: ${version}`,
    });
  }

  /**
   * 获取当前状态机
   */
  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * 获取上次检查结果
   */
  getLastCheckInfo(): UpdateInfo | null {
    return this.lastCheckInfo;
  }

  /**
   * 清理半成品下载（应用启动 / 退出时调用）
   *
   * - 删除 updates/ 目录下所有 .tmp 文件（流式下载回退方案的临时文件）
   * - **保留** .part 和 .meta.json 文件（分片断点续传的进度文件）
   *   断点续传依赖这两个文件从中断处继续下载，清理会导致下次从头开始
   *   .part 文件大小会在下次 downloadWithRanges 启动时通过 readDownloadMeta 校验，
   *   若与 meta 不一致会自动丢弃重下，因此保留是安全的
   */
  cleanupIncompleteDownloads(): void {
    try {
      const dir = getUpdatesDir();
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".tmp")) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    } catch {
      // 忽略清理失败
    }
  }

  /**
   * 持久化 update 字段到 settings.json
   * - 与现有字段 deep merge，避免覆盖其他 update 子字段
   */
  private persistUpdateSettings(patch: Partial<UpdateSettings>): void {
    const settings = this.deps.settingsService.getAll();
    const current = settings.update ?? {
      lastCheckedAt: null,
      latestVersion: null,
      dismissedVersion: null,
      downloadedInstallerPath: null,
    };
    const updated: UpdateSettings = { ...current, ...patch };
    this.deps.settingsService.setUpdateSettings(updated);
  }
}
