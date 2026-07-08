// scripts/build-logos.mjs
// 从 /d:/回声Recall/logo.png 生成圆角矩形 logo。
//
// 设计原则（按用户要求）：
// 1. 不动原图像素（颜色、渐变、层次全部保留）
// 2. 不缩放/不压缩到 62% 安全区（占满整个圆角矩形，画面占比 100%）
// 3. 不抠白底（保留原图真实背景，由用户后续决定）
// 4. 只加圆角矩形 mask（圆角外 = 透明，圆角内 = 原图）
//
// 圆角半径：边长 × 18%（macOS Big Sur+ / iOS 风格）
//
// 用法：
//   node scripts/build-logos.mjs

import sharp from "sharp";
import toIco from "to-ico";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = process.env.LOGO_SRC || path.join(ROOT, "logo.png");

const ICONS_DIR = path.join(ROOT, "resources", "icons");
const PUBLIC_DIR = path.join(ROOT, "src", "renderer", "public");
const DOCS_LOGO = path.join(ROOT, "doc", "logo.png");

// ---- 圆角 mask（白色矩形，alpha=255）----
// 用 SVG 直接生成纯白圆角矩形，作为后续 composite 的 mask
function roundedMask(size, radiusRatio = 0.18) {
  const r = Math.round(size * radiusRatio);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>` +
      `</svg>`
  );
}

// ---- 单个尺寸合成：原图 → 圆角 mask ----
// 流程：把原图 resize 到目标尺寸（不裁剪、不加 padding），然后用 dest-in 把圆角外的部分清成透明
async function buildRounded({ size, radiusRatio = 0.18, source }) {
  const mask = roundedMask(size, radiusRatio);
  return await sharp(source)
    .resize(size, size, { fit: "cover" }) // 1:1 cover 拉伸填满（用户希望占满）
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

// ---- 把多张 PNG 合成 .ico ----
async function buildIco(pngBuffers) {
  return await toIco(pngBuffers.map((p) => p.buffer));
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function main() {
  await ensureDir(ICONS_DIR);
  await ensureDir(PUBLIC_DIR);
  await ensureDir(path.dirname(DOCS_LOGO));

  const srcStat = await fs.stat(SRC);
  const srcMeta = await sharp(SRC).metadata();
  console.log(`源文件：${SRC}`);
  console.log(`  尺寸：${srcMeta.width}x${srcMeta.height}  channels=${srcMeta.channels}  hasAlpha=${srcMeta.hasAlpha}`);
  console.log(`  大小：${(srcStat.size / 1024).toFixed(1)} KB\n`);

  // 通用尺寸
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

  // 先生成所有尺寸的 PNG（缓存起来）
  console.log("生成 9 个尺寸的圆角矩形 PNG...");
  const cache = {};
  for (const size of sizes) {
    cache[size] = await buildRounded({ size, source: SRC });
    const k = (cache[size].length / 1024).toFixed(1);
    console.log(`  ${String(size).padStart(4)}x${String(size).padEnd(4)}  (${k} KB)`);
  }

  // 1) light/dark 子目录（每个尺寸都存一份，方便 macOS ico 集）
  for (const variant of ["light"]) {
    const subDir = path.join(ICONS_DIR, variant);
    await ensureDir(subDir);
    for (const size of sizes) {
      await fs.writeFile(path.join(subDir, `icon-${size}.png`), cache[size]);
    }
  }

  // 2) electron-builder 入口
  await fs.writeFile(path.join(ICONS_DIR, "icon.png"), cache[512]);
  console.log(`\n[写] resources/icons/icon.png (512)`);

  // 3) Windows 多尺寸 ICO
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = icoSizes.map((s) => ({ size: s, buffer: cache[s] }));
  const icoBuf = await buildIco(icoPngs);
  await fs.writeFile(path.join(ICONS_DIR, "icon.ico"), icoBuf);
  console.log(`[写] resources/icons/icon.ico (${icoSizes.join("/")}, ${(icoBuf.length / 1024).toFixed(1)} KB)`);

  // 4) 托盘
  await fs.writeFile(path.join(ICONS_DIR, "tray-16.png"), cache[16]);
  await fs.writeFile(path.join(ICONS_DIR, "tray-32.png"), cache[32]);
  console.log(`[写] resources/icons/tray-{16,32}.png`);

  // 5) favicon
  const favSizes = [16, 32, 48];
  const favPngs = favSizes.map((s) => ({ size: s, buffer: cache[s] }));
  const favIco = await buildIco(favPngs);
  await fs.writeFile(path.join(ICONS_DIR, "favicon.ico"), favIco);
  for (const s of favSizes) {
    await fs.writeFile(path.join(ICONS_DIR, `favicon-${s}.png`), cache[s]);
  }
  console.log(`[写] resources/icons/favicon.{ico,16,32,48}.png`);

  // 6) BrandMark PNG
  await fs.writeFile(path.join(ICONS_DIR, "brandmark-32.png"), cache[32]);
  await fs.writeFile(path.join(ICONS_DIR, "brandmark-64.png"), cache[64]);
  await fs.writeFile(path.join(ICONS_DIR, "brandmark-128.png"), cache[128]);
  console.log(`[写] resources/icons/brandmark-{32,64,128}.png`);

  // 7) 启动页 / Onboarding
  await fs.writeFile(path.join(ICONS_DIR, "splash-512.png"), cache[512]);
  await fs.writeFile(path.join(ICONS_DIR, "splash-1024.png"), cache[1024]);
  console.log(`[写] resources/icons/splash-{512,1024}.png`);

  // 8) Vite 渲染进程静态资源
  await fs.writeFile(path.join(PUBLIC_DIR, "favicon.ico"), favIco);
  await fs.writeFile(path.join(PUBLIC_DIR, "logo.png"), cache[256]);
  await fs.writeFile(path.join(PUBLIC_DIR, "logo-512.png"), cache[512]);
  // SVG：直接用 64 PNG 嵌 base64
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <image href="data:image/png;base64,${cache[64].toString("base64")}" width="64" height="64"/>
</svg>
`;
  await fs.writeFile(path.join(PUBLIC_DIR, "logo.svg"), svg);
  console.log(`[写] src/renderer/public/{favicon.ico,logo.png,logo-512.png,logo.svg}`);

  // 9) 文档引用
  await fs.writeFile(DOCS_LOGO, cache[512]);
  console.log(`[写] doc/logo.png (512)`);

  // 10) README
  const report = `# Logo 资源清单

> 由 \`scripts/build-logos.mjs\` 自动生成。

## 设计原则

- **不处理原图像素**：颜色、渐变、半透明层次全部保留
- **不缩放压缩**：原图 1:1 占满圆角矩形（画面占比 100%）
- **只加圆角**：圆角外 = 透明，圆角内 = 原图
- 圆角半径 = 边长 × 18%（macOS Big Sur+ / iOS 风格）

## 处理流程

\`\`\`
原图 logo.png (461x461)
  ↓ resize 1:1 拉伸到目标尺寸
  ↓ composite + blend=dest-in（用纯白圆角矩形作为 alpha mask）
圆角矩形 logo
\`\`\`

## 文件位置

| 用途 | 路径 | 尺寸 |
|------|------|------|
| electron-builder 应用图标 | \`resources/icons/icon.png\` | 512×512 |
| Windows 打包 ICO | \`resources/icons/icon.ico\` | 16/24/32/48/64/128/256 |
| 托盘 @1x / @2x | \`resources/icons/tray-{16,32}.png\` | 16/32 |
| 浏览器 favicon | \`resources/icons/favicon.ico\` + \`favicon-{16,32,48}.png\` | 16/32/48 |
| BrandMark | \`resources/icons/brandmark-{32,64,128}.png\` | 32/64/128 |
| 启动页 / Onboarding | \`resources/icons/splash-{512,1024}.png\` | 512/1024 |
| 渲染进程 favicon | \`src/renderer/public/favicon.ico\` | 16/32/48 |
| 渲染进程 logo | \`src/renderer/public/logo.png\` | 256×256 |
| 渲染进程 logo 高清 | \`src/renderer/public/logo-512.png\` | 512×512 |
| 渲染进程 logo SVG | \`src/renderer/public/logo.svg\` | 64×64 |
| 文档引用 | \`doc/logo.png\` | 512×512 |

## 重新生成

\`\`\`bash
node scripts/build-logos.mjs            # 全部
LOGO_SRC=path/to/other.png node scripts/build-logos.mjs  # 指定源文件
\`\`\`
`;
  await fs.writeFile(path.join(ICONS_DIR, "README.md"), report);
  console.log(`[写] resources/icons/README.md`);

  console.log(`\n=== 完成 ===`);
  console.log(`共生成 ${sizes.length} 个尺寸 PNG + 1 个 icon.ico + 1 个 favicon.ico`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
