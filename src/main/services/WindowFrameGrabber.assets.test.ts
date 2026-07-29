// src/main/services/WindowFrameGrabber.assets.test.ts
//
// 抓图宿主页的**位置**契约，不测行为。
//
// 为什么值得单独一个文件：WindowFrameGrabber 用 loadFile(path.join(__dirname,
// "capture-host.html")) 加载宿主页，编译后 __dirname 是 dist/main/services。
// 而 scripts/copy-assets.js 按 src/ -> dist/ 镜像路径拷贝。这两条合起来意味着
// 源文件必须与 WindowFrameGrabber.ts **同目录**。
//
// 这个不变量曾经被破坏过一次：html 放在 src/main/ 下、拷到 dist/main/，加载方在
// dist/main/services/ 找不到，于是每次抓图静默返回 null、悄悄退到整屏裁剪 ——
// 采集照常"成功"，没有任何报错，只有后端字段变了。构建期的存在性检查抓不到这种
// 错配（源文件和产物都在，只是不在加载方找的地方），所以在这里钉住。

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const HOST_PAGE = "capture-host.html";
const grabberSource = path.join(__dirname, "WindowFrameGrabber.ts");

describe("capture host page location", () => {
  it("sits next to WindowFrameGrabber so __dirname resolves it after compilation", () => {
    expect(fs.existsSync(path.join(__dirname, HOST_PAGE))).toBe(true);
  });

  it("is loaded from __dirname, which is what makes the sibling requirement hold", () => {
    const source = fs.readFileSync(grabberSource, "utf8");
    // 换成别的目录（例如 "..", HOST_PAGE）就必须同步改上面那条断言和 copy-assets
    expect(source).toContain(`path.join(__dirname, "${HOST_PAGE}")`);
  });

  it("is mirrored src/ -> dist/ by copy-assets so the sibling layout survives the build", () => {
    const copyAssets = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "scripts", "copy-assets.js"),
      "utf8"
    );
    const relativeToSrc = path
      .relative(path.join(__dirname, "..", ".."), path.join(__dirname, HOST_PAGE))
      .split(path.sep);
    // copy-assets 里写成 path.join("main", "services", "capture-host.html")
    const expected = relativeToSrc.map((segment) => `"${segment}"`).join(", ");
    expect(copyAssets).toContain(`path.join(${expected})`);
  });
});
