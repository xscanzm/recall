import { describe, expect, it, vi } from "vitest";
import { LoginItemService } from "./LoginItemService";

function createApp(isPackaged: boolean, actualState: boolean) {
  let enabled = actualState;
  return {
    app: {
      isPackaged,
      getAppPath: vi.fn(() => "D:\\Recall"),
      setLoginItemSettings: vi.fn((settings: { openAtLogin?: boolean }) => {
        enabled = settings.openAtLogin ?? false;
      }),
      getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled })),
    },
  };
}

describe("LoginItemService", () => {
  it("uses the packaged executable and hidden argument for registration and verification", () => {
    const { app } = createApp(true, false);
    const service = new LoginItemService(app as never, "C:\\Program Files\\Recall\\Recall.exe");

    expect(service.setEnabled(true)).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
      path: "C:\\Program Files\\Recall\\Recall.exe",
      args: ["--hidden"],
    });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({
      path: "C:\\Program Files\\Recall\\Recall.exe",
      args: ["--hidden"],
    });
  });

  it("includes the app path when Electron is running an unpackaged app", () => {
    const { app } = createApp(false, true);
    const service = new LoginItemService(app as never, "C:\\Electron\\electron.exe");

    expect(service.getEnabled()).toBe(true);
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: "C:\\Electron\\electron.exe",
      args: ["D:\\Recall", "--hidden"],
    });
  });
});
