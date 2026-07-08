# Logo 资源清单

> 由 `scripts/build-logos.mjs` 自动生成。

## 设计原则

- **不处理原图像素**：颜色、渐变、半透明层次全部保留
- **不缩放压缩**：原图 1:1 占满圆角矩形（画面占比 100%）
- **只加圆角**：圆角外 = 透明，圆角内 = 原图
- 圆角半径 = 边长 × 18%（macOS Big Sur+ / iOS 风格）

## 处理流程

```
原图 logo.png (461x461)
  ↓ resize 1:1 拉伸到目标尺寸
  ↓ composite + blend=dest-in（用纯白圆角矩形作为 alpha mask）
圆角矩形 logo
```

## 文件位置

| 用途 | 路径 | 尺寸 |
|------|------|------|
| electron-builder 应用图标 | `resources/icons/icon.png` | 512×512 |
| Windows 打包 ICO | `resources/icons/icon.ico` | 16/24/32/48/64/128/256 |
| 托盘 @1x / @2x | `resources/icons/tray-{16,32}.png` | 16/32 |
| 浏览器 favicon | `resources/icons/favicon.ico` + `favicon-{16,32,48}.png` | 16/32/48 |
| BrandMark | `resources/icons/brandmark-{32,64,128}.png` | 32/64/128 |
| 启动页 / Onboarding | `resources/icons/splash-{512,1024}.png` | 512/1024 |
| 渲染进程 favicon | `src/renderer/public/favicon.ico` | 16/32/48 |
| 渲染进程 logo | `src/renderer/public/logo.png` | 256×256 |
| 渲染进程 logo 高清 | `src/renderer/public/logo-512.png` | 512×512 |
| 渲染进程 logo SVG | `src/renderer/public/logo.svg` | 64×64 |
| 文档引用 | `doc/logo.png` | 512×512 |

## 重新生成

```bash
node scripts/build-logos.mjs            # 全部
LOGO_SRC=path/to/other.png node scripts/build-logos.mjs  # 指定源文件
```
