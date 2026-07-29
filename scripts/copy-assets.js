// scripts/copy-assets.js
// Copy non-TS assets (SQL migrations) from src/ to dist/ so they get packaged by electron-builder.
// TSC only compiles .ts/.d.ts files; SQL files are runtime resources.
const fs = require("node:fs");
const path = require("node:path");

function copyDir(src, dst, fileFilter) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d, fileFilter);
    } else if (!fileFilter || fileFilter(entry.name)) {
      fs.copyFileSync(s, d);
    }
  }
  return true;
}

// migrations 目录里除 .sql 外还有 README.md / .gitkeep，它们是开发期文档，不进安装包。
const isSqlFile = (name) => name.endsWith(".sql");

const root = path.resolve(__dirname, "..");
const targets = [
  [path.join(root, "src", "main", "db", "migrations"), path.join(root, "dist", "main", "db", "migrations"), isSqlFile],
];

// 单文件资源，按 src/ -> dist/ **原样镜像**路径。
//
// 不写成两个各自硬编码的绝对路径：抓图宿主页必须落在 WindowFrameGrabber 编译产物
// 的同一目录（它用 loadFile(path.join(__dirname, "capture-host.html")) 加载，
// __dirname 编译后是 dist/main/services）。两边分开写过一次就漂过一次 ——
// 曾经把它拷到 dist/main/ 而加载方在 dist/main/services/ 找，结果每次抓图静默
// 返回 null、悄悄退到整屏裁剪。镜像路径让这种不一致在结构上不可能发生。
const mirroredFileAssets = [
  path.join("main", "services", "capture-host.html"),
];

const fileTargets = mirroredFileAssets.map((relativePath) => [
  path.join(root, "src", relativePath),
  path.join(root, "dist", relativePath),
]);

for (const [src, dst, fileFilter] of targets) {
  if (copyDir(src, dst, fileFilter)) {
    console.log(`[copy-assets] ${path.relative(root, src)} -> ${path.relative(root, dst)}`);
  } else {
    console.warn(`[copy-assets] source not found, skipped: ${path.relative(root, src)}`);
  }
}

for (const [src, dst] of fileTargets) {
  if (!fs.existsSync(src)) {
    throw new Error(`[copy-assets] required source asset is missing: ${path.relative(root, src)}`);
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log(`[copy-assets] ${path.relative(root, src)} -> ${path.relative(root, dst)}`);
}

const requiredOutputs = [
  path.join(root, "dist", "main", "app.js"),
  path.join(root, "dist", "shared", "types.js"),
  // 缺了抓图宿主页就起不来抓图宿主，宁可构建期就响，不要等到运行时采集静默失败
  ...fileTargets.map(([, dst]) => dst),
];

for (const output of requiredOutputs) {
  if (!fs.existsSync(output)) {
    throw new Error(`[copy-assets] required build output is missing: ${path.relative(root, output)}`);
  }
}
