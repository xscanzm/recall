import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveDefaultDatabasePath } from "../maintain-recall-data";

describe("resolveDefaultDatabasePath", () => {
  const homeDir = "/Users/testuser";

  it("uses %APPDATA% on Windows when set", () => {
    const appData = "C:\\Users\\testuser\\AppData\\Roaming";
    expect(resolveDefaultDatabasePath({
      platform: "win32",
      env: { APPDATA: appData },
      homeDir,
    })).toBe(path.join(appData, "Recall", "data", "recall.db"));
  });

  it("falls back to ~/AppData/Roaming on Windows when APPDATA is unset", () => {
    expect(resolveDefaultDatabasePath({
      platform: "win32",
      env: {},
      homeDir,
    })).toBe(path.join(homeDir, "AppData", "Roaming", "Recall", "data", "recall.db"));
  });

  it("falls back to ~/AppData/Roaming on Windows when APPDATA is empty", () => {
    expect(resolveDefaultDatabasePath({
      platform: "win32",
      env: { APPDATA: "" },
      homeDir,
    })).toBe(path.join(homeDir, "AppData", "Roaming", "Recall", "data", "recall.db"));
  });

  it("ignores APPDATA on non-Windows platforms", () => {
    expect(resolveDefaultDatabasePath({
      platform: "darwin",
      env: { APPDATA: "C:\\Windows\\should-not-be-used" },
      homeDir,
    })).toBe(path.join(homeDir, "Library", "Application Support", "Recall", "data", "recall.db"));
  });

  it("resolves macOS default under ~/Library/Application Support", () => {
    expect(resolveDefaultDatabasePath({
      platform: "darwin",
      env: {},
      homeDir,
    })).toBe(path.join(homeDir, "Library", "Application Support", "Recall", "data", "recall.db"));
  });

  it("resolves Linux default under ~/.config", () => {
    expect(resolveDefaultDatabasePath({
      platform: "linux",
      env: {},
      homeDir,
    })).toBe(path.join(homeDir, ".config", "Recall", "data", "recall.db"));
  });
});
