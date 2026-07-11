import { describe, expect, it } from "vitest";
import { findMatchingWindowSource } from "./CaptureService";

const sources = [
  { id: "window:41:0", name: "Recall - Notes" },
  { id: "window:42:0", name: "Recall - Notes" },
  { id: "window:43:0", name: " Recall - Notes " },
];

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
