// src/main/services/TrayService.ts
// 托盘菜单服务（来自 06 文档）
//
// 职责：
// - 提供托盘入口（暂停/恢复/显示主界面/退出）
// - 后台常驻能力
// - 关闭窗口时最小化到托盘
// - 显示主窗口：
//   - Windows：双击托盘图标
//   - macOS：单击托盘图标（macOS 习惯单击即可唤起，且 menu bar 应用普遍单击交互）
//
// macOS 特殊处理：
// - 关闭主窗口时同时 app.dock.hide()，让用户感觉应用已退到 menu bar
// - 显示主窗口时 app.dock.show() + activate，恢复 Dock 图标
// - 托盘图标使用 template image（自动适配深浅主题）
//
// 重要约束：
// - 不使用眼睛/摄像头/大脑 logo（托盘图标使用回环线 + 3 节点概念）
// - 中文标签
// - 退出时通过 isQuitting 标志拦截 close 事件

import { app, BrowserWindow, Tray, Menu, nativeImage } from "electron";
import * as path from "node:path";
import { APP_NAME_ZH } from "../../shared/constants";

/**
 * 托盘依赖注入
 * - getStatus: 获取当前 AppStatus（用于动态切换菜单文案）
 * - startObserving/pauseObserving: 控制观察状态
 * - getMainWindow: 获取主窗口（可能为 null）
 * - createMainWindow: 创建新主窗口（若原窗口已关闭）
 * - onQuit: 用户点击退出时的清理回调
 */
export interface TrayServiceDeps {
  getStatus: () => {
    observing: boolean;
    paused: boolean;
    pipelineState: string;
    lastError?: string;
  };
  startObserving: () => void | Promise<void>;
  pauseObserving: () => void | Promise<void>;
  getMainWindow: () => BrowserWindow | null;
  createMainWindow: () => BrowserWindow;
  onQuit: () => void;
}

/**
 * 托盘菜单服务
 *
 * 使用方式：
 *   const trayService = new TrayService(deps);
 *   trayService.init();
 *   // 当 AppStatus 变化时调用：
 *   trayService.updateMenu();
 *   // 应用退出前调用：
 *   trayService.destroy();
 */
export class TrayService {
  private deps: TrayServiceDeps | null = null;
  private tray: Tray | null = null;
  private isQuitting = false;

  /**
   * 初始化托盘
   * 必须在 app.whenReady() 之后调用
   */
  init(deps: TrayServiceDeps): void {
    this.deps = deps;
    const icon = this.createTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip(`${APP_NAME_ZH} Recall`);
    this.tray.setContextMenu(this.buildMenu());

    if (process.platform === "darwin") {
      // macOS：单击托盘图标显示主界面（menu bar 应用习惯单击交互）
      // 不再监听 double-click，避免单击/双击事件冲突
      this.tray.on("click", () => {
        this.showMainWindow();
      });
    } else {
      // Windows：双击托盘图标显示主界面
      this.tray.on("double-click", () => {
        this.showMainWindow();
      });
    }

    // 拦截主窗口关闭事件：隐藏到托盘而不是退出
    this.attachWindowCloseHandler();
  }

  /**
   * 销毁托盘
   */
  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    this.deps = null;
  }

  /**
   * 通知 TrayService 即将退出
   * 让 close handler 不再拦截下次关闭事件
   */
  notifyQuitting(): void {
    this.isQuitting = true;
  }

  /**
   * 根据当前 AppStatus 更新托盘菜单
   * 应在 AppStatus 变化时调用
   */
  updateMenu(): void {
    if (!this.tray || !this.deps) return;
    this.tray.setContextMenu(this.buildMenu());
  }

  /**
   * 显示主窗口
   * - 若主窗口已存在：显示并聚焦
   * - 若主窗口已被销毁：创建新窗口
   *
   * macOS：同时 app.dock.show() 让 Dock 图标恢复可见，
   * 并通过 win.show() + app.dock.activate() 让窗口获得焦点
   */
  showMainWindow(): void {
    if (!this.deps) return;
    const existing = this.deps.getMainWindow();
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      // macOS：恢复 Dock 图标可见
      if (process.platform === "darwin" && app.dock) {
        app.dock.show().catch(() => {
          // dock.show 失败不致命，窗口已经显示
        });
      }
    } else {
      this.deps.createMainWindow();
      // 新窗口创建后 macOS 上 Dock 图标默认可见，无需显式 show
    }
  }

  /**
   * 是否正在退出
   */
  isQuittingNow(): boolean {
    return this.isQuitting;
  }

  // ----------------------------------------------------------------
  // 内部实现
  // ----------------------------------------------------------------

  /**
   * 创建托盘图标
   * - 优先加载打包/开发环境下的 icon.png
   * - 失败则使用回环线 + 3 节点的程序化生成图标
   *
   * 重要：不使用眼睛/摄像头/大脑 logo
   */
  private createTrayIcon(): Electron.NativeImage {
    // 1. 尝试加载资源目录下的 icon.png（生产环境打包后位于 dist/main/resources/）
    const iconPath = this.resolveIconPath();
    if (iconPath) {
      try {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          // Windows 托盘推荐 16x16 或 32x32，macOS 开启 template 模式适应深浅主题
          const resized = icon.resize({ width: 16, height: 16 });
          if (process.platform === "darwin") {
            resized.setTemplateImage(true);
          }
          return resized;
        }
      } catch {
        // 加载失败，使用程序化生成的图标
      }
    }

    // 2. 程序化生成一个简单的回环线 + 3 节点图标（16x16）
    // 使用 PNG base64 编码的简单 16x16 图标
    return this.generateEchoLoopIcon();
  }

  /**
   * 解析图标文件路径
   * - 优先使用 resources/icons/tray-32.png（圆角矩形浅色版 @2x）
   * - 回退到 resources/icons/tray-16.png（@1x）
   * - 开发模式：从 dist/main/services 上溯到项目根 resources/icons/
   * - 打包模式：process.resourcesPath/icons/
   *
   * 由 scripts/build-logos.mjs 统一生成，所有尺寸见 resources/icons/README.md
   */
  private resolveIconPath(): string | null {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, "icons", "tray-32.png");
    }
    // 开发模式：从 dist/main/services 上溯到项目根
    // __dirname 在编译产物中是 dist/main/services
    return path.join(__dirname, "..", "..", "..", "resources", "icons", "tray-32.png");
  }

  /**
   * 程序化生成回环线 + 3 节点托盘图标
   * - 16x16 透明背景
   * - 使用 nativeImage 的 buffer API 构造最简单的占位图
   *
   * 重要：这是 fallback 方案，正式图标应通过 icon.png 加载
   * 此处使用空图标（实际显示为系统默认托盘图标），避免引入额外依赖
   * 若需更精致的图标，请在 resources/icon.png 放置实际文件
   */
  private generateEchoLoopIcon(): Electron.NativeImage {
    // 使用 createEmpty 创建空图标，系统会显示默认托盘图标
    // 这避免了在没有图标资源时 Tray 构造失败
    return nativeImage.createEmpty();
  }

  /**
   * 构建托盘菜单
   * - 顶部：应用名 + 当前状态（不可点击）
   * - 显示主界面
   * - 暂停/恢复观察（根据 status 动态切换）
   * - 退出
   */
  private buildMenu(): Menu {
    if (!this.deps) {
      return Menu.buildFromTemplate([]);
    }
    const status = this.deps.getStatus();
    const observingLabel = status.paused
      ? "已暂停"
      : status.observing
        ? "观察中"
        : "未开始观察";

    return Menu.buildFromTemplate([
      { label: `${APP_NAME_ZH} Recall - ${observingLabel}`, enabled: false },
      { type: "separator" },
      {
        label: "显示主界面",
        click: () => {
          this.showMainWindow();
        },
      },
      {
        label: status.paused ? "恢复观察" : "暂停观察",
        click: () => {
          if (!this.deps) return;
          const action = status.paused
            ? this.deps.startObserving()
            : this.deps.pauseObserving();
          void Promise.resolve(action).finally(() => this.updateMenu());
        },
      },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          if (!this.deps) return;
          this.isQuitting = true;
          this.deps.onQuit();
        },
      },
    ]);
  }

  /**
   * 拦截主窗口 close 事件
   * - 当用户点击关闭按钮时，隐藏到托盘而不是退出
   * - isQuitting=true 时允许真正退出
   *
   * macOS：隐藏窗口时同时 app.dock.hide()，
   * 让用户感知"应用已退到 menu bar"，符合 menu bar 应用习惯
   *
   * 必须在主窗口创建后立即调用
   */
  private attachWindowCloseHandler(): void {
    if (!this.deps) return;
    const win = this.deps.getMainWindow();
    if (!win) return;
    win.on("close", (event: Electron.Event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        win.hide();
        // macOS：窗口隐藏后同时隐藏 Dock 图标，应用仅留在 menu bar
        if (process.platform === "darwin" && app.dock) {
          app.dock.hide();
        }
      }
    });
  }
}

/**
 * 单例
 *
 * 注意：单例不持有 deps，必须在 init 时传入
 * app.ts 在 app.whenReady() 中调用 trayService.init(deps) 后才生效
 */
export const trayService = new TrayService();
