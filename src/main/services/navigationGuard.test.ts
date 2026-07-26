import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isNavigationAllowed, type NavigationPolicy } from "./navigationGuard";

const RENDERER_ROOT = path.resolve("C:/app/dist/renderer");

/** 把本地路径转成 file: URL，避免手写 file:///C:/... 时平台差异 */
function fileUrl(...segments: string[]): string {
  return pathToFileURL(path.join(...segments)).href;
}

const prodPolicy: NavigationPolicy = {
  rendererRoot: RENDERER_ROOT,
  startupUrl: "data:text/html;charset=UTF-8,%3Chtml%3E%3C/html%3E",
};

const devPolicy: NavigationPolicy = {
  rendererRoot: RENDERER_ROOT,
  devServerUrl: "http://localhost:5173",
};

describe("isNavigationAllowed", () => {
  it("允许 renderer 目录内的 file: 导航", () => {
    expect(isNavigationAllowed(fileUrl(RENDERER_ROOT, "index.html"), prodPolicy)).toBe(true);
    expect(isNavigationAllowed(fileUrl(RENDERER_ROOT, "assets", "chunk.html"), prodPolicy)).toBe(
      true,
    );
  });

  it("允许带 query / hash 的 renderer 页面（弹窗用 ?window= 传参）", () => {
    const base = fileUrl(RENDERER_ROOT, "index.html");
    expect(isNavigationAllowed(`${base}?window=report-generated`, prodPolicy)).toBe(true);
    expect(isNavigationAllowed(`${base}#/today`, prodPolicy)).toBe(true);
  });

  it("拒绝 renderer 目录外的 file: 导航，包括 .. 穿越", () => {
    expect(isNavigationAllowed(fileUrl("C:/app/dist/main", "app.js"), prodPolicy)).toBe(false);
    expect(isNavigationAllowed(fileUrl("C:/Windows/System32", "drivers", "etc", "hosts"), prodPolicy)).toBe(
      false,
    );
    expect(
      isNavigationAllowed(fileUrl(RENDERER_ROOT, "..", "main", "preload.js"), prodPolicy),
    ).toBe(false);
  });

  it("拒绝前缀相同但不同级的兄弟目录", () => {
    // renderer-evil 与 renderer 共享前缀，只有按分隔符判断才拦得住
    expect(isNavigationAllowed(fileUrl("C:/app/dist/renderer-evil", "index.html"), prodPolicy)).toBe(
      false,
    );
  });

  it("生产模式拒绝一切 http/https 导航", () => {
    expect(isNavigationAllowed("https://example.com/", prodPolicy)).toBe(false);
    expect(isNavigationAllowed("http://localhost:5173/", prodPolicy)).toBe(false);
  });

  it("开发模式只允许 dev server 同源", () => {
    expect(isNavigationAllowed("http://localhost:5173/", devPolicy)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5173/index.html?window=x", devPolicy)).toBe(true);
    expect(isNavigationAllowed("http://localhost:5174/", devPolicy)).toBe(false);
    expect(isNavigationAllowed("https://localhost:5173/", devPolicy)).toBe(false);
    expect(isNavigationAllowed("http://evil.example.com/", devPolicy)).toBe(false);
  });

  it("只精确匹配启动占位页的 data: URL", () => {
    expect(isNavigationAllowed(prodPolicy.startupUrl!, prodPolicy)).toBe(true);
    expect(isNavigationAllowed("data:text/html,%3Cscript%3Ealert(1)%3C/script%3E", prodPolicy)).toBe(
      false,
    );
    expect(isNavigationAllowed("data:text/html,", prodPolicy)).toBe(false);
  });

  it("拒绝其它协议与畸形 URL", () => {
    expect(isNavigationAllowed("javascript:alert(1)", prodPolicy)).toBe(false);
    expect(isNavigationAllowed("ftp://example.com/x", prodPolicy)).toBe(false);
    expect(isNavigationAllowed("about:blank", prodPolicy)).toBe(false);
    expect(isNavigationAllowed("not a url", prodPolicy)).toBe(false);
    expect(isNavigationAllowed("", prodPolicy)).toBe(false);
  });
});
