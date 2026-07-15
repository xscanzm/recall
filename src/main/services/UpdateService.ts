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

export interface UpdateServiceDeps {
  settingsService: SettingsService;
}

export class UpdateService {
  private status: UpdateStatus = { state: "idle" };
  private lastCheckInfo: UpdateInfo | null = null;

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
      const url = `${UPDATE_WORKER_URL}/api/check?currentVersion=${encodeURIComponent(currentVersion)}`;
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
   * 下载更新
   * - net.fetch 流式下载到 updates/ 目录
   * - 下载完成后校验 SHA256
   * - 失败重试最多 3 次（退避 1s/2s/4s）
   * - onProgress 回调由调用方提供（用于 IPC 推送给 renderer）
   * - 返回本地安装包路径
   */
  async downloadUpdate(
    info: UpdateInfo,
    onProgress: (p: DownloadProgress) => void
  ): Promise<string> {
    if (this.status.state === "downloading" || this.status.state === "installing") {
      throw new Error(`cannot download while ${this.status.state}`);
    }

    const installerPath = path.join(
      getUpdatesDir(),
      `Recall-${info.latestVersion}-setup.exe`
    );

    // 已下载过且 SHA256 匹配则直接复用
    if (fs.existsSync(installerPath)) {
      const existingSha = await computeFileSha256(installerPath);
      if (existingSha === info.sha256) {
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
        const tmpPath = installerPath + ".tmp";
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
          // 更新内部状态
          if (this.status.state === "downloading") {
            this.status = { state: "downloading", progress };
          }
          onProgress(progress);
        }

        await new Promise<void>((resolve, reject) => {
          writer.end(() => resolve());
          writer.on("error", reject);
        });

        // 重命名 .tmp → 最终文件
        fs.renameSync(tmpPath, installerPath);

        // 校验 SHA256
        const actualSha = await computeFileSha256(installerPath);
        if (actualSha !== info.sha256) {
          throw new Error(
            `sha256 mismatch: expected ${info.sha256}, got ${actualSha}`
          );
        }

        this.status = { state: "downloaded", installerPath, info };

        // 持久化安装包路径
        this.persistUpdateSettings({ downloadedInstallerPath: installerPath });

        logger.info({
          jobType: "update_download",
          status: "succeeded",
          message: `downloaded: ${installerPath} (${bytesDownloaded} bytes)`,
        });

        return installerPath;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 清理 .tmp
        try {
          fs.unlinkSync(installerPath + ".tmp");
        } catch {
          // 忽略清理失败
        }

        if (attempt >= maxAttempts) {
          this.status = { state: "error", message, code: "download_failed" };
          logger.error({
            jobType: "update_download",
            status: "failed",
            errorCode: "download_failed",
            message: `failed after ${attempt} attempts: ${message}`,
          });
          throw err;
        }

        logger.warn({
          jobType: "update_download",
          status: "started",
          errorCode: "download_retry",
          message: `attempt ${attempt} failed, retrying in ${backoffMs[attempt - 1]}ms: ${message}`,
        });

        await new Promise((r) => setTimeout(r, backoffMs[attempt - 1]));
      }
    }

    // 理论上不会到达
    throw new Error("download failed: max attempts reached");
  }

  /**
   * 启动安装程序并退出当前应用
   * - shell.openPath 触发 NSIS 安装向导（oneClick=false 配置）
   * - 成功后 app.quit() 退出当前实例，让安装程序接管
   */
  async installAndQuit(installerPath: string): Promise<void> {
    this.status = { state: "installing" };

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
   * 清理半成品下载（应用退出时调用）
   * - 删除 updates/ 目录下所有 .tmp 文件
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
