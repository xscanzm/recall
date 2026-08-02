// src/main/services/CaptureService.ts
// 捕获活动窗口截图（M3 实现，来自 01/02/03/06/07 文档）
//
// 职责（来自 06 文档）：
// - 捕获活动窗口截图
// - 支持单帧和短时间多帧（最多 3-6 帧）
// - 生成 stitched image（拼接多帧，保留时间标记）
// - 返回 CaptureBundle（按 03 文档类型定义）
// - 只采活动窗口，不采全屏
// - 捕获前必须调用 PrivacyGuard
// - 捕获后必须交给 ScreenshotCache 管理
//
// 安全约束：
// - 文件名不含窗口标题/URL/用户文本（由 ScreenshotCache 保证）
// - 截图仅本地 cache，不上传
// - 截图文件真实路径不通过 IPC 暴露给 renderer
//
// 拼图策略（来自 spec.md）：
// - 同一窗口的短时间多帧
// - 最多 3-6 帧合成一张 stitched image
// - 帧之间保留时间标记
// - 优先保留变化明显的帧（MVP 简化为按时间均匀采样）
// - 拼图只作为模型输入和本地短期缓存，不作为主 UI 内容
//
// 不应采集场景（来自 07 文档，由 PrivacyGuard 处理）：
// - 全屏历史录像（不在此处判断）
// - 黑名单应用
// - 密码/支付/银行/证件/医疗高敏场景
// - 用户暂停期间
// - 锁屏
// - 登录页

import { desktopCapturer, screen } from "electron";
import sharp from "sharp";
import { EventEmitter } from "node:events";
import type { CaptureBundle, ScreenshotRetentionPolicy } from "../models/types";
import type {
  ActivityService,
  ActivityWindowInfo,
  CaptureCandidateEvent,
  CaptureTriggerReason,
} from "./ActivityService";
import type { PrivacyGuard, PreCaptureCheckResult, PreCaptureReason } from "./PrivacyGuard";
import type { ScreenshotCache } from "./ScreenshotCache";
import type { SettingsService } from "./SettingsService";
import {
  computeOccludedRatio,
  findVisibleOccluders,
  MAX_BENIGN_OCCLUSION_RATIO,
} from "./captureOcclusion";
import { logger } from "./Logger";
import { generateId } from "../utils/id";
import { getSystemTimezone } from "../utils/timezone";

/**
 * 采集后端。按安全性排序，从最安全的开始试。
 *
 * - window_display_media：只对目标窗口开一次捕获会话，不碰其它窗口
 * - screen_crop_fallback：抓整屏再裁；不向任何窗口发消息，但需要确认目标没被遮挡
 * - window：旧路径，为了拍 1 个窗口把系统里所有窗口都抓一遍，并且在 Windows 上会向
 *   每个窗口发 WM_PRINT。默认禁用，只留作应急开关。
 */
export type CaptureBackend = "window_display_media" | "screen_crop_fallback" | "window";

/**
 * 单窗口抓图后端的最小接口。
 *
 * 用结构类型而不是直接 import WindowFrameGrabber：
 * 1. 避免 CaptureService ↔ WindowFrameGrabber 循环依赖
 * 2. 让单测能注入假实现，不用把 BrowserWindow / session 拖进测试的 electron mock
 */
export interface WindowFrameSource {
  /** 零抓图枚举当前窗口（只要 id/name，不产生任何图像） */
  listWindowSources(): Promise<Array<{ id: string; name: string }>>;
  /** 抓取指定窗口的一帧，失败返回 null */
  grab(source: { id: string; name: string }): Promise<{ png: Buffer } | null>;
}

/**
 * 跳过采集的原因。
 *
 * 在 PreCaptureReason 之上就地加了两个采集侧原因，不去改 PrivacyGuard 的枚举
 * —— 那是隐私判定的词汇表，"被别的窗口挡住了"和"没有可用的安全后端"不属于它。
 */
export type CaptureSkippedReason = PreCaptureReason | "occluded" | "no_safe_backend";

/**
 * CaptureService 发出的事件类型
 *
 * 'capture-bundle'：成功捕获一个 CaptureBundle 时发出
 *   - 由 MemoryPipeline 订阅，触发 AI Pipeline 处理
 *   - 监听者签名：(bundle: CaptureBundle) => void
 *
 * 'capture-skipped'：因隐私规则/暂停/截图失败等原因跳过采集时发出
 *   - 监听者签名：(info: { reason: PreCaptureReason; captureId?: string }) => void
 */
export interface CaptureServiceEvents {
  "capture-bundle": (bundle: CaptureBundle) => void;
  "capture-skipped": (info: { reason: CaptureSkippedReason; captureId?: string }) => void;
}

/**
 * 捕获结果
 */
export interface CaptureResult {
  /** CaptureBundle，若被 PrivacyGuard 阻止则为 null */
  bundle: CaptureBundle | null;
  /** PrivacyGuard 检查结果 */
  privacyCheck: PreCaptureCheckResult;
}

/**
 * 单帧截图
 */
interface CapturedFrame {
  /** PNG buffer */
  buffer: Buffer;
  /** 截图时间 */
  capturedAt: Date;
  /** 来源 source id（desktopCapturer 返回） */
  sourceId: string;
  captureMethod: CaptureBackend;
}

interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SizeLike {
  width: number;
  height: number;
}

export interface CaptureVisualQuality {
  nearBlackRatio: number;
  luminanceStdDev: number;
  edgeDensity: number;
  informationScore: number;
  isDegenerate: boolean;
}

const QUALITY_SAMPLE_WIDTH = 160;
const QUALITY_SAMPLE_HEIGHT = 90;
const NEAR_BLACK_CHANNEL_MAX = 8;
const DEGENERATE_NEAR_BLACK_RATIO = 0.99;
const DEGENERATE_EDGE_DENSITY_MAX = 0.02;
const FALLBACK_MIN_INFORMATION_GAIN = 8;
const MIN_WINDOW_DISPLAY_COVERAGE = 0.9;
const CAPTURE_REASON_PRIORITY: Record<CaptureTriggerReason, number> = {
  manual_capture: 90,
  daily_preflight: 80,
  scene_boundary: 70,
  project_switch: 60,
  window_focus_changed: 50,
  window_title_changed: 40,
  active_input_session: 30,
  content_changed: 20,
  long_session: 10,
};

/**
 * CaptureService 配置
 */
export interface CaptureServiceConfig {
  /** 多帧采集时的帧数（默认 1，可配置 1-6） */
  frameCount?: number;
  /** 多帧采集间隔（毫秒），默认 1000 */
  frameIntervalMs?: number;
  /** 缩略图最大宽度，默认 1920 */
  thumbnailWidth?: number;
  /** 缩略图最大高度，默认 1080 */
  thumbnailHeight?: number;
  /**
   * 是否允许退回旧的全窗口缩略图路径。默认 false。
   *
   * 这条路会为了拍 1 个窗口把系统里所有窗口都真实抓一遍，在 Windows 上还会向每个
   * 窗口发 WM_PRINT 强制它们在自己的 UI 线程上同步渲染 —— 对第三方应用有可观察的
   * 副作用（某些 GPU 合成应用会白屏直到被重新标脏）。
   *
   * 产品决策：前两条安全路径都走不通时**跳过这次采集**，而不是用伤害用户其它应用的
   * 方式硬采。代码保留是为了留一个应急开关，不是留一条默认退路。
   */
  allowLegacyWindowThumbnailCapture?: boolean;
}

/**
 * 默认配置
 *
 * frameCount=1：MVP 默认单帧采集
 * 真实多帧由 Pipeline 决定是否触发（如长会话场景）
 */
const DEFAULT_CONFIG: Required<CaptureServiceConfig> = {
  frameCount: 1,
  frameIntervalMs: 1_000,
  thumbnailWidth: 1_920,
  thumbnailHeight: 1_080,
  allowLegacyWindowThumbnailCapture: false,
};

/**
 * 上报到 CaptureBundle 时的后端优先级：数字大的胜出。
 *
 * 多帧可能落在不同后端上。这时报告"最需要被注意到的那个" —— 也就是最偏离
 * 首选路径的那个 —— 因为这个字段的用处是事后定位"为什么这次采集不正常"。
 */
const BACKEND_REPORT_PRIORITY: Record<CaptureBackend, number> = {
  window: 3,
  screen_crop_fallback: 2,
  window_display_media: 1,
};

/**
 * CaptureService：捕获活动窗口截图并生成 CaptureBundle
 *
 * 工作流：
 * 1. 监听 ActivityService 的 'capture-candidate' 事件
 * 2. 收到事件后调用 PrivacyGuard.checkBeforeCapture
 * 3. 若允许：调用 desktopCapturer 截图活动窗口
 *    - 只采活动窗口（types: ['window']）
 *    - 通过非空 windowId 和 windowTitle 严格定位活动窗口
 * 4. 保存截图到 ScreenshotCache
 * 5. 多帧采集时生成 stitched image
 * 6. 构造 CaptureBundle 并通过 'capture-bundle' 事件发出
 *
 * 注意：
 * - 暂停状态由 ActivityService 在事件发出前检查（通过 isPaused 状态）
 * - 但本服务仍二次检查 isPaused，确保安全
 * - 捕获后不直接调用模型，由上层 Pipeline 接管
 */
export class CaptureService extends EventEmitter {
  private config: Required<CaptureServiceConfig>;
  private activityService: ActivityService | null = null;
  private privacyGuard: PrivacyGuard | null = null;
  private screenshotCache: ScreenshotCache | null = null;
  private settingsService: SettingsService | null = null;
  private windowFrameSource: WindowFrameSource | null = null;

  // 暂停状态：由 app.ts 通过 setPaused 更新
  private isPaused = false;
  // 锁屏状态：由 app.ts 通过 setLocked 更新
  private isLocked = false;

  // 事件回调引用（用于 off）
  private captureCandidateHandler: ((event: CaptureCandidateEvent) => void) | null = null;
  private readonly activeCaptures = new Set<Promise<unknown>>();
  private pendingCaptureCandidate: CaptureCandidateEvent | null = null;
  private captureCandidateLoop: Promise<void> | null = null;
  private captureTail: Promise<void> = Promise.resolve();

  constructor(config: CaptureServiceConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<CaptureServiceConfig>;
  }

  /**
   * 注入依赖
   */
  setDependencies(deps: {
    activityService: ActivityService;
    privacyGuard: PrivacyGuard;
    screenshotCache: ScreenshotCache;
    settingsService: SettingsService;
    /**
     * 单窗口抓图后端。不传则首选后端不可用，直接从 screen crop 开始试。
     * 单测里可以注入假实现。
     */
    windowFrameSource?: WindowFrameSource;
  }): void {
    this.activityService = deps.activityService;
    this.privacyGuard = deps.privacyGuard;
    this.screenshotCache = deps.screenshotCache;
    this.settingsService = deps.settingsService;
    this.windowFrameSource = deps.windowFrameSource ?? null;
  }

  /**
   * 更新配置
   */
  updateConfig(patch: Partial<CaptureServiceConfig>): void {
    this.config = { ...this.config, ...patch } as Required<CaptureServiceConfig>;
  }

  /**
   * 设置/解除暂停状态
   * - 暂停时不截图、不调用模型、不新增 observation
   * - 恢复后继续监听，不补采暂停期间内容
   */
  setPaused(paused: boolean): void {
    this.isPaused = paused;
  }

  /**
   * 设置/解除锁屏状态
   * - 锁屏时不截图
   * - 解锁后继续监听，不补采锁屏期间内容
   */
  setLocked(locked: boolean): void {
    this.isLocked = locked;
  }

  /**
   * 启动 CaptureService
   * - 订阅 ActivityService 的 'capture-candidate' 事件
   * - 必须在 setDependencies 之后调用
   */
  start(): void {
    if (!this.activityService) {
      throw new Error("CaptureService.start 前必须调用 setDependencies");
    }
    if (this.captureCandidateHandler) {
      return; // 已订阅
    }
    const handler = (event: CaptureCandidateEvent) => {
      this.enqueueCaptureCandidate(event);
    };
    this.captureCandidateHandler = handler;
    this.activityService.on("capture-candidate", handler);
  }

  /**
   * 停止 CaptureService
   * - 取消订阅 ActivityService 事件
   */
  stop(): void {
    if (this.activityService && this.captureCandidateHandler) {
      this.activityService.off("capture-candidate", this.captureCandidateHandler);
    }
    this.captureCandidateHandler = null;
    this.pendingCaptureCandidate = null;
  }

  async drain(): Promise<void> {
    while (this.activeCaptures.size > 0) {
      await Promise.allSettled([...this.activeCaptures]);
    }
  }

  /**
   * 主动捕获活动窗口（不依赖 ActivityService 事件）
   * - 用于 manual_capture 或测试
   * - 返回 CaptureBundle 或 null（被 PrivacyGuard 阻止）
   */
  async captureActiveWindow(
    reason: CaptureBundle["captureReason"] = "manual_capture"
  ): Promise<CaptureBundle | null> {
    if (!this.activityService || !this.privacyGuard || !this.screenshotCache) {
      return null;
    }

    const window = this.activityService.getCurrentWindow();
    if (!window) {
      return null;
    }

    const signals = this.activityService.getCurrentSignals();
    const triggerEvent: CaptureCandidateEvent = {
      reason,
      window,
      signals,
      triggeredAt: new Date().toISOString(),
    };

    const result = await this.trackCapture(
      this.runSerializedCapture(() => this.handleCaptureCandidate(triggerEvent))
    );
    return result?.bundle ?? null;
  }

  private enqueueCaptureCandidate(event: CaptureCandidateEvent): void {
    this.pendingCaptureCandidate = coalesceCaptureCandidate(
      this.pendingCaptureCandidate,
      event
    );
    this.startCaptureCandidateLoop();
  }

  private startCaptureCandidateLoop(): void {
    if (this.captureCandidateLoop || !this.pendingCaptureCandidate) return;

    const loop = this.drainCaptureCandidates();
    this.captureCandidateLoop = loop;
    this.trackCapture(loop).catch(() => {
      // 单次捕获失败不阻断后续候选。
    });
    void loop.finally(() => {
      if (this.captureCandidateLoop === loop) this.captureCandidateLoop = null;
      this.startCaptureCandidateLoop();
    }).catch(() => {});
  }

  private async drainCaptureCandidates(): Promise<void> {
    while (this.pendingCaptureCandidate) {
      const event = this.pendingCaptureCandidate;
      this.pendingCaptureCandidate = null;
      try {
        await this.runSerializedCapture(() => this.handleCaptureCandidate(event));
      } catch {
        // 单次捕获失败不丢失已合并的后续候选。
      }
    }
  }

  private runSerializedCapture<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.captureTail.then(operation, operation);
    this.captureTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * 处理 capture-candidate 事件
   *
   * 流程：
   * 1. 二次检查 isPaused
   * 2. PrivacyGuard.checkBeforeCapture
   * 3. desktopCapturer 截图活动窗口
   * 4. 保存截图到 ScreenshotCache
   * 5. 多帧采集时生成 stitched image
   * 6. 构造 CaptureBundle
   */
  private async handleCaptureCandidate(
    event: CaptureCandidateEvent
  ): Promise<CaptureResult | null> {
    // 1. 暂停状态二次检查
    if (this.isPaused) {
      this.emitCaptureSkipped("paused");
      return {
        bundle: null,
        privacyCheck: { allowed: false, reason: "paused" },
      };
    }

    // 2. 锁屏状态检查
    if (this.isLocked) {
      this.emitCaptureSkipped("locked");
      return {
        bundle: null,
        privacyCheck: { allowed: false, reason: "locked" },
      };
    }

    if (!this.privacyGuard || !this.screenshotCache || !this.activityService) {
      return null;
    }

    // 3. idle 兜底检查
    //    scene_boundary（idle/active 转换）、manual_capture（手动）、daily_preflight（预检）在 idle 时也允许
    const IDLE_EXEMPT_REASONS: ReadonlySet<CaptureTriggerReason> = new Set([
      "scene_boundary",
      "manual_capture",
      "daily_preflight",
    ]);
    if (!IDLE_EXEMPT_REASONS.has(event.reason)) {
      const signals = this.activityService.getCurrentSignals();
      const idleThresholdSeconds = this.activityService.getIdleThresholdSeconds();
      if (signals.idleSeconds >= idleThresholdSeconds) {
        this.emitCaptureSkipped("idle");
        return { bundle: null, privacyCheck: { allowed: false, reason: "idle" } };
      }
    }

    // 4. PrivacyGuard 检查
    const privacyCheck = this.privacyGuard.checkBeforeCapture({
      appName: event.window.appName,
      windowTitle: event.window.windowTitle,
      urlOrDomain: event.window.urlOrDomain,
      isPaused: this.isPaused,
      isLocked: this.isLocked,
    });

    if (!privacyCheck.allowed) {
      // 命中黑名单或敏感词，跳过不截图
      this.emitCaptureSkipped(privacyCheck.reason);
      return { bundle: null, privacyCheck };
    }

    // 3. 截图活动窗口
    const { frames, skipReason } = await this.captureWindowFrames(event.window);
    if (frames.length === 0) {
      // 三条后端都没拿到可用画面（或被遮挡门禁拦下），跳过这次采集
      this.emitCaptureSkipped(skipReason ?? "unknown");
      return {
        bundle: null,
        privacyCheck: { allowed: false, reason: "unknown" },
      };
    }

    // 4. 保存截图到 cache
    const savedPaths: string[] = [];
    for (const frame of frames) {
      try {
        const result = await this.screenshotCache.save({
          buffer: frame.buffer,
          prefix: "capture",
          capturedAt: frame.capturedAt,
        });
        savedPaths.push(result.filePath);
      } catch {
        // 单帧保存失败不阻断其他帧
      }
    }

    if (savedPaths.length === 0) {
      this.emitCaptureSkipped("unknown");
      return {
        bundle: null,
        privacyCheck: { allowed: false, reason: "unknown" },
      };
    }

    // 5. 多帧时生成 stitched image
    let stitchedImagePath: string | undefined;
    if (frames.length > 1) {
      try {
        const stitchedBuffer = await this.createStitchedImage(frames);
        if (stitchedBuffer) {
          const stitchedResult = await this.screenshotCache.save({
            buffer: stitchedBuffer,
            prefix: "stitched",
            capturedAt: new Date(),
          });
          stitchedImagePath = stitchedResult.filePath;
        }
      } catch {
        // 拼图失败不阻断（含生成与保存）
      }
    }

    // 6. 构造 CaptureBundle
    const retentionPolicy = this.getRetentionPolicy();
    const captureId = generateCaptureId();
    const bundle: CaptureBundle = {
      captureId,
      capturedAt: event.triggeredAt,
      timezone: getSystemTimezone(),
      appName: event.window.appName,
      windowTitle: event.window.windowTitle,
      urlOrDomain: event.window.urlOrDomain,
      captureReason: event.reason,
      activitySignals: {
        keyboardActive: event.signals.keyboardActive,
        mouseActive: event.signals.mouseActive,
        idleSeconds: event.signals.idleSeconds,
        activeWindowStableSeconds: event.signals.activeWindowStableSeconds,
      },
      imagePaths: savedPaths,
      stitchedImagePath,
      captureMethod: pickReportedBackend(frames),
      retentionPolicy,
    };

    // 7. 发出 capture-bundle 事件，由 MemoryPipeline 订阅处理
    //    使用 setImmediate 确保不阻塞当前事件循环
    //    失败不阻断（emit 错误由监听器内部 try/catch 处理）
    this.emitCaptureBundle(bundle);

    return { bundle, privacyCheck };
  }

  /**
   * 发出 capture-bundle 事件
   * - 使用 setImmediate 异步发出，避免阻塞当前事件循环
   * - 监听器（MemoryPipeline）处理失败不阻断 capture 流程
   */
  private emitCaptureBundle(bundle: CaptureBundle): void {
    try {
      this.emit("capture-bundle", bundle);
    } catch {
      // 监听器内部错误不阻断 capture 流程
    }
  }

  private trackCapture<T>(promise: Promise<T>): Promise<T> {
    this.activeCaptures.add(promise);
    void promise.finally(() => this.activeCaptures.delete(promise)).catch(() => {});
    return promise;
  }

  /**
   * 发出 capture-skipped 事件
   */
  private emitCaptureSkipped(reason: CaptureSkippedReason): void {
    setImmediate(() => {
      try {
        this.emit("capture-skipped", { reason });
      } catch {
        // 监听器内部错误不阻断
      }
    });
  }

  /**
   * 截图活动窗口（一帧或多帧）
   * - 只采活动窗口（types: ['window']）
   * - 通过 windowId 和非空 windowTitle 严格定位活动窗口
   * - 多帧：间隔 frameIntervalMs 采集，最多 frameCount 帧
   *
   * 注意：desktopCapturer 必须在 app.whenReady() 之后调用
   */
  private async captureWindowFrames(window: {
    appName: string;
    windowTitle: string;
    windowId?: number;
  }): Promise<{ frames: CapturedFrame[]; skipReason: CaptureSkippedReason | null }> {
    const frames: CapturedFrame[] = [];
    const frameCount = Math.max(1, Math.min(6, this.config.frameCount));
    let skipReason: CaptureSkippedReason | null = null;

    for (let i = 0; i < frameCount; i++) {
      const capturedAt = new Date();
      const attempt = await this.captureSingleFrame(window);
      if (attempt.frame) {
        frames.push({
          buffer: attempt.frame.buffer,
          capturedAt,
          sourceId: attempt.frame.sourceId,
          captureMethod: attempt.frame.captureMethod,
        });
      } else if (!skipReason) {
        // 只记第一次失败的原因：后续帧的失败大概率是同一个原因的重复
        skipReason = attempt.skipReason;
      }

      // 多帧时等待间隔
      if (i < frameCount - 1) {
        await sleep(this.config.frameIntervalMs);
      }
    }

    return { frames, skipReason };
  }

  /**
   * 截取单帧活动窗口，按"对其它应用的伤害从小到大"依次尝试后端。
   *
   *   1. window_display_media —— 只对目标窗口开一次捕获会话
   *   2. screen_crop_fallback —— 抓整屏再裁，先过遮挡门禁
   *   3. window（旧全窗口缩略图）—— 默认禁用
   *
   * 全部走不通就跳过这次采集，不硬采。少一条记忆，好过把用户正在用的应用打白。
   */
  private async captureSingleFrame(window: {
    appName: string;
    windowTitle: string;
    windowId?: number;
  }): Promise<{
    frame: { buffer: Buffer; sourceId: string; captureMethod: CaptureBackend } | null;
    skipReason: CaptureSkippedReason | null;
  }> {
    try {
      // ---- 后端 1：单窗口 getDisplayMedia ----
      let primaryQuality: CaptureVisualQuality | null = null;
      const primary = await this.captureViaWindowFrameSource(window);
      if (primary) {
        primaryQuality = await analyzeCaptureVisualQuality(primary.buffer);
        if (!primaryQuality.isDegenerate) {
          return { frame: { ...primary, captureMethod: "window_display_media" }, skipReason: null };
        }
        // 退化率是观测 WGC 是否真在工作的窗口：GDI 抓 GPU 合成窗口才会回全黑。
        logger.warn({
          jobType: "capture",
          status: "failed",
          errorCode: "degenerate_capture",
          message: "degenerate_window_display_media_frame",
        });
      }

      // ---- 后端 2：整屏裁剪（先过遮挡门禁）----
      const gate = await this.checkScreenCropOcclusion(window);
      if (gate.allowed) {
        const fallback = await this.captureScreenCropFallback(window);
        if (fallback) {
          const fallbackQuality = await analyzeCaptureVisualQuality(fallback.buffer);
          // 后端 1 拿到过（退化的）画面时，沿用原有的信息量比较，避免用一张更差的
          // 裁剪图替换掉勉强可用的窗口图；后端 1 完全没出图时只要求裁剪图本身不退化。
          const acceptable = primaryQuality
            ? shouldUseScreenCropFallback(primaryQuality, fallbackQuality)
            : !fallbackQuality.isDegenerate;
          if (acceptable) {
            logger.info({
              jobType: "capture",
              status: "succeeded",
              message: "screen_crop_fallback_used",
            });
            return {
              frame: { ...fallback, captureMethod: "screen_crop_fallback" },
              skipReason: null,
            };
          }
        }
      }

      // ---- 后端 3：旧全窗口缩略图（默认禁用）----
      if (this.config.allowLegacyWindowThumbnailCapture) {
        const legacy = await this.captureViaLegacyWindowThumbnail(window);
        if (legacy) {
          const legacyQuality = await analyzeCaptureVisualQuality(legacy.buffer);
          if (!legacyQuality.isDegenerate) {
            logger.warn({
              jobType: "capture",
              status: "succeeded",
              errorCode: "legacy_window_thumbnail_used",
              message: "legacy_window_thumbnail_used_touches_all_windows",
            });
            return { frame: { ...legacy, captureMethod: "window" }, skipReason: null };
          }
        }
      }

      const skipReason: CaptureSkippedReason =
        gate.allowed || gate.reason === "unavailable" ? "no_safe_backend" : "occluded";
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: skipReason,
        message: `capture_skipped_${skipReason}`,
      });
      return { frame: null, skipReason };
    } catch {
      return { frame: null, skipReason: "no_safe_backend" };
    }
  }

  /**
   * 后端 1：零抓图枚举 + 单窗口 getDisplayMedia。
   *
   * 与旧路径的关键差别在枚举那一步：thumbnailSize:{0,0} 不会去抓任何窗口的画面，
   * 目标筛选发生在**产生任何图像之前**。旧路径是先把所有窗口都抓一遍再挑目标。
   */
  private async captureViaWindowFrameSource(window: {
    windowTitle: string;
    windowId?: number;
  }): Promise<{ buffer: Buffer; sourceId: string } | null> {
    const source = this.windowFrameSource;
    if (!source) return null;

    try {
      const sources = await source.listWindowSources();
      if (sources.length === 0) return null;

      // 目标定位逻辑与旧路径完全一致，不放宽
      const target = findMatchingWindowSource(sources, window);
      if (!target) return null;

      const frame = await source.grab(target);
      if (!frame || frame.png.length === 0) return null;

      return { buffer: frame.png, sourceId: target.id };
    } catch {
      return null;
    }
  }

  /**
   * 后端 3：旧的全窗口缩略图路径。
   *
   * 保留但默认不启用。它为了拍 1 个窗口要把系统里所有窗口都真实抓一遍。
   */
  private async captureViaLegacyWindowThumbnail(window: {
    windowTitle: string;
    windowId?: number;
  }): Promise<{ buffer: Buffer; sourceId: string } | null> {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: {
        width: this.config.thumbnailWidth,
        height: this.config.thumbnailHeight,
      },
      fetchWindowIcons: false,
    });
    if (sources.length === 0) return null;

    const target = findMatchingWindowSource(sources, window);
    if (!target?.thumbnail || target.thumbnail.isEmpty()) return null;

    return { buffer: Buffer.from(target.thumbnail.toPNG()), sourceId: target.id };
  }

  /**
   * 整屏裁剪路径的遮挡门禁。
   *
   * 整屏裁剪只是"从整屏图里抠出目标窗口那块矩形"。如果那块矩形上面压着别的窗口，
   * 抠出来的就是别人的内容 —— 既可能拍到不该拍的（密码管理器浮在上面），也会生成
   * 一张与用户当时在看什么完全不符的截图。所以走这条路之前必须先确认那块归目标。
   *
   * 决策依据：
   * - 拿不到窗口快照 / 认不出目标 → unavailable。证明不了安全就不用这条路。
   * - 任一遮挡窗口过不了 PrivacyGuard（复用用户自己配的黑名单与敏感词）→ occluded
   * - 遮挡面积超过 MAX_BENIGN_OCCLUSION_RATIO → occluded
   */
  private async checkScreenCropOcclusion(window: {
    appName: string;
    windowTitle: string;
    windowId?: number;
  }): Promise<{ allowed: true } | { allowed: false; reason: "occluded" | "unavailable" }> {
    if (!this.activityService) return { allowed: false, reason: "unavailable" };

    const snapshot = await this.activityService.getOpenWindowsSnapshot();
    if (!snapshot) {
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: "occlusion_snapshot_unavailable",
        message: "screen_crop_gate_no_window_snapshot",
      });
      return { allowed: false, reason: "unavailable" };
    }

    const target = findSnapshotTarget(snapshot, window);
    if (!target?.bounds) return { allowed: false, reason: "unavailable" };

    const occluders = findVisibleOccluders(
      snapshot.map(toOcclusionWindow),
      { id: target.windowId, bounds: target.bounds },
      // Recall 自己的窗口不算遮挡，否则主界面/悬浮窗一挂在前面就永远采不到东西。
      // 实测确认：Windows 上 HWND 的 owner 是 Electron **主**进程（不是 renderer
      // 进程），所以这里用 process.pid；隐藏窗口（show:false）不会被 active-win
      // 枚举到，抓图宿主不会污染这份快照。
      [process.pid]
    );
    // null = 目标不在 Z 序里，说明快照与实际不一致，同样是"证明不了"
    if (!occluders) return { allowed: false, reason: "unavailable" };

    if (this.privacyGuard) {
      for (const occluder of occluders) {
        const check = this.privacyGuard.checkBeforeCapture({
          appName: occluder.appName,
          windowTitle: occluder.windowTitle,
          urlOrDomain: occluder.urlOrDomain,
          isPaused: false,
          isLocked: false,
        });
        if (!check.allowed) {
          logger.warn({
            jobType: "capture",
            status: "failed",
            errorCode: "occluded_by_sensitive_window",
            // 不记录窗口标题，只记命中原因
            message: `screen_crop_gate_sensitive_occluder: ${check.reason}`,
          });
          return { allowed: false, reason: "occluded" };
        }
      }
    }

    const ratio = computeOccludedRatio(target.bounds, occluders);
    if (ratio > MAX_BENIGN_OCCLUSION_RATIO) {
      logger.warn({
        jobType: "capture",
        status: "failed",
        errorCode: "occluded",
        message: `screen_crop_gate_occlusion_ratio: ${ratio.toFixed(2)}`,
      });
      return { allowed: false, reason: "occluded" };
    }

    return { allowed: true };
  }

  private async captureScreenCropFallback(window: {
    appName: string;
    windowTitle: string;
    windowId?: number;
  }): Promise<{ buffer: Buffer; sourceId: string } | null> {
    if (!this.activityService) return null;

    const before = await this.activityService.getFreshActiveWindowInfo();
    if (!before?.bounds || !isSameActivityWindow(window, before)) return null;

    const windowBounds = toElectronDipBounds(before.bounds);
    const display = screen.getDisplayMatching(windowBounds);
    const requestedSize = {
      width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor)),
      height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor)),
    };
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: requestedSize,
      fetchWindowIcons: false,
    });
    const target = findMatchingDisplaySource(
      sources,
      display.id,
      screen.getAllDisplays().length
    );
    if (!target || !target.thumbnail || target.thumbnail.isEmpty()) return null;

    const crop = calculateScreenCrop(
      windowBounds,
      display.bounds,
      target.thumbnail.getSize()
    );
    if (!crop || crop.coverage < MIN_WINDOW_DISPLAY_COVERAGE) return null;

    const cropped = await sharp(target.thumbnail.toPNG())
      .extract(crop.region)
      .png()
      .toBuffer();

    const after = await this.activityService.getFreshActiveWindowInfo();
    if (
      !after?.bounds
      || !isSameActivityWindow(before, after)
      || !sameRectangle(before.bounds, after.bounds)
    ) {
      return null;
    }

    return { buffer: cropped, sourceId: `${target.id}:window-crop` };
  }

  /**
   * 生成 stitched image（拼接多帧）
   * - 水平拼接多帧
   * - 在每帧顶部留 30px 用于时间标记
   * - 拼图只作为模型输入和本地短期缓存，不作为主 UI 内容
   *
   * 实现策略：
   * - 使用 sharp 库加载每帧 PNG buffer 并获取元数据（宽高）
   * - 按最高帧高度等比缩放，每帧顶部 extend 30px 黑色区域
   * - 通过 SVG overlay 在黑色区域绘制 HH:mm:ss 时间戳
   * - 创建总宽度空白底图，composite 所有帧实现水平拼接
   */
  private async createStitchedImage(
    frames: CapturedFrame[]
  ): Promise<Buffer | null> {
    if (frames.length === 0) return null;
    if (frames.length === 1) return null; // 单帧不需要拼接

    // 1. 读取每帧元数据，按最大高度等比缩放计算各帧宽度
    const metadatas = await Promise.all(
      frames.map((f) => sharp(f.buffer).metadata())
    );
    const origWidths = metadatas.map((m) => m.width ?? 0);
    const origHeights = metadatas.map((m) => m.height ?? 0);
    const maxHeight = Math.max(...origHeights);
    const labelHeight = 30;
    const totalHeight = maxHeight + labelHeight;

    const scaledWidths = origWidths.map((w, i) => {
      const h = origHeights[i];
      if (h <= 0 || maxHeight <= 0) return w;
      return Math.round((w * maxHeight) / h);
    });
    const totalWidth = scaledWidths.reduce((a, b) => a + b, 0);

    // 2. 为每帧添加顶部 30px 时间戳标签
    // 时间格式：HH:mm:ssZ（UTC，后缀 Z），与 prompt 输入 JSON 里的 capturedAt 字段对齐。
    // 这样 LLM 看到 stitch image 标签和 JSON 字段是同一时间制，避免把本地小时误当 UTC 写出
    // （修复：之前用 toLocaleTimeString 渲染本地时间，导致 LLM 错位 +8h 写入 startAt/endAt）
    const labeledFrames = await Promise.all(
      frames.map(async (frame, i) => {
        const time = formatUtcTimeLabel(frame.capturedAt);
        const svgLabel = Buffer.from(
          `<svg width="${scaledWidths[i]}" height="${labelHeight}">` +
            `<rect width="100%" height="100%" fill="#000"/>` +
            `<text x="10" y="20" fill="#fff" font-family="monospace" font-size="14">${time}</text>` +
            `</svg>`
        );
        return sharp(frame.buffer)
          .resize({ height: maxHeight })
          .extend({
            top: labelHeight,
            bottom: 0,
            left: 0,
            right: 0,
            background: "#000",
          })
          .composite([{ input: svgLabel, gravity: "northwest" }])
          .toBuffer();
      })
    );

    // 3. 创建总宽度空白底图，水平拼接所有帧
    const composites = labeledFrames.map((buf, i) => ({
      input: buf,
      left: scaledWidths.slice(0, i).reduce((a, b) => a + b, 0),
      top: 0,
    }));

    return sharp({
      create: {
        width: totalWidth,
        height: totalHeight,
        channels: 3,
        background: "#000",
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
  }

  /**
   * 获取当前 retention policy（从 settings 读取）
   */
  private getRetentionPolicy(): ScreenshotRetentionPolicy {
    if (!this.settingsService) {
      return "today"; // 默认保留当天
    }
    try {
      const settings = this.settingsService.getAll();
      return settings.screenshot.retentionPolicy;
    } catch {
      return "today";
    }
  }
}

export function coalesceCaptureCandidate(
  pending: CaptureCandidateEvent | null,
  incoming: CaptureCandidateEvent
): CaptureCandidateEvent {
  if (!pending) return incoming;

  const pendingWindowId = pending.window.windowId;
  const incomingWindowId = incoming.window.windowId;
  const sameWindow = pendingWindowId !== undefined && incomingWindowId !== undefined
    ? pendingWindowId === incomingWindowId
    : pending.window.appName === incoming.window.appName
      && pending.window.windowTitle === incoming.window.windowTitle;

  if (!sameWindow) return incoming;
  return CAPTURE_REASON_PRIORITY[incoming.reason] >= CAPTURE_REASON_PRIORITY[pending.reason]
    ? incoming
    : pending;
}

export async function analyzeCaptureVisualQuality(
  buffer: Buffer
): Promise<CaptureVisualQuality> {
  const { data, info } = await sharp(buffer)
    .resize(QUALITY_SAMPLE_WIDTH, QUALITY_SAMPLE_HEIGHT, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const pixelCount = info.width * info.height;
  const luminance = new Float32Array(pixelCount);
  let nearBlackPixels = 0;
  let luminanceSum = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * channels;
    const red = data[offset] ?? 0;
    const green = data[offset + Math.min(1, channels - 1)] ?? red;
    const blue = data[offset + Math.min(2, channels - 1)] ?? red;
    if (Math.max(red, green, blue) <= NEAR_BLACK_CHANNEL_MAX) nearBlackPixels += 1;
    const value = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminance[pixelIndex] = value;
    luminanceSum += value;
  }

  const luminanceMean = pixelCount > 0 ? luminanceSum / pixelCount : 0;
  let varianceSum = 0;
  let edgeCount = 0;
  let edgeComparisons = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      const value = luminance[index];
      varianceSum += (value - luminanceMean) ** 2;
      if (x + 1 < info.width) {
        edgeComparisons += 1;
        if (Math.abs(value - luminance[index + 1]) >= 12) edgeCount += 1;
      }
      if (y + 1 < info.height) {
        edgeComparisons += 1;
        if (Math.abs(value - luminance[index + info.width]) >= 12) edgeCount += 1;
      }
    }
  }

  const nearBlackRatio = pixelCount > 0 ? nearBlackPixels / pixelCount : 1;
  const luminanceStdDev = pixelCount > 0
    ? Math.sqrt(varianceSum / pixelCount)
    : 0;
  const edgeDensity = edgeComparisons > 0 ? edgeCount / edgeComparisons : 0;
  const informationScore = luminanceStdDev
    + edgeDensity * 100
    + (1 - nearBlackRatio) * 20;
  return {
    nearBlackRatio,
    luminanceStdDev,
    edgeDensity,
    informationScore,
    isDegenerate:
      nearBlackRatio >= DEGENERATE_NEAR_BLACK_RATIO
      && edgeDensity <= DEGENERATE_EDGE_DENSITY_MAX,
  };
}

export function shouldUseScreenCropFallback(
  windowQuality: CaptureVisualQuality,
  fallbackQuality: CaptureVisualQuality
): boolean {
  return windowQuality.isDegenerate
    && !fallbackQuality.isDegenerate
    && fallbackQuality.informationScore
      >= windowQuality.informationScore + FALLBACK_MIN_INFORMATION_GAIN;
}

export function calculateScreenCrop(
  windowBounds: RectangleLike,
  displayBounds: RectangleLike,
  thumbnailSize: SizeLike
): {
  region: { left: number; top: number; width: number; height: number };
  coverage: number;
} | null {
  if (
    windowBounds.width <= 0
    || windowBounds.height <= 0
    || displayBounds.width <= 0
    || displayBounds.height <= 0
    || thumbnailSize.width <= 0
    || thumbnailSize.height <= 0
  ) {
    return null;
  }

  const intersectionLeft = Math.max(windowBounds.x, displayBounds.x);
  const intersectionTop = Math.max(windowBounds.y, displayBounds.y);
  const intersectionRight = Math.min(
    windowBounds.x + windowBounds.width,
    displayBounds.x + displayBounds.width
  );
  const intersectionBottom = Math.min(
    windowBounds.y + windowBounds.height,
    displayBounds.y + displayBounds.height
  );
  if (intersectionRight <= intersectionLeft || intersectionBottom <= intersectionTop) {
    return null;
  }

  const scaleX = thumbnailSize.width / displayBounds.width;
  const scaleY = thumbnailSize.height / displayBounds.height;
  const left = clampInteger(
    Math.floor((intersectionLeft - displayBounds.x) * scaleX),
    0,
    thumbnailSize.width - 1
  );
  const top = clampInteger(
    Math.floor((intersectionTop - displayBounds.y) * scaleY),
    0,
    thumbnailSize.height - 1
  );
  const right = clampInteger(
    Math.ceil((intersectionRight - displayBounds.x) * scaleX),
    left + 1,
    thumbnailSize.width
  );
  const bottom = clampInteger(
    Math.ceil((intersectionBottom - displayBounds.y) * scaleY),
    top + 1,
    thumbnailSize.height
  );
  const intersectionArea =
    (intersectionRight - intersectionLeft) * (intersectionBottom - intersectionTop);
  const windowArea = windowBounds.width * windowBounds.height;
  return {
    region: { left, top, width: right - left, height: bottom - top },
    coverage: intersectionArea / windowArea,
  };
}

function findMatchingDisplaySource<T extends { display_id: string }>(
  sources: T[],
  displayId: number,
  displayCount: number
): T | undefined {
  const match = sources.find((source) => source.display_id === String(displayId));
  if (match) return match;
  return displayCount === 1 && sources.length === 1 ? sources[0] : undefined;
}

/**
 * 多帧可能落在不同后端上。这里报告"最偏离首选路径"的那个 —— 这个字段的用处是
 * 事后定位"为什么这次采集不正常"，报最好的那个会把问题藏起来。
 */
function pickReportedBackend(frames: readonly CapturedFrame[]): CaptureBackend {
  let reported: CaptureBackend = "window_display_media";
  for (const frame of frames) {
    if (BACKEND_REPORT_PRIORITY[frame.captureMethod] > BACKEND_REPORT_PRIORITY[reported]) {
      reported = frame.captureMethod;
    }
  }
  return reported;
}

/**
 * 在窗口快照里认出目标窗口。
 *
 * 定位严格度与 findMatchingWindowSource 保持一致：有 windowId 就必须 id 与标题同时
 * 匹配；没有 id 时只接受非空标题的精确匹配。宁可认不出（退回 unavailable、不采），
 * 也不要认错窗口然后按错误的矩形去判断遮挡。
 */
function findSnapshotTarget(
  snapshot: readonly ActivityWindowInfo[],
  window: { windowTitle: string; windowId?: number }
): ActivityWindowInfo | undefined {
  const title = window.windowTitle.trim();
  if (!title) return undefined;

  if (window.windowId !== undefined) {
    return snapshot.find(
      (candidate) => candidate.windowId === window.windowId && candidate.windowTitle.trim() === title
    );
  }
  return snapshot.find((candidate) => candidate.windowTitle.trim() === title);
}

function toOcclusionWindow(info: ActivityWindowInfo): {
  id?: number;
  processId?: number;
  appName: string;
  windowTitle: string;
  urlOrDomain?: string;
  bounds?: RectangleLike;
} {
  return {
    id: info.windowId,
    processId: info.processId,
    appName: info.appName,
    windowTitle: info.windowTitle,
    urlOrDomain: info.urlOrDomain,
    bounds: info.bounds,
  };
}

function isSameActivityWindow(
  expected: Pick<ActivityWindowInfo, "appName" | "windowTitle" | "windowId">,
  actual: Pick<ActivityWindowInfo, "appName" | "windowTitle" | "windowId">
): boolean {
  if (
    expected.windowId !== undefined
    && actual.windowId !== undefined
    && expected.windowId !== actual.windowId
  ) {
    return false;
  }
  return expected.appName.trim() === actual.appName.trim()
    && expected.windowTitle.trim() === actual.windowTitle.trim();
}

function sameRectangle(left: RectangleLike, right: RectangleLike): boolean {
  const tolerance = 2;
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance;
}

function toElectronDipBounds(bounds: RectangleLike): RectangleLike {
  if (process.platform !== "win32") return { ...bounds };
  try {
    return screen.screenToDipRect(null, bounds);
  } catch {
    return { ...bounds };
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function findMatchingWindowSource<T extends { id: string; name: string }>(
  sources: T[],
  window: { windowTitle: string; windowId?: number }
): T | undefined {
  const title = window.windowTitle.trim();
  if (!title) return undefined;

  if (window.windowId !== undefined) {
    const windowId = String(window.windowId);
    const byId = sources.find((source) => {
      const sourceWindowId = source.id.split(":")[1];
      return sourceWindowId === windowId && source.name.trim() === title;
    });
    if (byId) return byId;
    return undefined;
  }

  return sources.find(
    (source) => source.id.trim().length > 0 && source.name.trim() === title
  );
}

/**
 * 生成 captureId
 * 格式：cap_<timestamp>_<random>
 */
function generateCaptureId(): string {
  return generateId("cap_");
}

/**
 * 格式化 UTC 时间标签：HH:mm:ssZ
 * - 用于 stitch image 顶部时间戳
 * - 使用 UTC 而非本地时间，让视觉标签和 prompt 输入 JSON 里的 capturedAt
 *   （ISO 8601 UTC 字符串，带 Z）保持一致，避免 LLM 误把本地小时当 UTC
 * - 例：本地 16:01:08 (UTC+8) → "08:01:08Z"
 */
function formatUtcTimeLabel(d: Date): string {
  const iso = d.toISOString(); // "2026-07-07T08:01:08.000Z"
  return iso.slice(11, 19) + "Z"; // "08:01:08Z"
}

/**
 * sleep 工具
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单例
 *
 * 注意：必须在 app.whenReady() 之后使用
 */
let _instance: CaptureService | null = null;

export function getCaptureService(): CaptureService {
  if (!_instance) {
    _instance = new CaptureService();
  }
  return _instance;
}
