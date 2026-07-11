// src/main/services/SceneScheduler.ts
// 长会话场景调度器（来自 03/07 文档）
//
// 职责：
// - 监听持续工作时长，当同一窗口/项目持续工作 ≥ longSessionIntervalMinutes 时
//   发出 captureReason="long_session" 的调度信号，由上游冲刷当前 capture batch
// - 当 observing=false（暂停）时停止计时；恢复时重新开始
// - 不负责截图，发出的 bundle 中 imagePaths 为空数组且不会进入 legacy Fact pipeline
//
// 触发条件（来自 spec.md SceneBuilder）：
// 1. 同一窗口/项目持续工作 10 分钟以上 -> long_session
// 2. 用户切换到另一个明显不同的项目 -> project_switch（由 ActivityService 检测）
// 3. 长时间 idle 后恢复 -> scene_boundary（由 ActivityService 检测）
// 4. 日报前批处理 -> daily_preflight（由 ReportScheduler 触发）
//
// 设计要点：
// - lastActivityAt 记录当前窗口/项目会话的开始时间（窗口/项目变化时重置）
// - timer 周期性检查 Date.now() - lastActivityAt >= interval，并确认同一窗口仍活跃
// - 用户 idle 时（idleSeconds 超过阈值）不触发，避免 idle 期间误报长会话

import type { CaptureBundle, ScreenshotRetentionPolicy } from "../models/types";
import type { ActivityService, ActivityWindowInfo, ActivitySignals } from "./ActivityService";
import type { SettingsService } from "./SettingsService";

/**
 * 活动更新信息（由 app.ts 从 ActivityService 事件转发给 SceneScheduler）
 */
export interface SceneSchedulerActivityInfo {
  /** 当前窗口 id（用于判断"同一窗口"是否仍活跃） */
  windowId?: number;
  /** 当前项目 id（ActivityService 层无 projectId，使用 appName 作为代理） */
  projectName: string;
}

/**
 * SceneScheduler 依赖
 */
export interface SceneSchedulerDeps {
  settingsService: SettingsService;
  activityService: ActivityService;
  /** 发出 scheduler 信号的回调（由 app.ts 接到 CaptureBatcher.flush） */
  emitCaptureBundle: (bundle: CaptureBundle) => void;
}

/**
 * 默认长会话间隔（分钟）
 * - 设置中未配置或读取失败时使用
 * - spec 默认 10 分钟
 */
const DEFAULT_LONG_SESSION_INTERVAL_MINUTES = 10;

/**
 * 默认截图保留策略（无截图，立即删除占位）
 */
const DEFAULT_RETENTION_POLICY: ScreenshotRetentionPolicy = "delete_immediately";

/**
 * SceneScheduler：长会话场景调度器
 *
 * 工作流：
 * 1. start() 启动周期性定时器（每分钟检查一次）
 * 2. updateActivity(info) 在窗口/项目变化时被调用，重置 lastActivityAt
 * 3. 定时器触发时：
 *    - 检查 Date.now() - lastActivityAt >= interval * 60 * 1000
 *    - 检查同一窗口/项目仍活跃（通过 ActivityService.getCurrentWindow）
 *    - 检查用户未处于 idle 状态
 *    - 满足条件时发出 captureReason="long_session" 的 CaptureBundle
 * 4. stop() 清理定时器（暂停或退出时调用）
 */
export class SceneScheduler {
  private readonly deps: SceneSchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private observing = false;

  /** 当前会话开始时间（窗口/项目变化时重置） */
  private lastActivityAt: number = 0;
  /** 当前窗口 id（用于判断"同一窗口"是否仍活跃） */
  private currentWindowId: number | undefined = undefined;
  /** 当前项目名（appName 代理） */
  private currentProjectName: string | null = null;

  constructor(deps: SceneSchedulerDeps) {
    this.deps = deps;
  }

  /**
   * 启动调度器
   * - 启动周期性定时器（每分钟检查一次）
   * - 初始化 lastActivityAt 为当前时间
   */
  start(): void {
    if (this.observing) return;
    this.observing = true;
    this.lastActivityAt = Date.now();
    // 每分钟检查一次，确保在 interval 到期后尽快触发
    this.timer = setInterval(() => {
      this.onTick().catch(() => {
        // 单次检查失败不阻断后续
      });
    }, 60 * 1000);
  }

  /**
   * 停止调度器
   * - 清理定时器
   * - 不补采暂停期间的内容
   */
  stop(): void {
    this.observing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 是否正在观察
   */
  isObserving(): boolean {
    return this.observing;
  }

  /**
   * 更新活动状态
   * - 由 app.ts 在 ActivityService 发出 capture-candidate 事件时调用
   * - 当窗口/项目变化时，重置 lastActivityAt（视为新会话开始）
   * - 当窗口/项目相同时，不重置 lastActivityAt（保持会话连续性）
   *
   * @param activityInfo 当前活动信息
   */
  updateActivity(activityInfo: SceneSchedulerActivityInfo): void {
    const now = Date.now();
    const windowChanged =
      this.currentWindowId !== undefined && activityInfo.windowId !== this.currentWindowId;
    const projectChanged =
      this.currentProjectName !== null && activityInfo.projectName !== this.currentProjectName;

    if (windowChanged || projectChanged) {
      // 新会话开始，重置计时
      this.lastActivityAt = now;
    }

    this.currentWindowId = activityInfo.windowId;
    this.currentProjectName = activityInfo.projectName;
  }

  /**
   * 定时器回调：检查是否应触发 long_session
   */
  private async onTick(): Promise<void> {
    if (!this.observing) return;

    const intervalMinutes = this.getIntervalMinutes();
    const intervalMs = intervalMinutes * 60 * 1000;
    const now = Date.now();

    // 条件 1：持续工作时长 >= interval
    if (now - this.lastActivityAt < intervalMs) {
      return;
    }

    // 条件 2：同一窗口/项目仍活跃
    const currentWindow = this.deps.activityService.getCurrentWindow();
    if (!currentWindow) {
      return;
    }
    if (currentWindow.windowId !== this.currentWindowId) {
      // 窗口已变化但 updateActivity 尚未被调用，同步状态并跳过本次
      this.currentWindowId = currentWindow.windowId;
      this.currentProjectName = currentWindow.appName;
      this.lastActivityAt = now;
      return;
    }

    // 条件 3：用户未处于 idle（idleSeconds < idleThreshold）
    const signals = this.deps.activityService.getCurrentSignals();
    const idleThresholdSeconds = this.getIdleThresholdSeconds();
    if (signals.idleSeconds >= idleThresholdSeconds) {
      // 用户已 idle，不触发 long_session（由 scene_boundary 处理 idle 转换）
      return;
    }

    // 满足条件，发出 long_session capture bundle
    this.emitLongSessionBundle(currentWindow, signals);
    // 重置 lastActivityAt，下一次 long_session 在 interval 后再触发
    this.lastActivityAt = now;
  }

  /**
   * 发出 captureReason="long_session" 的 CaptureBundle
   */
  private emitLongSessionBundle(
    window: ActivityWindowInfo,
    signals: ActivitySignals
  ): void {
    const bundle: CaptureBundle = {
      captureId: this.generateCaptureId(),
      capturedAt: new Date().toISOString(),
      timezone: this.getTimezone(),
      appName: window.appName,
      windowTitle: window.windowTitle,
      urlOrDomain: window.urlOrDomain,
      captureReason: "long_session",
      activitySignals: {
        keyboardActive: signals.keyboardActive,
        mouseActive: signals.mouseActive,
        idleSeconds: signals.idleSeconds,
        activeWindowStableSeconds: signals.activeWindowStableSeconds,
      },
      imagePaths: [], // SceneScheduler 不截图，由 ObserverWorker 处理元数据
      retentionPolicy: this.getRetentionPolicy(),
    };
    this.deps.emitCaptureBundle(bundle);
  }

  /**
   * 读取长会话间隔（分钟）
   * - 从 SettingsService.observation.longSessionIntervalMinutes 读取
   * - 读取失败时使用默认值 10
   */
  private getIntervalMinutes(): number {
    try {
      const minutes = this.deps.settingsService.getAll().observation.longSessionIntervalMinutes;
      return typeof minutes === "number" && minutes > 0 ? minutes : DEFAULT_LONG_SESSION_INTERVAL_MINUTES;
    } catch {
      return DEFAULT_LONG_SESSION_INTERVAL_MINUTES;
    }
  }

  /**
   * 读取 idle 阈值（秒）
   * - 从 SettingsService.observation.idleThresholdSeconds 读取
   * - 读取失败时使用默认值 120
   */
  private getIdleThresholdSeconds(): number {
    try {
      const seconds = this.deps.settingsService.getAll().observation.idleThresholdSeconds;
      return typeof seconds === "number" && seconds > 0 ? seconds : 120;
    } catch {
      return 120;
    }
  }

  /**
   * 读取截图保留策略
   * - SceneScheduler 不截图，但仍需提供保留策略字段
   * - 使用 delete_immediately（无截图可保留）
   */
  private getRetentionPolicy(): ScreenshotRetentionPolicy {
    return DEFAULT_RETENTION_POLICY;
  }

  /**
   * 获取系统时区
   */
  private getTimezone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  /**
   * 生成 captureId
   * - 格式：cap_<timestamp_base36>_<random>
   * - 与 CaptureService 的 ID 格式一致
   */
  private generateCaptureId(): string {
    return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
