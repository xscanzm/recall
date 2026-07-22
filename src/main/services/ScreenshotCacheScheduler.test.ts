import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startScreenshotCacheScheduler,
  stopScreenshotCacheScheduler,
} from "./ScreenshotCacheScheduler";

describe("ScreenshotCacheScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopScreenshotCacheScheduler();
  });

  afterEach(() => {
    stopScreenshotCacheScheduler();
    vi.useRealTimers();
  });

  it("protects pending OCR source images from scheduled cleanup", async () => {
    const cleanupExpired = vi.fn(async () => ({
      deletedScreenshots: 0,
      freedBytes: 0,
    }));
    startScreenshotCacheScheduler({
      screenshotCache: { cleanupExpired } as never,
      settingsService: {
        getAll: () => ({ screenshot: { retentionPolicy: "delete_immediately" } }),
      } as never,
      getProtectedImagePaths: () => ["C:\\cache\\pending.png"],
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(cleanupExpired).toHaveBeenCalledWith(
      "delete_immediately",
      ["C:\\cache\\pending.png"]
    );
  });
});
