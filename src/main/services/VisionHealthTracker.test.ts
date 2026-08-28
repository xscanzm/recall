import { describe, expect, it } from "vitest";
import { VisionHealthTracker } from "./VisionHealthTracker";

function trackerWithClock() {
  let now = 1_000_000;
  const tracker = new VisionHealthTracker({ now: () => now });
  return { tracker, tick: (ms: number) => { now += ms; } };
}

describe("VisionHealthTracker", () => {
  it("starts closed: every batch goes to vision", () => {
    const { tracker } = trackerWithClock();
    expect(tracker.nextAction()).toBe("vision");
  });

  it("opens after first failure: subsequent batches use ocr", () => {
    const { tracker, tick } = trackerWithClock();
    tracker.recordFailure();
    expect(tracker.nextAction()).toBe("ocr");
    tick(1 * 60_000);
    expect(tracker.nextAction()).toBe("ocr"); // 默认冷却 5min 未到
  });

  it("probes after cooldown; failed probe re-opens with doubled cooldown", () => {
    const { tracker, tick } = trackerWithClock();
    tracker.recordFailure();                       // 第 1 次失败 → 冷却 5min
    tick(5 * 60_000 + 1);
    expect(tracker.nextAction()).toBe("probe_vision");
    tracker.recordFailure();                       // 探测失败 → 冷却 10min
    expect(tracker.nextAction()).toBe("ocr");
    tick(10 * 60_000 + 1);
    expect(tracker.nextAction()).toBe("probe_vision");
  });

  it("caps cooldown at 30min", () => {
    const { tracker, tick } = trackerWithClock();
    for (let i = 0; i < 10; i++) { tracker.recordFailure(); tick(60 * 60_000); }
    tracker.recordFailure();
    tick(30 * 60_000 + 1);
    expect(tracker.nextAction()).toBe("probe_vision");
    tick(-1);                              // 回退 1ms，应仍是 ocr
    expect(tracker.nextAction()).toBe("ocr");
  });

  it("success closes the breaker and resets failures", () => {
    const { tracker, tick } = trackerWithClock();
    tracker.recordFailure();
    tracker.recordSuccess();
    expect(tracker.nextAction()).toBe("vision");
    tracker.recordFailure();
    tick(5 * 60_000 + 1);                  // 重新从 5min 起算
    expect(tracker.nextAction()).toBe("probe_vision");
  });

  it("hydrate opens the breaker from trailing failed jobs and stops at first success", () => {
    const { tracker } = trackerWithClock();
    tracker.hydrate([
      { status: "failed", errorCode: "rate_limited" },  // 最新
      { status: "failed", errorCode: "rate_limited" },
      { status: "succeeded" },                           // 更早成功 → 停止
      { status: "failed", errorCode: "rate_limited" },
    ]);
    expect(tracker.getConsecutiveFailures()).toBe(2);
    expect(tracker.nextAction()).toBe("ocr");
  });

  it("hydrate ignores trailing running/pending rows", () => {
    const { tracker } = trackerWithClock();
    tracker.hydrate([{ status: "running" }, { status: "failed", errorCode: "timeout" }]);
    expect(tracker.getConsecutiveFailures()).toBe(1);
  });
});
