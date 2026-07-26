// src/main/services/navigationGuard.ts
// BrowserWindow 导航白名单判定
//
// 背景：renderer 渲染的内容包含两类不可信输入
// - OCR 出来的屏幕文字（用户屏幕上任何应用的内容）
// - 多模态/语言模型生成的报告正文
//
// prompts.ts 在模型层做了 prompt injection 防御，但那是纵深的第一层。
// 万一模型被绕过吐出可点击链接或触发 window.open，主进程必须兜住：
// - 新窗口一律拒绝（外部链接走 memory:openSourceUrl → shell.openExternal，那里校验协议）
// - 导航只允许打包后的 renderer 目录与 dev server
//
// 本模块只做纯判定，方便单测覆盖；副作用（preventDefault / 日志）在 app.ts 里。

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";
import { logger } from "./Logger";

export interface NavigationPolicy {
  /** 打包后 renderer 所在目录（dist/renderer），file: 导航必须落在其中 */
  rendererRoot: string;
  /** 开发模式下的 Vite dev server URL；生产为 undefined */
  devServerUrl?: string;
  /** 启动占位页的完整 data: URL；只允许精确匹配 */
  startupUrl?: string;
}

/** Windows 文件系统大小写不敏感，比较前统一规范化。 */
function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideDirectory(target: string, root: string): boolean {
  const normalizedTarget = normalizePath(target);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(normalizedRoot + path.sep)
  );
}

function sameOrigin(target: URL, reference: string): boolean {
  try {
    return target.origin === new URL(reference).origin;
  } catch {
    return false;
  }
}

/**
 * 判定一次导航是否允许
 *
 * 允许：
 * - dist/renderer 目录下的 file: 资源（生产首屏与页内跳转）
 * - dev server 同源地址（开发模式 HMR）
 * - 启动占位页的精确 data: URL
 *
 * 其余一律拒绝，包括 http(s) 外链、其他 data:/blob: URL、
 * 以及指向 renderer 目录之外的 file: 路径。
 */
export function isNavigationAllowed(targetUrl: string, policy: NavigationPolicy): boolean {
  // data: 只放行启动占位页本身，不放行任意 data: URL。
  if (policy.startupUrl && targetUrl === policy.startupUrl) return true;

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }

  if (parsed.protocol === "file:") {
    let filePath: string;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      return false;
    }
    return isInsideDirectory(filePath, policy.rendererRoot);
  }

  if (policy.devServerUrl && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return sameOrigin(parsed, policy.devServerUrl);
  }

  return false;
}

/**
 * 给一个 WebContents 安装导航护栏
 *
 * policy 用 getter 传入而非快照：dev server URL 与 renderer 目录在窗口创建后
 * 不会变，但保持惰性求值可让调用方复用同一个函数而不必关心初始化时序。
 *
 * 覆盖四类逃逸面：
 * - window.open / target=_blank → 一律 deny
 * - 主框架导航 → 白名单外 preventDefault
 * - 子框架导航 → 同上（will-navigate 不覆盖 iframe）
 * - <webview> 附加 → 一律拒绝（本应用不使用）
 */
export function installNavigationGuards(
  webContents: WebContents,
  getPolicy: () => NavigationPolicy,
): void {
  const deny = (errorCode: string, url: string): void => {
    logger.warn({
      status: "failed",
      errorCode,
      message: `${errorCode}: ${url.slice(0, 200)}`,
    });
  };

  webContents.setWindowOpenHandler(({ url }) => {
    // 外部链接的正规通道是 memory:openSourceUrl → shell.openExternal（那里校验协议）。
    deny("renderer_window_open_denied", url);
    return { action: "deny" };
  });

  webContents.on("will-navigate", (event, url) => {
    if (isNavigationAllowed(url, getPolicy())) return;
    event.preventDefault();
    deny("renderer_navigation_denied", url);
  });

  webContents.on("will-frame-navigate", (event) => {
    if (isNavigationAllowed(event.url, getPolicy())) return;
    event.preventDefault();
    deny("renderer_frame_navigation_denied", event.url);
  });

  webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
    deny("renderer_webview_denied", "webview attach");
  });
}
