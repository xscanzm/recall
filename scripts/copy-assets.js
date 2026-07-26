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

for (const [src, dst, fileFilter] of targets) {
  if (copyDir(src, dst, fileFilter)) {
    console.log(`[copy-assets] ${path.relative(root, src)} -> ${path.relative(root, dst)}`);
  } else {
    console.warn(`[copy-assets] source not found, skipped: ${path.relative(root, src)}`);
  }
}

const requiredOutputs = [
  path.join(root, "dist", "main", "app.js"),
  path.join(root, "dist", "shared", "types.js"),
];

for (const output of requiredOutputs) {
  if (!fs.existsSync(output)) {
    throw new Error(`[copy-assets] required build output is missing: ${path.relative(root, output)}`);
  }
}
