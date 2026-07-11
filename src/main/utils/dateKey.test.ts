import { describe, expect, it } from "vitest";
import { addDaysToDateKey, formatLocalDateKey, localDayUtcRange } from "./dateKey";

describe("localDayUtcRange", () => {
  it("returns a half-open range between consecutive local midnights", () => {
    const input = new Date(2026, 6, 11, 12, 30);
    const range = localDayUtcRange(input);
    const start = new Date(range.start);
    const end = new Date(range.end);
    expect([start.getFullYear(), start.getMonth(), start.getDate(), start.getHours()]).toEqual([2026, 6, 11, 0]);
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours()]).toEqual([2026, 6, 12, 0]);
    expect(range.start.endsWith("Z")).toBe(true);
    expect(range.end.endsWith("Z")).toBe(true);
  });

  it("uses consecutive local midnights across a DST boundary when the timezone has one", () => {
    const januaryOffset = new Date(2026, 0, 15).getTimezoneOffset();
    const julyOffset = new Date(2026, 6, 15).getTimezoneOffset();
    const transition = Array.from({ length: 365 }, (_, day) => {
      const date = new Date(2026, 0, day + 1, 12);
      const next = new Date(2026, 0, day + 2, 12);
      return date.getTimezoneOffset() !== next.getTimezoneOffset() ? date : null;
    }).find(Boolean);

    if (januaryOffset === julyOffset || !transition) return;
    const range = localDayUtcRange(transition);
    const durationHours = (Date.parse(range.end) - Date.parse(range.start)) / 3_600_000;
    expect([23, 25]).toContain(durationHours);
    expect(new Date(range.start).getHours()).toBe(0);
    expect(new Date(range.end).getHours()).toBe(0);
  });

  it("keeps calendar arithmetic and formatting in local time", () => {
    expect(formatLocalDateKey(new Date(2026, 0, 2, 0, 5))).toBe("2026-01-02");
    expect(addDaysToDateKey("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });
});
