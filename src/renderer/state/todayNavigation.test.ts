import { describe, expect, it } from "vitest";
import { isCurrentTodayPageRequest, shouldRollOverTodayDate } from "./todayNavigation";

describe("Today date navigation", () => {
  it("rolls over only while following today", () => {
    expect(shouldRollOverTodayDate("2026-07-10", "2026-07-11", true)).toBe(true);
    expect(shouldRollOverTodayDate("2026-07-10", "2026-07-11", false)).toBe(false);
  });

  it("rejects stale responses and responses for an older selected date", () => {
    expect(isCurrentTodayPageRequest(2, 2, "2026-07-11", "2026-07-11")).toBe(true);
    expect(isCurrentTodayPageRequest(1, 2, "2026-07-10", "2026-07-11")).toBe(false);
    expect(isCurrentTodayPageRequest(2, 2, "2026-07-10", "2026-07-11")).toBe(false);
  });
});
