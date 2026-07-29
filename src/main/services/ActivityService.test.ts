import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeWin: vi.fn(),
  getSystemIdleTime: vi.fn(),
}));

vi.mock("active-win", () => ({ default: mocks.activeWin }));
vi.mock("electron", () => ({
  powerMonitor: { getSystemIdleTime: mocks.getSystemIdleTime },
}));

import {
  ActivityService,
  CAPTURE_CANDIDATE_EVENT,
  type CaptureCandidateEvent,
} from "./ActivityService";

const windowA = activeWindow(41, "Editor", "Draft");
const windowB = activeWindow(42, "DingTalk", "Messages");

describe("ActivityService capture selection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T08:00:00.000Z"));
    mocks.activeWin.mockReset();
    mocks.getSystemIdleTime.mockReset();
    mocks.getSystemIdleTime.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits only the window transition and updates currentWindow before later content checks", async () => {
    mocks.activeWin
      .mockResolvedValueOnce(windowA)
      .mockResolvedValueOnce(windowB)
      .mockResolvedValue(windowB);
    const service = createService();
    const events = collectCandidates(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "project_switch",
      window: { windowId: 42, appName: "DingTalk", windowTitle: "Messages" },
    });
    expect(service.getCurrentWindow()).toMatchObject({ windowId: 42, appName: "DingTalk" });
    service.stop();
  });

  it("prioritizes an idle boundary over a simultaneous window change and uses the fresh window", async () => {
    mocks.activeWin
      .mockResolvedValueOnce(windowA)
      .mockResolvedValueOnce(windowB)
      .mockResolvedValue(windowB);
    mocks.getSystemIdleTime
      .mockReturnValueOnce(130)
      .mockReturnValue(0);
    const service = createService();
    const events = collectCandidates(service);

    service.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: "scene_boundary",
      window: { windowId: 42, appName: "DingTalk", windowTitle: "Messages" },
    });
    service.stop();
  });
});

function createService(): ActivityService {
  return new ActivityService({
    pollIntervalMs: 5_000,
    activeWindowStableSeconds: 30,
    contentChangeMinIntervalSeconds: 60,
    longSessionIntervalMinutes: 5,
    idleThresholdSeconds: 120,
  });
}

function collectCandidates(service: ActivityService): CaptureCandidateEvent[] {
  const events: CaptureCandidateEvent[] = [];
  service.on(CAPTURE_CANDIDATE_EVENT, (event: CaptureCandidateEvent) => events.push(event));
  return events;
}

function activeWindow(id: number, name: string, title: string) {
  return {
    id,
    title,
    owner: { name, processId: id + 1_000, path: `C:\\Apps\\${name}.exe` },
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    memoryUsage: 0,
  };
}
