// src/main/services/ActivityService.ts
// 活动窗口观察（M3 实现，来自 01/02/03/07 文档）
//
// 职责（来自 06 文档）：
// - 监听活动窗口
// - 获取 app name、window title、可能的 URL/domain
// - 监听键盘/鼠标活跃状态
// - 识别 idle / active session
// - 发出 capture candidate event
// - 若 URL 难获取，先保存 domain 为空，不阻塞
//
// 7 个触发条件（来自 07 文档）：
// 1. 活动窗口切换
// 2. 活动窗口标题变化
// 3. 用户输入活跃 + 窗口稳定 30 秒
// 4. 内容 hash/缩略图差异超阈值（间隔至少 60 秒）— 此处简化为长会话间隔触发
// 5. active 变 idle（idle threshold 120 秒）
// 6. idle 后恢复
// 7. daily preflight（外部触发）
//
// 默认阈值：
// - active window stable: 30 秒后可第一次采集
// - 同一窗口内容变化：至少间隔 60 秒
// - 长工作会话：每 2-5 分钟采集一组关键帧（实现取 5 分钟）
// - idle threshold: 120 秒
//
// 实现：
// - 使用 active-win 库（已安装）获取活动窗口
// - 使用 Electron powerMonitor.getSystemIdleTime() 获取系统空闲时间
// - 周期性轮询（默认 5 秒），检测状态变化触发事件
// - EventEmitter 发出 'capture-candidate' 事件，由 CaptureService 接收
//
// 安全约束：
// - URL 在 Windows 上难以获取，保存为空字符串，不阻塞采集
// - 不在 ActivityService 中保存截图，仅发出事件

import { EventEmitter } from "node:events";
import * as path from "node:path";
import { powerMonitor } from "electron";
import activeWin from "active-win";
import type { CaptureBundle } from "../models/types";

/**
 * 活动窗口信息
 */
export interface ActivityWindowInfo {
  /** 应用名称（如 "Code.exe" -> "Code" 或 "Visual Studio Code"） */
  appName: string;
  /** 窗口标题 */
  windowTitle: string;
  /** URL/domain（Windows 上通常为空，不阻塞） */
  urlOrDomain?: string;
  /** 窗口 id（用于检测切换） */
  windowId?: number;
  /** 进程 id */
  processId?: number;
  /** 活动窗口在虚拟桌面中的原始边界（Windows 原生屏幕坐标） */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/**
 * 用户活动信号
 */
export interface ActivitySignals {
  /** 键盘是否活跃（idle < 5 秒视为活跃） */
  keyboardActive: boolean;
  /** 鼠标是否活跃 */
  mouseActive: boolean;
  /** 系统空闲秒数 */
  idleSeconds: number;
  /** 当前活动窗口稳定秒数（自上次切换算起） */
  activeWindowStableSeconds: number;
}

/**
 * 触发原因（来自 spec.md CaptureBundle.captureReason）
 */
export type CaptureTriggerReason =
  | "window_focus_changed"
  | "window_title_changed"
  | "active_input_session"
  | "content_changed"
  | "scene_boundary"
  | "daily_preflight"
  | "long_session"
  | "project_switch"
  | "manual_capture";

/**
 * 触发事件参数
 */
export interface CaptureCandidateEvent {
  /** 触发原因 */
  reason: CaptureTriggerReason;
  /** 当前活动窗口 */
  window: ActivityWindowInfo;
  /** 活动信号 */
  signals: ActivitySignals;
  /** 触发时间 ISO */
  triggeredAt: string;
}

/**
 * ActivityService 配置
 */
export interface ActivityServiceConfig {
  /** 轮询间隔（毫秒），默认 5000 */
  pollIntervalMs?: number;
  /** 窗口稳定阈值（秒），默认 30 */
  activeWindowStableSeconds?: number;
  /** 内容变化最小间隔（秒），默认 60 */
  contentChangeMinIntervalSeconds?: number;
  /** 长会话采集间隔（分钟），默认 5 */
  longSessionIntervalMinutes?: number;
  /** idle 阈值（秒），默认 120 */
  idleThresholdSeconds?: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Required<ActivityServiceConfig> = {
  pollIntervalMs: 5_000,
  activeWindowStableSeconds: 30,
  contentChangeMinIntervalSeconds: 60,
  longSessionIntervalMinutes: 5,
  idleThresholdSeconds: 120,
};

/**
 * 事件名称
 */
export const CAPTURE_CANDIDATE_EVENT = "capture-candidate";
export const IDLE_STATE_CHANGED_EVENT = "idle-state-changed";

export interface IdleStateChangedEvent {
  from: "active" | "idle";
  to: "active" | "idle";
  triggeredAt: string;
}

/**
 * ActivityService：监听活动窗口，识别 idle/active，发出 capture candidate 事件
 *
 * 触发条件实现：
 * 1. 活动窗口切换：当前 windowId 与上次不同 → reason=window_focus_changed
 * 2. 活动窗口标题变化：同 windowId 但 title 不同 → reason=window_title_changed
 * 3. 用户输入活跃 + 窗口稳定 30 秒：idleSeconds < 5 && activeWindowStableSeconds >= 30
 *    -> 每次满足此条件时发出，但有去抖动（同一稳定窗口 30 秒内只发一次）
 * 4. 内容差异：窗口未变但 idleSeconds < 5 && 距上次触发 >= 60 秒 -> reason=content_changed
 *    （真正的内容 hash 由 CaptureService 检查；此处简化为间隔触发）
 *    长会话：每 5 分钟（longSessionIntervalMinutes），无论窗口是否变化，发出 reason=content_changed
 * 5. active -> idle：idleSeconds 从 < threshold 跨过 >= threshold -> reason=scene_boundary
 * 6. idle -> active：idleSeconds 从 >= threshold 降到 < threshold -> reason=scene_boundary
 * 7. daily preflight：外部调用 triggerDailyPreflight() -> reason=daily_preflight
 */
export class ActivityService extends EventEmitter {
  private config: Required<ActivityServiceConfig>;
  private pollTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private pollInFlight = false;

  // 当前状态
  private currentWindow: ActivityWindowInfo | null = null;
  private currentWindowSince: number = 0; // ms timestamp
  private lastCaptureTime: number = 0; // ms timestamp
  private lastIdleState: "active" | "idle" = "active";
  private lastIdleSeconds = 0;

  // 去抖动：每个原因上次触发时间
  private lastTriggerTimeByReason: Map<CaptureTriggerReason, number> = new Map();

  constructor(config: ActivityServiceConfig = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<ActivityServiceConfig>;
  }

  /**
   * 更新配置（运行时动态调整）
   * 来自 SettingsService.observation 设置
   */
  updateConfig(patch: Partial<ActivityServiceConfig>): void {
    const newConfig = { ...this.config, ...patch } as Required<ActivityServiceConfig>;
    this.config = newConfig;
  }

  /**
   * 启动监听
   * - 启动后开始周期性轮询活动窗口
   * - 检测到状态变化时发出 'capture-candidate' 事件
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentWindow = null;
    this.currentWindowSince = Date.now();
    this.lastCaptureTime = 0;
    this.lastIdleState = "active";
    this.lastIdleSeconds = 0;
    this.lastTriggerTimeByReason.clear();

    // 立即执行一次，然后周期性轮询
    // 首次调用同样要吞异常：start() 是同步接口，抛到这里会变成未处理拒绝。
    this.pollOnce().catch(() => {
      // 首轮失败不阻断后续轮询
    });
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => {
        // 单次轮询失败不阻断后续轮询
      });
    }, this.config.pollIntervalMs);
  }

  /**
   * 停止监听
   * - 清理定时器
   * - 不补采暂停期间内容
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * 是否正在运行
   */
  isObserving(): boolean {
    return this.isRunning;
  }

  /**
   * 获取当前活动窗口信息
   * - 不阻塞；若 active-win 调用失败返回 null
   */
  getCurrentWindow(): ActivityWindowInfo | null {
    return this.currentWindow;
  }

  /**
   * 重新读取当前活动窗口，而不是返回轮询缓存。
   * 屏幕裁剪 fallback 在捕获前后调用，防止窗口切换后裁到其他应用。
   */
  async getFreshActiveWindowInfo(): Promise<ActivityWindowInfo | null> {
    return this.getActiveWindowInfo();
  }

  /**
   * 读取当前所有打开窗口，用于遮挡判定。
   *
   * 返回顺序是 Z 序（最前面的在数组开头），这一点已实测确认，遮挡判定依赖它。
   * 失败返回 null 而不是空数组：这两者含义完全不同 —— 空数组是"确认没有别的窗口"，
   * null 是"不知道"。调用方在 null 时必须保守处理（不采），不能当成没被遮挡。
   *
   * active-win 的引用集中在本 service，不向外扩散。
   */
  async getOpenWindowsSnapshot(): Promise<ActivityWindowInfo[] | null> {
    try {
      const results = await activeWin.getOpenWindows();
      if (!Array.isArray(results)) return null;
      return results.map((result) => {
        let appName = result.owner?.name ?? "";
        if (!appName && result.owner?.path) {
          appName = path.basename(result.owner.path);
        }
        return {
          appName: appName || "unknown",
          windowTitle: result.title || "",
          urlOrDomain: "url" in result ? (result as { url?: string }).url : undefined,
          windowId: result.id,
          processId: result.owner?.processId,
          bounds: result.bounds
            ? {
                x: result.bounds.x,
                y: result.bounds.y,
                width: result.bounds.width,
                height: result.bounds.height,
              }
            : undefined,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * 获取当前活动信号
   */
  getCurrentSignals(): ActivitySignals {
    const idleSeconds = this.getSystemIdleSeconds();
    const stableSeconds = this.currentWindow
      ? Math.floor((Date.now() - this.currentWindowSince) / 1000)
      : 0;
    const isActive = idleSeconds < 5;
    return {
      keyboardActive: isActive,
      mouseActive: isActive,
      idleSeconds,
      activeWindowStableSeconds: stableSeconds,
    };
  }

  /**
   * 获取当前 idle 阈值（秒）
   * - 供 CaptureService 兜底检查使用
   */
  getIdleThresholdSeconds(): number {
    return this.config.idleThresholdSeconds;
  }

  /**
   * 外部触发：daily preflight
   * - 由 ReportScheduler 在生成日报前调用
   * - 不依赖当前窗口状态，直接发出 reason=daily_preflight
   */
  async triggerDailyPreflight(): Promise<void> {
    const window = await this.getActiveWindowInfo();
    if (!window) return;
    const signals = this.getCurrentSignals();
    this.emitCaptureCandidate({
      reason: "daily_preflight",
      window,
      signals,
      triggeredAt: new Date().toISOString(),
    });
  }

  /**
   * 外部触发：手动捕获
   */
  async triggerManualCapture(): Promise<void> {
    const window = await this.getActiveWindowInfo();
    if (!window) return;
    const signals = this.getCurrentSignals();
    this.emitCaptureCandidate({
      reason: "manual_capture",
      window,
      signals,
      triggeredAt: new Date().toISOString(),
    });
  }

  /**
   * 单次轮询
   * - 获取活动窗口
   * - 检查 7 个触发条件
   */
  private async pollOnce(): Promise<void> {
    if (!this.isRunning || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const window = await this.getActiveWindowInfo();
      if (!this.isRunning) return;

      const idleSeconds = this.getSystemIdleSeconds();
      const now = Date.now();
      const previousWindow = this.currentWindow;

      // 同一轮只发出一个候选：idle 边界 > 窗口变化 > 内容/输入。
      const idleCandidate = this.checkIdleTransitions(idleSeconds, now, window);
      if (!window) {
        if (idleCandidate) this.emitCaptureCandidate(idleCandidate);
        return;
      }

      this.lastIdleSeconds = idleSeconds;
      const windowCandidate = this.checkWindowChanges(window, now, idleSeconds);

      // 先刷新当前窗口，再构造内容候选，禁止带着旧窗口截图。
      const windowChanged = !previousWindow || previousWindow.windowId !== window.windowId;
      if (windowChanged) {
        this.currentWindow = window;
        this.currentWindowSince = now;
      } else if (previousWindow.windowTitle !== window.windowTitle) {
        this.currentWindow = window;
      }

      const contentCandidate = !idleCandidate && !windowCandidate && previousWindow
        ? this.checkContentOrInputTriggers(idleSeconds, now)
        : null;
      const candidate = idleCandidate ?? windowCandidate ?? contentCandidate;
      if (candidate) this.emitCaptureCandidate(candidate);
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * 检查 idle <-> active 转换
   * - 触发条件 5：active -> idle（一段工作可能结束）-> scene_boundary
   * - 触发条件 6：idle -> active（新场景开始）-> scene_boundary
   */
  private checkIdleTransitions(
    idleSeconds: number,
    now: number,
    freshWindow: ActivityWindowInfo | null
  ): CaptureCandidateEvent | null {
    const threshold = this.config.idleThresholdSeconds;
    const currentState: "active" | "idle" = idleSeconds >= threshold ? "idle" : "active";

    if (currentState === this.lastIdleState) {
      return null; // 未变化
    }

    // 状态转换
    const previousState = this.lastIdleState;
    const window = currentState === "active" ? freshWindow : this.currentWindow;
    this.emit(IDLE_STATE_CHANGED_EVENT, {
      from: previousState,
      to: currentState,
      triggeredAt: new Date(now).toISOString(),
    } satisfies IdleStateChangedEvent);
    if (!window) {
      this.lastIdleState = currentState;
      return null;
    }

    this.lastIdleState = currentState;
    return {
      reason: "scene_boundary",
      window,
      signals: {
        keyboardActive: currentState === "active",
        mouseActive: currentState === "active",
        idleSeconds,
        activeWindowStableSeconds: Math.floor((now - this.currentWindowSince) / 1000),
      },
      triggeredAt: new Date(now).toISOString(),
    };
  }

  /**
   * 检查窗口切换和标题变化
   * - 触发条件 1：活动窗口切换 -> window_focus_changed
   *   - 若 appName 同时变化（视为项目切换）-> project_switch
   * - 触发条件 2：活动窗口标题变化 -> window_title_changed
   *
   * 项目切换判定：active-win 不直接返回 projectId，使用 appName 作为项目代理。
   * 不同应用通常对应不同工作上下文（如 VSCode -> 浏览器），适合触发 SceneBuilder。
   */
  private checkWindowChanges(
    window: ActivityWindowInfo,
    now: number,
    idleSeconds: number
  ): CaptureCandidateEvent | null {
    const prev = this.currentWindow;

    if (!prev) {
      // 首次获取，不触发（避免启动时立即采集）
      return null;
    }

    // 用户已 idle 时跳过窗口切换/标题变化触发
    // （scene_boundary 由 checkIdleTransitions 独立处理，不在此处）
    if (idleSeconds >= this.config.idleThresholdSeconds) {
      return null;
    }

    // 触发条件 1：窗口切换
    if (prev.windowId !== window.windowId) {
      // 项目切换：appName 变化视为切换到另一个项目上下文
      const projectChanged = prev.appName !== window.appName;
      return {
        reason: projectChanged ? "project_switch" : "window_focus_changed",
        window,
        signals: {
          keyboardActive: idleSeconds < 5,
          mouseActive: idleSeconds < 5,
          idleSeconds,
          activeWindowStableSeconds: 0,
        },
        triggeredAt: new Date(now).toISOString(),
      };
    }

    // 触发条件 2：标题变化
    if (prev.windowTitle !== window.windowTitle) {
      return {
        reason: "window_title_changed",
        window,
        signals: {
          keyboardActive: idleSeconds < 5,
          mouseActive: idleSeconds < 5,
          idleSeconds,
          activeWindowStableSeconds: Math.floor((now - this.currentWindowSince) / 1000),
        },
        triggeredAt: new Date(now).toISOString(),
      };
    }

    return null;
  }

  /**
   * 检查输入活跃 + 窗口稳定 / 内容变化触发
   * - 触发条件 3：用户输入活跃 + 窗口稳定 30 秒 -> active_input_session
   * - 触发条件 4：内容变化（间隔至少 60 秒）-> content_changed
   *   - 此处简化为长会话间隔触发；真实内容 hash 由 CaptureService 决定是否真正采集
   *   - 长会话：每 longSessionIntervalMinutes 分钟发出一次
   */
  private checkContentOrInputTriggers(
    idleSeconds: number,
    now: number
  ): CaptureCandidateEvent | null {
    if (!this.currentWindow) return null;

    const stableSeconds = Math.floor((now - this.currentWindowSince) / 1000);
    const isInputActive = idleSeconds < 5;

    // 触发条件 3：输入活跃 + 窗口稳定 >= 30 秒
    // 去抖动：同一稳定窗口 30 秒内只发一次 active_input_session
    if (isInputActive && stableSeconds >= this.config.activeWindowStableSeconds) {
      const lastTrigger = this.lastTriggerTimeByReason.get("active_input_session") ?? 0;
      // 同一窗口内 60 秒去抖动（避免频繁触发）
      if (now - lastTrigger >= 60 * 1000) {
        this.lastTriggerTimeByReason.set("active_input_session", now);
        return {
          reason: "active_input_session",
          window: this.currentWindow,
          signals: {
            keyboardActive: true,
            mouseActive: true,
            idleSeconds,
            activeWindowStableSeconds: stableSeconds,
          },
          triggeredAt: new Date(now).toISOString(),
        };
      }
    }

    // 触发条件 4：内容变化（间隔至少 60 秒）
    // 简化为：输入活跃 + 距上次触发 >= 60 秒 -> content_changed
    if (isInputActive && now - this.lastCaptureTime >= this.config.contentChangeMinIntervalSeconds * 1000) {
      return {
        reason: "content_changed",
        window: this.currentWindow,
        signals: {
          keyboardActive: true,
          mouseActive: true,
          idleSeconds,
          activeWindowStableSeconds: stableSeconds,
        },
        triggeredAt: new Date(now).toISOString(),
      };
    }

    // 长会话：每 longSessionIntervalMinutes 分钟，无论窗口是否变化，发出 content_changed
    // 用于"长工作会话：每 2-5 分钟采集一组关键帧"
    // 注意：用户已 idle（>= idleThresholdSeconds）时不触发，避免离开后仍截图
    if (
      idleSeconds < this.config.idleThresholdSeconds &&
      now - this.lastCaptureTime >= this.config.longSessionIntervalMinutes * 60 * 1000
    ) {
      return {
        reason: "content_changed",
        window: this.currentWindow,
        signals: {
          keyboardActive: isInputActive,
          mouseActive: isInputActive,
          idleSeconds,
          activeWindowStableSeconds: stableSeconds,
        },
        triggeredAt: new Date(now).toISOString(),
      };
    }

    return null;
  }

  /**
   * 获取活动窗口信息（通过 active-win）
   * - Windows 上 URL 难以获取，保存为空字符串
   * - 失败时返回 null
   */
  private async getActiveWindowInfo(): Promise<ActivityWindowInfo | null> {
    try {
      const result = await activeWin();
      if (!result) return null;

      // 提取应用名：优先使用 owner.name；若失败用 path 的 basename
      let appName = result.owner.name;
      if (!appName && result.owner.path) {
        appName = path.basename(result.owner.path);
      }
      if (!appName) {
        appName = "unknown";
      }

      // 提取 URL：仅 macOS 返回 url 字段，Windows/Linux 不返回
      // 因此 Windows 上 urlOrDomain 永远为 undefined（不阻塞）
      const urlOrDomain = "url" in result ? (result as { url?: string }).url : undefined;

      return {
        appName,
        windowTitle: result.title || "",
        urlOrDomain,
        windowId: result.id,
        processId: result.owner.processId,
        bounds: {
          x: result.bounds.x,
          y: result.bounds.y,
          width: result.bounds.width,
          height: result.bounds.height,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * 获取系统空闲秒数
   * - 使用 Electron powerMonitor.getSystemIdleTime()
   * - 返回值是整数秒
   */
  private getSystemIdleSeconds(): number {
    try {
      // powerMonitor.getSystemIdleTime() 返回 number（秒），需要 app.whenReady() 后可用
      const idle = powerMonitor.getSystemIdleTime();
      return typeof idle === "number" && idle >= 0 ? idle : 0;
    } catch {
      return 0;
    }
  }

  /**
   * 发出 capture-candidate 事件
   * - 由 CaptureService 监听
   * - CaptureService 决定是否真正采集（PrivacyGuard 检查 + 截图）
   */
  private emitCaptureCandidate(event: CaptureCandidateEvent): void {
    const triggeredAt = Date.parse(event.triggeredAt);
    this.lastCaptureTime = Number.isFinite(triggeredAt) ? triggeredAt : Date.now();
    this.emit(CAPTURE_CANDIDATE_EVENT, event);
  }
}

/**
 * 单例
 *
 * 注意：必须在 app.whenReady() 之后才能使用（依赖 powerMonitor）
 */
let _instance: ActivityService | null = null;

export function getActivityService(): ActivityService {
  if (!_instance) {
    _instance = new ActivityService();
  }
  return _instance;
}

/**
 * 兼容类型导出（CaptureService 使用）
 */
export type { CaptureBundle };
