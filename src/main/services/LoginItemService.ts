import type { App, LoginItemSettings, Settings } from "electron";

type LoginItemApp = Pick<App, "getAppPath" | "getLoginItemSettings" | "isPackaged" | "setLoginItemSettings">;

export class LoginItemService {
  constructor(
    private readonly app: LoginItemApp,
    private readonly executablePath: string = process.execPath
  ) {}

  getEnabled(): boolean {
    return this.app.getLoginItemSettings(this.getQueryOptions()).openAtLogin;
  }

  setEnabled(enabled: boolean): boolean {
    this.app.setLoginItemSettings({
      ...this.getQueryOptions(),
      openAtLogin: enabled,
      openAsHidden: true,
    });
    return this.getEnabled();
  }

  private getQueryOptions(): Settings {
    return {
      path: this.executablePath,
      args: this.app.isPackaged ? ["--hidden"] : [this.app.getAppPath(), "--hidden"],
    };
  }
}

export type { LoginItemSettings };
