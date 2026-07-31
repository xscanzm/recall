// build/after-sign-mac.js
// electron-builder afterSign hook：macOS 打包后对 .app 做 ad-hoc 签名
//
// 背景：无开发者账号时 identity:null 会让 electron-builder 跳过签名，
// 但 Apple Silicon (arm64) 上未签名的 .app 会被 dyld/AMFI 拒绝加载，
// 即使内测用户右键打开也跑不起来。ad-hoc 签名（codesign -s -）不需要
// 任何证书，仅给二进制一个身份让 dyld 放行。
//
// 同时对 extraResources 里的 rapidocr-worker 目录做 --deep 签名，
// 确保子进程（onnxruntime dylib、numpy so 等）也能在 arm64 上加载。

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

module.exports = async function (context) {
  // 仅 macOS
  if (context.electronPlatformName !== "mac") return;

  const appPath = context.appOutApp;
  const resourcesPath = context.appOutResources;
  const arch = context.arch;

  console.log(`[after-sign-mac] 对 ${appPath} (${arch}) 执行 ad-hoc 签名...`);

  // 1. 对 .app 主体 ad-hoc 签名（含所有 Frameworks）
  const appResult = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--entitlements", "build/entitlements.mac.plist", appPath],
    { stdio: "inherit" }
  );
  if (appResult.status !== 0) {
    console.warn(`[after-sign-mac] ⚠️ .app 签名失败 (exit ${appResult.status})，arm64 可能无法运行`);
  }

  // 2. 对 extraResources 里的 rapidocr-worker 目录做 ad-hoc 签名
  //    路径形如 release/mac/Recall.app/Contents/Resources/ocr/rapidocr-worker
  const workerDir = path.join(resourcesPath, "ocr", "rapidocr-worker");
  if (fs.existsSync(workerDir)) {
    console.log(`[after-sign-mac] 对 ${workerDir} 执行 ad-hoc 签名...`);
    const workerResult = spawnSync(
      "codesign",
      ["--force", "--deep", "--sign", "-", workerDir],
      { stdio: "inherit" }
    );
    if (workerResult.status !== 0) {
      console.warn(`[after-sign-mac] ⚠️ worker 签名失败 (exit ${workerResult.status})`);
    }
  }

  // 3. 验证签名
  const verifyResult = spawnSync(
    "codesign",
    ["--verify", "--verbose=2", appPath],
    { stdio: "inherit" }
  );
  if (verifyResult.status === 0) {
    console.log("[after-sign-mac] ✅ ad-hoc 签名验证通过");
  } else {
    console.warn("[after-sign-mac] ⚠️ ad-hoc 签名验证失败");
  }
};
