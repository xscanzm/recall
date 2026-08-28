// src/main/services/VisionHealthTracker.ts
// 视觉链路健康熔断器（内存态，重启后由 app.ts 用最近 model_jobs 水合）
//
// 政策（免费上游容量有限，失败一次 = 队列已烧 3 次尝试 × 90s 退避）：
// - closed：正常走视觉
// - 首次失败即 open（容量类故障不是瞬态抖动），冷却 5min 起
// - 冷却结束放行一个"探测"批次（probe_vision）：成功闭合，失败重开且冷却翻倍（30min 封顶）
// - 成功重置计数

export type VisionHealthState = "closed" | "open";
export type VisionNextAction = "vision" | "probe_vision" | "ocr";

const DEFAULT_COOLDOWN_BASE_MS = 5 * 60_000;
const DEFAULT_COOLDOWN_CAP_MS = 30 * 60_000;

export interface VisionJobOutcome {
  status: "succeeded" | "failed" | "running" | "pending";
  errorCode?: string | null;
}

export class VisionHealthTracker {
  private state: VisionHealthState = "closed";
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(
    private readonly opts: {
      cooldownBaseMs?: number;
      cooldownCapMs?: number;
      now?: () => number;
    } = {}
  ) {}

  nextAction(): VisionNextAction {
    if (this.state === "closed") return "vision";
    // 严格大于：冷却期恰好结束时仍视为冷却中（探测只在冷却期结束后放行）
    return this.currentTime() > this.openUntil ? "probe_vision" : "ocr";
  }

  getState(): VisionHealthState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  recordSuccess(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.state = "open";
    const base = this.opts.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS;
    const cap = this.opts.cooldownCapMs ?? DEFAULT_COOLDOWN_CAP_MS;
    const cooldown = Math.min(cap, base * 2 ** (this.consecutiveFailures - 1));
    this.openUntil = this.currentTime() + cooldown;
  }

  /** 用最近的 model_jobs 结果水合（调用方按时间倒序传入并完成窗口过滤） */
  hydrate(recentOutcomesDesc: VisionJobOutcome[]): void {
    for (const outcome of recentOutcomesDesc) {
      if (outcome.status === "succeeded") break;
      if (outcome.status === "failed") this.recordFailure();
    }
  }

  private currentTime(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
