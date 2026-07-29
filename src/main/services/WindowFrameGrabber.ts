// src/main/services/WindowFrameGrabber.ts
//
// 单窗口抓图后端：只碰目标窗口，不碰系统里其它任何窗口。
//
// 为什么需要它
// -----------
// desktopCapturer.getSources({ types:["window"], thumbnailSize:{w,h} }) 会给系统里
// **每一个**顶层窗口真实抓一张图，然后我们才从结果里挑目标。也就是说为了拍 1 个窗口，
// 先把另外十几个无关窗口全拍了一遍。这不只是浪费（实测 4~5 个窗口就要 430~500ms，
// 且随窗口数线性涨），更是副作用来源：Windows 上 GDI 抓图会向目标窗口发 WM_PRINT，
// 在对方进程 UI 线程上强制同步渲染，某些 GPU 合成的应用（钉钉）被打后画面会停在空白。
//
// 这个类换一条路：先用 thumbnailSize:{0,0} 做**零抓图枚举**（只要 id/name，不产生
// 任何图像），挑出目标后，用 getDisplayMedia 单独对那一个窗口开捕获会话。
//
// 为什么要一个隐藏窗口
// -----------------
// getDisplayMedia 是 renderer API，主进程没有等价物。所以起一个 1x1 隐藏 BrowserWindow
// 当抓图宿主，通过 setDisplayMediaRequestHandler 把"用户选择哪个窗口"这一步替换成
// 我们指定的 source —— 不弹系统选择器（不传 useSystemPicker）。
//
// 为什么抓图代码是字符串而不是 preload 文件
// --------------------------------------
// tsconfig.node.json 的 lib 是 ["ES2022"]、types 是 ["node"]，没有 DOM。要写成 .ts
// preload 就得给整个主进程项目加上 DOM lib，那样主进程代码里误用 document/window 之类
// 浏览器全局也能通过类型检查 —— 为一个 40 行的页内脚本换掉整个项目的类型边界不值得。
// 这段脚本是本文件里的常量，不拼接任何外部数据（source id 是通过
// setDisplayMediaRequestHandler 传的，不进脚本），所以没有注入面。
// Step 0 的 spike 已用同一机制实测 21/21 成功出帧。
//
// 实测开销（本机 7 个窗口，Electron 32.3.3）
// ----------------------------------------
// 零抓图枚举 cold 410ms / warm 210~240ms；单窗口抓一帧 370~520ms（首帧含宿主创建）。
// 与旧路径的差别不在总耗时，而在**触及的窗口数**：从"全部"降到 1，且那 1 个是有焦点、
// 正在产帧、被打扰也能自愈的窗口。

import { BrowserWindow, desktopCapturer, session } from "electron";
import * as path from "node:path";
import { logger } from "./Logger";
import { installNavigationGuards } from "./navigationGuard";

/** 抓到的一帧 */
export interface CapturedWindowFrame {
  /** PNG 编码 */
  png: Buffer;
  /** 原生像素宽（不缩放，与窗口实际尺寸一致） */
  width: number;
  /** 原生像素高 */
  height: number;
  /** 抓取耗时（毫秒），用于观测 */
  elapsedMs: number;
}

/** 零抓图枚举出来的候选窗口 */
export interface WindowSourceRef {
  id: string;
  name: string;
}

export interface WindowFrameGrabberConfig {
  /** 单次抓图超时（毫秒） */
  grabTimeoutMs?: number;
  /** 空闲多久后关掉宿主窗口省内存（毫秒） */
  idleCloseMs?: number;
}

const DEFAULT_CONFIG = {
  // 冷启动首帧实测约 1.5s，热路径约 450ms。4s 留足余量，超时即认为这条路不通。
  grabTimeoutMs: 4_000,
  // 宿主窗口常驻约 40~60MB。采集是低频行为，空闲就关掉，下次懒重建。
  idleCloseMs: 5 * 60_000,
};

/** 专用 session，避免 setDisplayMediaRequestHandler 影响主窗口所在的默认 session */
const HOST_PARTITION = "recall-capture-host";

/**
 * 页内抓图脚本。
 *
 * 关键点：必须等到**真有一帧**才画。只等 loadedmetadata 会画出空白帧 —— 而且
 * Step 0 实测 WGC 捕获会话刚建立时会打出 `ProcessFrame failed, using existing frame`，
 * 也就是首帧可能是上一次的残留。requestVideoFrameCallback 才是"这一帧已经可以画了"
 * 的准确信号。
 *
 * finally 里必须 stop 所有 track，否则每次抓图都留下一个常驻捕获会话。
 */
function buildGrabScript(timeoutMs: number): string {
  return `
(async () => {
  let stream = null;
  const startedAt = performance.now();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("frame_timeout")), ${timeoutMs});
      const done = () => { clearTimeout(timer); resolve(); };
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(done);
      } else {
        video.onloadeddata = done;
      }
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("zero_video_size");

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }

    return {
      ok: true,
      width,
      height,
      base64: btoa(binary),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
})()
`;
}

interface GrabScriptResult {
  ok: boolean;
  width?: number;
  height?: number;
  base64?: string;
  error?: string;
  elapsedMs?: number;
}

export class WindowFrameGrabber {
  private readonly config: Required<WindowFrameGrabberConfig>;
  private host: BrowserWindow | null = null;
  /** 宿主创建是异步的，用它让并发调用共享同一次创建 */
  private hostReady: Promise<BrowserWindow> | null = null;
  /** getDisplayMedia 回调要读的目标 source；单飞保证同一时刻只有一个 */
  private pendingSource: WindowSourceRef | null = null;
  /** 单飞队列：pendingSource 是共享状态，并发抓图会互相串台 */
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private handlerInstalled = false;

  constructor(config: WindowFrameGrabberConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 零抓图枚举当前窗口。
   *
   * thumbnailSize:{0,0} 时 Chromium 不会去抓任何窗口的画面，只返回 id/name。
   * Streams.video 也只需要 {id, name}（electron.d.ts 确认），所以这里够用。
   */
  async listWindowSources(): Promise<WindowSourceRef[]> {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    return sources.map((source) => ({ id: source.id, name: source.name }));
  }

  /**
   * 抓取指定窗口的一帧。失败返回 null（由调用方决定降级还是跳过）。
   */
  async grab(source: WindowSourceRef): Promise<CapturedWindowFrame | null> {
    if (this.disposed) return null;
    // 串行化：整段（置 pendingSource → 执行 → 清理）必须独占
    const run = this.queue.then(() => this.grabExclusive(source));
    // 用 catch 收住，避免一次失败把后续调用全短路
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async grabExclusive(source: WindowSourceRef): Promise<CapturedWindowFrame | null> {
    let host: BrowserWindow;
    try {
      host = await this.ensureHost();
    } catch (error) {
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: "capture_host_unavailable",
        message: `capture_host_create_failed: ${describeError(error)}`,
      });
      return null;
    }

    this.pendingSource = source;
    try {
      const result = await this.runWithTimeout(host);
      if (!result) return null;

      if (!result.ok || !result.base64 || !result.width || !result.height) {
        logger.warn({
          jobType: "capture",
          status: "failed",
          errorCode: "window_display_media_failed",
          message: `window_display_media_failed: ${result.error ?? "unknown"}`,
          durationMs: result.elapsedMs,
        });
        return null;
      }

      return {
        png: Buffer.from(result.base64, "base64"),
        width: result.width,
        height: result.height,
        elapsedMs: result.elapsedMs ?? 0,
      };
    } finally {
      this.pendingSource = null;
      this.scheduleIdleClose();
    }
  }

  /**
   * 超时保护。
   *
   * 页内脚本自己有 frame 等待超时，但 executeJavaScript 本身也可能因渲染进程卡死
   * 而永不 settle。超时后直接销毁宿主而不是继续用：一个卡住的宿主里可能还挂着活的
   * 捕获会话，重建比留着更安全。
   */
  private async runWithTimeout(host: BrowserWindow): Promise<GrabScriptResult | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.config.grabTimeoutMs);
    });

    try {
      const result = await Promise.race([
        host.webContents.executeJavaScript(buildGrabScript(this.config.grabTimeoutMs), true) as Promise<GrabScriptResult>,
        timeout,
      ]);
      if (result === null) {
        logger.warn({
          jobType: "capture",
          status: "failed",
          errorCode: "window_display_media_timeout",
          message: "capture_host_grab_timeout_host_rebuilt",
          durationMs: this.config.grabTimeoutMs,
        });
        this.destroyHost();
      }
      return result;
    } catch (error) {
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: "window_display_media_failed",
        message: `capture_host_execute_failed: ${describeError(error)}`,
      });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ensureHost(): Promise<BrowserWindow> {
    if (this.host && !this.host.isDestroyed()) return Promise.resolve(this.host);
    if (this.hostReady) return this.hostReady;

    this.hostReady = this.createHost().catch((error: unknown) => {
      // 失败不缓存，下次调用重试
      this.hostReady = null;
      throw error;
    });
    return this.hostReady;
  }

  private async createHost(): Promise<BrowserWindow> {
    const hostSession = session.fromPartition(HOST_PARTITION);

    // handler 挂在 session 上，session 是按 partition 复用的，所以只装一次。
    if (!this.handlerInstalled) {
      hostSession.setDisplayMediaRequestHandler((_request, callback) => {
        const target = this.pendingSource;
        if (!target) {
          // 没有待抓目标就是异常请求（页面里不该主动发起），空对象即拒绝。
          callback({});
          return;
        }
        callback({ video: { id: target.id, name: target.name } });
      });
      this.handlerInstalled = true;
    }

    const host = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      // 不能被用户看到或操作
      frame: false,
      focusable: false,
      webPreferences: {
        session: hostSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 必须关：隐藏窗口默认会被节流，定时器和帧回调都不准时
        backgroundThrottling: false,
        spellcheck: false,
        devTools: false,
      },
    });

    // 宿主页是我们自己的空壳页，理论上不会导航；护栏是纵深防御，成本近零。
    const hostRoot = __dirname;
    installNavigationGuards(host.webContents, () => ({ rendererRoot: hostRoot }));

    host.webContents.on("render-process-gone", (_event, details) => {
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: "capture_host_gone",
        message: `capture_host_render_process_gone: ${details.reason}`,
      });
      this.destroyHost();
    });

    host.on("closed", () => {
      if (this.host === host) {
        this.host = null;
        this.hostReady = null;
      }
    });

    // 宿主页必须与本文件的编译产物同目录（dist/main/services/）。
    // scripts/copy-assets.js 按 src/ -> dist/ 镜像路径保证这一点，并在缺文件时
    // 构建期就报错 —— 曾经拷到 dist/main/ 而这里在 dist/main/services/ 找，
    // 结果每次抓图静默返回 null、悄悄退到整屏裁剪。
    await host.loadFile(path.join(__dirname, "capture-host.html"));

    this.host = host;
    return host;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.disposed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.destroyHost();
    }, this.config.idleCloseMs);
    // 不要让这个定时器拖住进程退出
    this.idleTimer.unref?.();
  }

  private destroyHost(): void {
    const host = this.host;
    this.host = null;
    this.hostReady = null;
    if (host && !host.isDestroyed()) {
      try {
        host.destroy();
      } catch {
        // 已在销毁流程中，忽略
      }
    }
  }

  /** 应用退出时调用 */
  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.destroyHost();
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
