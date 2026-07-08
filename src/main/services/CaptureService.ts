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

import { desktopCapturer } from "electron";
import sharp from "sharp";
import { EventEmitter } from "node:events";
import type { CaptureBundle, ScreenshotRetentionPolicy } from "../models/types";
import type { ActivityService, CaptureCandidateEvent, CaptureTriggerReason } from "./ActivityService";
import type { PrivacyGuard, PreCaptureCheckResult, PreCaptureReason } from "./PrivacyGuard";
import type { ScreenshotCache } from "./ScreenshotCache";
import type { SettingsService } from "./SettingsService";

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
  "capture-skipped": (info: { reason: PreCaptureReason; captureId?: string }) => void;
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
}

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
};

/**
 * CaptureService：捕获活动窗口截图并生成 CaptureBundle
 *
 * 工作流：
 * 1. 监听 ActivityService 的 'capture-candidate' 事件
 * 2. 收到事件后调用 PrivacyGuard.checkBeforeCapture
 * 3. 若允许：调用 desktopCapturer 截图活动窗口
 *    - 只采活动窗口（types: ['window']）
 *    - 通过 source.name 与 windowTitle 匹配定位活动窗口
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

  // 暂停状态：由 app.ts 通过 setPaused 更新
  private isPaused = false;
  // 锁屏状态：由 app.ts 通过 setLocked 更新
  private isLocked = false;

  // 事件回调引用（用于 off）
  private captureCandidateHandler: ((event: CaptureCandidateEvent) => void) | null = null;

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
  }): void {
    this.activityService = deps.activityService;
    this.privacyGuard = deps.privacyGuard;
    this.screenshotCache = deps.screenshotCache;
    this.settingsService = deps.settingsService;
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
      // 异步处理，不阻塞 EventEmitter
      this.handleCaptureCandidate(event).catch(() => {
        // 单次捕获失败不阻断后续
      });
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

    const result = await this.handleCaptureCandidate(triggerEvent);
    return result?.bundle ?? null;
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
    const frames = await this.captureWindowFrames(event.window);
    if (frames.length === 0) {
      // 截图失败（可能是权限问题或窗口已关闭）
      this.emitCaptureSkipped("unknown");
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
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
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
    setImmediate(() => {
      try {
        this.emit("capture-bundle", bundle);
      } catch {
        // 监听器内部错误不阻断 capture 流程
      }
    });
  }

  /**
   * 发出 capture-skipped 事件
   */
  private emitCaptureSkipped(reason: PreCaptureReason): void {
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
   * - 通过 source.name 匹配 windowTitle 定位活动窗口
   * - 多帧：间隔 frameIntervalMs 采集，最多 frameCount 帧
   *
   * 注意：desktopCapturer 必须在 app.whenReady() 之后调用
   */
  private async captureWindowFrames(window: {
    appName: string;
    windowTitle: string;
    windowId?: number;
  }): Promise<CapturedFrame[]> {
    const frames: CapturedFrame[] = [];
    const frameCount = Math.max(1, Math.min(6, this.config.frameCount));

    for (let i = 0; i < frameCount; i++) {
      const capturedAt = new Date();
      const buffer = await this.captureSingleFrame(window);
      if (buffer) {
        frames.push({
          buffer,
          capturedAt,
          sourceId: "", // desktopCapturer source id（不持久化）
        });
      }

      // 多帧时等待间隔
      if (i < frameCount - 1) {
        await sleep(this.config.frameIntervalMs);
      }
    }

    return frames;
  }

  /**
   * 截取单帧活动窗口
   * - desktopCapturer.getSources({ types: ['window'] })
   * - 通过 source.name 与 windowTitle 匹配（部分匹配，避免窗口标题变化）
   * - 若匹配不到，使用第一个 source 作为降级（仅当 source.name 接近）
   */
  private async captureSingleFrame(window: {
    appName: string;
    windowTitle: string;
  }): Promise<Buffer | null> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: {
          width: this.config.thumbnailWidth,
          height: this.config.thumbnailHeight,
        },
        fetchWindowIcons: false,
      });

      if (sources.length === 0) {
        return null;
      }

      // 匹配活动窗口：优先使用 source.name 与 windowTitle 完全/部分匹配
      let target = sources.find((s) => s.name === window.windowTitle);
      if (!target) {
        // 部分匹配：source.name 包含 windowTitle 或反之
        target = sources.find((s) => {
          return (
            (window.windowTitle && s.name.includes(window.windowTitle)) ||
            (s.name && window.windowTitle.includes(s.name))
          );
        });
      }
      // 降级：使用第一个 source（通常是最近活动的窗口）
      if (!target) {
        target = sources[0];
      }

      if (!target.thumbnail || target.thumbnail.isEmpty()) {
        return null;
      }

      // 将 NativeImage 转换为 PNG buffer
      const pngBuffer = target.thumbnail.toPNG();
      return Buffer.from(pngBuffer);
    } catch {
      return null;
    }
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

/**
 * 生成 captureId
 * 格式：cap_<timestamp>_<random>
 */
function generateCaptureId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `cap_${timestamp}_${random}`;
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
