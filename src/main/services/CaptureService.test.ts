import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const electronMocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  getAllDisplays: vi.fn(),
  getDisplayMatching: vi.fn(),
  screenToDipRect: vi.fn(),
}));

vi.mock("electron", () => ({
  desktopCapturer: { getSources: electronMocks.getSources },
  screen: {
    getAllDisplays: electronMocks.getAllDisplays,
    getDisplayMatching: electronMocks.getDisplayMatching,
    screenToDipRect: electronMocks.screenToDipRect,
  },
}));

import {
  analyzeCaptureVisualQuality,
  calculateScreenCrop,
  CaptureService,
  coalesceCaptureCandidate,
  findMatchingWindowSource,
  shouldUseScreenCropFallback,
} from "./CaptureService";
import type { CaptureServiceConfig, WindowFrameSource } from "./CaptureService";
import type {
  ActivityWindowInfo,
  CaptureCandidateEvent,
  CaptureTriggerReason,
} from "./ActivityService";

const sources = [
  { id: "window:41:0", name: "Recall - Notes" },
  { id: "window:42:0", name: "Recall - Notes" },
  { id: "window:43:0", name: " Recall - Notes " },
];

beforeEach(() => {
  electronMocks.getSources.mockReset();
  electronMocks.getAllDisplays.mockReset().mockReturnValue([]);
  electronMocks.getDisplayMatching.mockReset();
  electronMocks.screenToDipRect.mockReset().mockImplementation((_window, bounds) => bounds);
});

describe("findMatchingWindowSource", () => {
  it("requires both the native window id and the exact trimmed title", () => {
    expect(findMatchingWindowSource(sources, { windowId: 42, windowTitle: "Recall - Notes" }))
      .toBe(sources[1]);
    expect(findMatchingWindowSource(sources, { windowId: 42, windowTitle: "Other" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowId: 99, windowTitle: "Recall - Notes" })).toBeUndefined();
  });

  it("never falls back to a partial, case-insensitive, or empty title match", () => {
    expect(findMatchingWindowSource(sources, { windowTitle: "Recall" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowTitle: "recall - notes" })).toBeUndefined();
    expect(findMatchingWindowSource(sources, { windowTitle: "   " })).toBeUndefined();
  });
});

describe("capture quality fallback", () => {
  it("detects a pure black WPS-style frame as degenerate", async () => {
    const quality = await analyzeCaptureVisualQuality(await solidPng("#000000"));

    expect(quality.nearBlackRatio).toBe(1);
    expect(quality.isDegenerate).toBe(true);
  });

  it("still detects a black frame with one small UI overlay", async () => {
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: "#000000" },
    })
      .composite([{
        input: Buffer.from('<svg width="100" height="30"><rect width="100" height="30" fill="white"/><text x="8" y="20" font-size="12">SUM</text></svg>'),
        left: 320,
        top: 280,
      }])
      .png()
      .toBuffer();
    const quality = await analyzeCaptureVisualQuality(image);

    expect(quality.nearBlackRatio).toBeGreaterThan(0.99);
    expect(quality.isDegenerate).toBe(true);
  }, 15_000);

  it("selects a materially richer screen crop but not another black image", async () => {
    const blackQuality = await analyzeCaptureVisualQuality(await solidPng("#000000"));
    const worksheetQuality = await analyzeCaptureVisualQuality(await worksheetPng());

    expect(worksheetQuality.isDegenerate).toBe(false);
    expect(shouldUseScreenCropFallback(blackQuality, worksheetQuality)).toBe(true);
    expect(shouldUseScreenCropFallback(blackQuality, blackQuality)).toBe(false);
  });
});

describe("calculateScreenCrop", () => {
  it("maps display-independent window bounds to a 150% screen thumbnail", () => {
    expect(calculateScreenCrop(
      { x: 1360, y: 100, width: 800, height: 500 },
      { x: 1280, y: 0, width: 1280, height: 720 },
      { width: 1920, height: 1080 }
    )).toEqual({
      region: { left: 120, top: 150, width: 1200, height: 750 },
      coverage: 1,
    });
  });

  it("reports partial coverage so cross-display crops can be rejected", () => {
    const crop = calculateScreenCrop(
      { x: 1100, y: 100, width: 400, height: 500 },
      { x: 1280, y: 0, width: 1280, height: 720 },
      { width: 1920, height: 1080 }
    );

    expect(crop?.coverage).toBeCloseTo(0.55);
  });
});

describe("capture candidate scheduling", () => {
  it("keeps a single pending candidate and prefers a higher-priority reason for the same window", () => {
    const content = candidate("content_changed");
    const boundary = candidate("scene_boundary");

    expect(coalesceCaptureCandidate(content, boundary)).toBe(boundary);
    expect(coalesceCaptureCandidate(boundary, content)).toBe(boundary);
  });

  it("serializes desktop capture and coalesces a burst into one pending capture", async () => {
    const png = await worksheetPng();
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    // 串行化现在要在首选后端（单窗口抓图）上验证：旧的全窗口缩略图路径已默认禁用，
    // 用它来测串行化会让这个测试悄悄跑在一条产品里不再走的代码上。
    const grab = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { png };
    });

    const activityService = new FakeActivityService();
    const service = new CaptureService();
    service.setDependencies({
      activityService: activityService as never,
      privacyGuard: {
        checkBeforeCapture: () => ({ allowed: true }),
      } as never,
      screenshotCache: {
        save: vi.fn(async () => ({ filePath: "C:\\Recall\\capture.png", bytes: png.length })),
      } as never,
      settingsService: {
        getAll: () => ({ screenshot: { retentionPolicy: "today" } }),
      } as never,
      windowFrameSource: {
        listWindowSources: async () => [{ id: "window:42:0", name: "Messages" }],
        grab,
      },
    });
    const capturedReasons: string[] = [];
    service.on("capture-bundle", (bundle) => capturedReasons.push(bundle.captureReason));
    service.start();

    activityService.emit("capture-candidate", candidate("content_changed"));
    activityService.emit("capture-candidate", candidate("window_title_changed"));
    activityService.emit("capture-candidate", candidate("project_switch"));
    const manualCapture = service.captureActiveWindow();

    await vi.waitFor(() => expect(grab).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(grab).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await manualCapture;
    await vi.waitFor(() => expect(grab).toHaveBeenCalledTimes(3));
    releases.shift()?.();
    await service.drain();

    expect(maxInFlight).toBe(1);
    expect(grab).toHaveBeenCalledTimes(3);
    expect(capturedReasons).toEqual(["content_changed", "manual_capture", "project_switch"]);
    // 整个过程中一次全窗口枚举都不该发生
    expect(electronMocks.getSources).not.toHaveBeenCalled();
    service.stop();
  });
});

async function solidPng(color: string): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 600, channels: 3, background: color },
  }).png().toBuffer();
}

async function worksheetPng(): Promise<Buffer> {
  const lines = Array.from({ length: 18 }, (_, index) =>
    `<line x1="0" y1="${index * 32}" x2="800" y2="${index * 32}" stroke="#b6bcc6"/>`
  ).join("");
  const columns = Array.from({ length: 12 }, (_, index) =>
    `<line x1="${index * 70}" y1="0" x2="${index * 70}" y2="600" stroke="#b6bcc6"/>`
  ).join("");
  return sharp(Buffer.from(
    `<svg width="800" height="600"><rect width="800" height="600" fill="#ffffff"/>${lines}${columns}<text x="80" y="80" font-size="24">WPS worksheet 123</text></svg>`
  )).png().toBuffer();
}

function candidate(reason: CaptureTriggerReason): CaptureCandidateEvent {
  return {
    reason,
    window: {
      appName: "DingTalk",
      windowTitle: "Messages",
      windowId: 42,
      processId: 1_042,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
    },
    signals: {
      keyboardActive: true,
      mouseActive: true,
      idleSeconds: 0,
      activeWindowStableSeconds: 30,
    },
    triggeredAt: new Date().toISOString(),
  };
}

class FakeActivityService extends EventEmitter {
  /** 遮挡门禁读到的窗口快照。null 表示"取不到"，与空数组语义不同。 */
  snapshot: ActivityWindowInfo[] | null = null;

  getCurrentWindow() {
    return candidate("manual_capture").window;
  }

  getCurrentSignals() {
    return candidate("manual_capture").signals;
  }

  getIdleThresholdSeconds() {
    return 120;
  }

  async getFreshActiveWindowInfo() {
    return this.getCurrentWindow();
  }

  async getOpenWindowsSnapshot() {
    return this.snapshot;
  }
}

// ---------------------------------------------------------------------------
// 降级链与遮挡门禁
//
// 这一组测试要守住的是"对第三方窗口的伤害面"这个不变量，不只是"能不能拿到图"：
// 首选后端只碰目标窗口一个；整屏裁剪不碰任何窗口，但必须先证明目标那块矩形归它自己；
// 旧的全窗口缩略图路径会把系统里每个窗口都真实抓一遍（Windows 上还会发 WM_PRINT
// 强制对方在自己 UI 线程上同步渲染，已观察到钉钉因此白屏），所以默认必须走不到。
// ---------------------------------------------------------------------------

/** 目标窗口在窗口快照里的样子（与 candidate() 里的活动窗口一致） */
const TARGET_SNAPSHOT_ENTRY: ActivityWindowInfo = {
  appName: "DingTalk",
  windowTitle: "Messages",
  windowId: 42,
  processId: 1_042,
  bounds: { x: 0, y: 0, width: 1280, height: 720 },
};

describe("capture backend fallback chain", () => {
  it("uses the single-window backend and never enumerates every window", async () => {
    const harness = buildChainHarness({ primaryPng: await worksheetPng() });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle?.captureMethod).toBe("window_display_media");
    expect(harness.grab).toHaveBeenCalledWith({ id: "window:42:0", name: "Messages" });
    // 首选后端成功时，屏幕枚举和全窗口枚举都不该发生
    expect(electronMocks.getSources).not.toHaveBeenCalled();
  });

  it("falls through to the screen crop when the single-window frame comes back blank", async () => {
    const harness = buildChainHarness({
      primaryPng: await solidPng("#000000"),
      snapshot: [TARGET_SNAPSHOT_ENTRY],
      screenPng: await screenPng(),
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle?.captureMethod).toBe("screen_crop_fallback");
    expect(harness.enumerations("screen")).toBe(1);
    // 关键：一帧退化不等于可以退回旧的全窗口路径
    expect(harness.enumerations("window")).toBe(0);
  });

  it("skips the capture rather than touching every window when both safe backends fail", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: [TARGET_SNAPSHOT_ENTRY],
      screenPng: null,
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle).toBeNull();
    await vi.waitFor(() => expect(harness.skipped).toEqual(["no_safe_backend"]));
    expect(harness.enumerations("window")).toBe(0);
  });

  it("only touches every window when the legacy path is explicitly enabled", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: null,
      screenPng: null,
      legacyPng: await worksheetPng(),
      config: { allowLegacyWindowThumbnailCapture: true },
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle?.captureMethod).toBe("window");
    expect(harness.enumerations("window")).toBe(1);
  });
});

describe("screen crop occlusion gate", () => {
  it("refuses the crop when the window snapshot is unavailable", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: null,
      screenPng: await screenPng(),
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle).toBeNull();
    // 门禁在抓屏之前就拦下了：证明不了那块矩形归目标，就连一张屏幕图都不抓
    expect(harness.enumerations("screen")).toBe(0);
    await vi.waitFor(() => expect(harness.skipped).toEqual(["no_safe_backend"]));
  });

  it("refuses the crop when a sensitive window covers the target", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: [occluderEntry("1Password", 0.1), TARGET_SNAPSHOT_ENTRY],
      screenPng: await screenPng(),
      denyAppNames: ["1Password"],
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle).toBeNull();
    expect(harness.enumerations("screen")).toBe(0);
    await vi.waitFor(() => expect(harness.skipped).toEqual(["occluded"]));
  });

  it("allows a small benign occlusion", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: [occluderEntry("Notepad", 0.2), TARGET_SNAPSHOT_ENTRY],
      screenPng: await screenPng(),
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle?.captureMethod).toBe("screen_crop_fallback");
    expect(harness.enumerations("screen")).toBe(1);
  });

  it("refuses a benign occlusion that covers most of the target", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      snapshot: [occluderEntry("Notepad", 0.5), TARGET_SNAPSHOT_ENTRY],
      screenPng: await screenPng(),
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle).toBeNull();
    expect(harness.enumerations("screen")).toBe(0);
    await vi.waitFor(() => expect(harness.skipped).toEqual(["occluded"]));
  });

  it("ignores a window that sits behind the target in Z-order", async () => {
    const harness = buildChainHarness({
      primaryPng: null,
      // 敏感窗口在目标**之后**（Z 序更靠后 = 压在下面），不构成遮挡，也不该拦
      snapshot: [TARGET_SNAPSHOT_ENTRY, occluderEntry("1Password", 0.9)],
      screenPng: await screenPng(),
      denyAppNames: ["1Password"],
    });

    const bundle = await harness.service.captureActiveWindow();

    expect(bundle?.captureMethod).toBe("screen_crop_fallback");
  });
});

interface ChainHarnessOptions {
  /** 后端 1 返回的 PNG；null 表示这条路拿不到图 */
  primaryPng?: Buffer | null;
  /** 遮挡门禁读到的窗口快照（Z 序，最前的在数组开头） */
  snapshot?: ActivityWindowInfo[] | null;
  /** 整屏抓图返回的 PNG；null 表示抓不到屏 */
  screenPng?: Buffer | null;
  /** 旧全窗口缩略图路径返回的 PNG */
  legacyPng?: Buffer | null;
  /** 会被 PrivacyGuard 拦下的 appName（模拟用户自己配的黑名单） */
  denyAppNames?: string[];
  config?: CaptureServiceConfig;
}

interface ChainHarness {
  service: CaptureService;
  grab: ReturnType<typeof vi.fn>;
  /** capture-skipped 收到的 reason。事件走 setImmediate 发出，断言前要 waitFor */
  skipped: string[];
  /** 某种类型的 desktopCapturer 枚举发生了几次 */
  enumerations(type: "screen" | "window"): number;
}

function buildChainHarness(options: ChainHarnessOptions): ChainHarness {
  const {
    primaryPng = null,
    snapshot = null,
    screenPng: screenImage = null,
    legacyPng = null,
    denyAppNames = [],
    config,
  } = options;

  const display = { id: 7, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1 };
  electronMocks.getDisplayMatching.mockReturnValue(display);
  electronMocks.getAllDisplays.mockReturnValue([display]);
  electronMocks.getSources.mockImplementation(async (requested: { types?: string[] }) => {
    if (requested?.types?.includes("screen")) {
      if (!screenImage) return [];
      return [{
        id: "screen:7:0",
        display_id: "7",
        name: "Screen 1",
        thumbnail: {
          isEmpty: () => false,
          getSize: () => ({ width: 1280, height: 720 }),
          toPNG: () => screenImage,
        },
      }];
    }
    if (!legacyPng) return [];
    return [{
      id: "window:42:0",
      name: "Messages",
      thumbnail: { isEmpty: () => false, toPNG: () => legacyPng },
    }];
  });

  const grab = vi.fn(async () => (primaryPng ? { png: primaryPng } : null));
  const windowFrameSource: WindowFrameSource = {
    listWindowSources: async () => [{ id: "window:42:0", name: "Messages" }],
    grab,
  };

  const activityService = new FakeActivityService();
  activityService.snapshot = snapshot;

  const service = new CaptureService(config);
  service.setDependencies({
    activityService: activityService as never,
    privacyGuard: {
      checkBeforeCapture: (input: { appName: string }) =>
        denyAppNames.includes(input.appName)
          ? { allowed: false, reason: "blacklist_app" }
          : { allowed: true, reason: "ok" },
    } as never,
    screenshotCache: {
      save: vi.fn(async () => ({ filePath: "C:\\Recall\\capture.png", bytes: 1 })),
    } as never,
    settingsService: {
      getAll: () => ({ screenshot: { retentionPolicy: "today" } }),
    } as never,
    windowFrameSource,
  });

  const skipped: string[] = [];
  service.on("capture-skipped", (event) => skipped.push(event.reason));

  return {
    service,
    grab,
    skipped,
    enumerations(type) {
      return electronMocks.getSources.mock.calls.filter(
        ([requested]) => (requested as { types?: string[] } | undefined)?.types?.includes(type)
      ).length;
    },
  };
}

/** 压在目标窗口上面的窗口，按目标高度的比例给遮挡面积（目标是 1280x720 满宽） */
function occluderEntry(appName: string, coverageRatio: number): ActivityWindowInfo {
  return {
    appName,
    windowTitle: `${appName} - untitled`,
    windowId: 777,
    processId: 2_777,
    bounds: { x: 0, y: 0, width: 1280, height: Math.round(720 * coverageRatio) },
  };
}

/** 整屏抓图用的 PNG：尺寸必须与 mock 的 display / thumbnail 一致，否则裁剪会失败 */
async function screenPng(): Promise<Buffer> {
  const lines = Array.from({ length: 22 }, (_, index) =>
    `<line x1="0" y1="${index * 32}" x2="1280" y2="${index * 32}" stroke="#b6bcc6"/>`
  ).join("");
  const columns = Array.from({ length: 18 }, (_, index) =>
    `<line x1="${index * 70}" y1="0" x2="${index * 70}" y2="720" stroke="#b6bcc6"/>`
  ).join("");
  return sharp(Buffer.from(
    `<svg width="1280" height="720"><rect width="1280" height="720" fill="#ffffff"/>`
    + `${lines}${columns}<text x="80" y="80" font-size="24">DingTalk conversation 123</text></svg>`
  )).png().toBuffer();
}
