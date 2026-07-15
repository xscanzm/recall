# Recall 发布流程

> 本文档面向开发者与 AI coding 助手。描述版本号管理、本地发布、CI 自动发布的完整流程。

## 一、版本号规则

遵循 [Semantic Versioning](https://semver.org/)：`MAJOR.MINOR.PATCH`

| 变更类型 | 递增 | 示例 |
|---|---|---|
| 不兼容的 API 变更 | MAJOR | 0.x.x → 1.0.0 |
| 新增功能（向后兼容） | MINOR | 0.1.x → 0.2.0 |
| Bug 修复（向后兼容） | PATCH | 0.1.1 → 0.1.2 |

**当前约定**：0.x.y 阶段，MAJOR 保持 0，按 minor 递增发布新功能。

### 版本号位置

版本号**唯一来源**是 [`package.json`](file:///d:/回声Recall/package.json#L3) 的 `version` 字段。以下位置会自动读取它：

- electron-builder 产出的安装包文件名：`Recall-${version}-setup.exe`
- 应用运行时 `app.getVersion()` 返回值（客户端用它和 R2 manifest 对比）
- GitHub Actions release workflow 从 `package.json` 读取版本号

### 更新版本号

**推荐用 npm 命令**（会自动改 `package.json` + 创建 git tag）：

```bash
# 新功能发布
npm version minor    # 0.1.1 → 0.2.0，自动 commit + tag

# Bug 修复
npm version patch    # 0.2.0 → 0.2.1，自动 commit + tag

# 里程碑版本
npm version major    # 0.2.0 → 1.0.0，自动 commit + tag
```

**或手动改 package.json**（不推荐，容易忘记打 tag）：

```json
{
  "version": "0.2.0"
}
```

### 更新更新说明文档（必做）

每次发布版本时**必须同步更新** [`cloudflare/worker/release-notes.md`](file:///d:/回声Recall/cloudflare/worker/release-notes.md)：

1. 第一行用 `## vX.Y.Z — 标题` 格式标注版本号，**必须与 package.json 的 version 一致**
2. 使用 `### 新增` / `### 改进` / `### 修复` / `### 已知限制` 章节组织内容
3. 这个文件有**两个用途**，必须保持单一来源：
   - **上传到 R2 manifest**：客户端检查更新时看到新版本说明（UpdatePanel 弹窗显示）
   - **打包嵌入客户端**：设置页「关于」分区显示当前版本的更新内容（Vite `?raw` import 编译时嵌入）

> ⚠️ **重要**：如果 `release-notes.md` 的版本号与 `package.json` 不一致，客户端「关于」分区会显示错误的更新内容。发布前务必核对。

## 二、发布方式

### 方式 A：GitHub Actions 自动发布（推荐）

**触发条件**：推送到 GitHub 一个 `v*.*.*` 格式的 tag（如 `v0.2.0`）。

**流程**：

1. 在 [`cloudflare/worker/release-notes.md`](file:///d:/回声Recall/cloudflare/worker/release-notes.md) 写本次更新日志
2. 更新版本号并打 tag：

   ```bash
   # npm version 会自动改 package.json + commit + 打 tag
   npm version minor
   git push origin main --tags
   ```

3. GitHub Actions 自动触发（见 [`.github/workflows/release.yml`](file:///d:/回声Recall/.github/workflows/release.yml)），执行：
   - `npm ci` → `npm run package` 构建 NSIS 安装包
   - `sha256sum` 计算 SHA256
   - `wrangler r2 object put` 上传安装包到 R2
   - 生成 `manifest.json` 并上传到 R2
   - `curl /api/latest` 验证部署
   - 上传安装包到 GitHub Release

4. 在 GitHub Actions 页面查看构建日志，确认 `✓ Deployment verified`

**前置条件**：仓库 Secrets 中配置了 CF 凭证（见下文「三、Cloudflare 凭证配置」）。

### 方式 B：本地手动发布（Windows / PowerShell）

适用于调试或 CI 不可用时。**Windows 无 WSL 时**，`publish-release.sh` 无法运行，按以下步骤：

```powershell
# 0. 前置：已 npm run package 产出 release\Recall-X.Y.Z-setup.exe

# 1. 进入 worker 目录
cd d:\回声Recall\cloudflare\worker

# 2. 计算 SHA256
certutil -hashfile "..\..\release\Recall-X.Y.Z-setup.exe" SHA256
# 输出形如：31109f6cb1cb901e75c1aa3f7f67075b6fdac6c7418872fc761253068a7a5023

# 3. 上传安装包到 R2
npx wrangler r2 object put "recall-releases/Recall-X.Y.Z-setup.exe" --file="..\..\release\Recall-X.Y.Z-setup.exe"

# 4. 手动创建 manifest.release.json（填入版本号、SHA256、releaseNotes）
#    或用 node 脚本从 release-notes.md 生成

# 5. 上传 manifest.json 到 R2
npx wrangler r2 object put "recall-releases/manifest.json" --file=manifest.release.json

# 6. 验证
curl https://recall-update.ppclaw.online/api/latest
```

### 方式 C：本地用 publish-release.sh（Git Bash / WSL）

```bash
cd cloudflare/worker
./scripts/publish-release.sh 0.2.0 ../../release/Recall-0.2.0-setup.exe release-notes.md
```

脚本自动：校验版本号 → 计算 SHA256 → 上传安装包 → 生成 manifest → 上传 manifest → 输出成功提示。

## 三、Cloudflare 凭证配置

### 前置信息

- **CF Account ID**：`db3ada487316e61362bc4e8d0e415c8d`
- **Worker 域名**：`https://recall-update.ppclaw.online`（自定义域名，国内可访问）
- **R2 存储桶**：`recall-releases`
- **KV 命名空间 ID**：`390817d3c39c4fc38e290fea1d9a6739`

### GitHub Actions 专用 API Token（推荐）

为 CI 创建一个**专用 API Token**，权限可控、可随时撤销：

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)
2. 点击 **Create Token** → **Create Custom Token**
3. 配置权限：
   - **Account** → **Workers R2 Storage** → **Edit**
   - **Account** → **Workers KV Storage** → **Edit**（可选，用于统计）
4. Account Resources：选择 `xscanzm@gmail.com's Account`
5. 创建后复制 Token

### 添加到 GitHub Secrets

仓库页面 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**：

| Secret 名 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步创建的 API Token |
| `CLOUDFLARE_ACCOUNT_ID` | `db3ada487316e61362bc4e8d0e415c8d` |

配置完成后，push tag 即可触发自动发布。

### 复用本机 wrangler login Token（临时/调试）

本机 `npx wrangler login` 产生的 OAuth Token 可临时复用，但有**过期风险**，不建议长期用于 CI：

```powershell
# 查看本机 wrangler 配置
npx wrangler whoami

# OAuth Token 通常存储在（Windows）：
#   %APPDATA%\.wrangler\config\default.toml  （较旧版本）
#   或 Windows Credential Manager（较新版本）
# 若要复用，从该位置读取 oauth_token 字段值，存为 GitHub Secret CLOUDFLARE_API_TOKEN
```

## 四、R2 存储结构

| Key | 内容 | 说明 |
|---|---|---|
| `manifest.json` | 版本元数据 JSON | `/api/latest` 与 `/api/check` 返回此内容 |
| `Recall-{version}-setup.exe` | NSIS 安装包 | `/download/:filename` 流式返回，支持 Range |

### manifest.json 格式

```json
{
  "version": "0.2.0",
  "downloadUrl": "/download/Recall-0.2.0-setup.exe",
  "sha256": "<小写十六进制>",
  "releaseNotes": "## v0.2.0\n- 新增...",
  "publishedAt": "2026-07-15T04:20:00Z"
}
```

**注意**：`releaseNotes` 必须是单行 JSON 字符串中的 `\n` 转义换行，不要包含真实换行符。

## 五、更新体系架构速览（AI coding 须知）

### 客户端

| 文件 | 作用 |
|---|---|
| [src/main/services/UpdateService.ts](file:///d:/回声Recall/src/main/services/UpdateService.ts) | 核心服务：checkForUpdates / downloadUpdate / installAndQuit / pingStats |
| [src/main/services/UpdateCheckerScheduler.ts](file:///d:/回声Recall/src/main/services/UpdateCheckerScheduler.ts) | 4 小时定时调度 + 10 秒首检 |
| [src/main/ipc/handlers/updateHandlers.ts](file:///d:/回声Recall/src/main/ipc/handlers/updateHandlers.ts) | 6 个 IPC channel 注册 |
| [src/main/app.ts](file:///d:/回声Recall/src/main/app.ts) | 实例化 + 调度器启动 + before-quit 清理 |
| [src/renderer/components/UpdateBadge.tsx](file:///d:/回声Recall/src/renderer/components/UpdateBadge.tsx) | 顶栏徽章（状态机驱动 UI） |
| [src/renderer/components/UpdatePanel.tsx](file:///d:/回声Recall/src/renderer/components/UpdatePanel.tsx) | 详情弹窗 |
| [src/shared/updateTypes.ts](file:///d:/回声Recall/src/shared/updateTypes.ts) | UpdateInfo / UpdateStatus / DownloadProgress 类型 |

### 后端

| 文件 | 作用 |
|---|---|
| [cloudflare/worker/src/index.ts](file:///d:/回声Recall/cloudflare/worker/src/index.ts) | 4 路由：/api/latest, /api/check, /api/ping, /download/:filename |
| [cloudflare/worker/wrangler.toml](file:///d:/回声Recall/cloudflare/worker/wrangler.toml) | R2 + KV 绑定 + 自定义域名 routes |
| [cloudflare/worker/scripts/publish-release.sh](file:///d:/回声Recall/cloudflare/worker/scripts/publish-release.sh) | 本地发布脚本（Git Bash / WSL） |

### 状态机

`UpdateStatus` 是 discriminated union，state 字段决定 UI 形态：

```
idle → checking → hasUpdate → downloading → downloaded → installing → (app.quit)
                ↓                              ↓
            noUpdate                       error
```

### 发布检查清单

发布新版本前确认：

- [ ] `package.json` 的 `version` 已更新
- [ ] [`cloudflare/worker/release-notes.md`](file:///d:/回声Recall/cloudflare/worker/release-notes.md) 已写更新日志
- [ ] [`src/main/services/UpdateService.ts`](file:///d:/回声Recall/src/main/services/UpdateService.ts#L32) 的 `UPDATE_WORKER_URL` 指向正确域名
- [ ] [`cloudflare/worker/wrangler.toml`](file:///d:/回声Recall/cloudflare/worker/wrangler.toml) 的 `routes` 域名配置正确
- [ ] GitHub Secrets 中 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 有效
- [ ] 本地 `npm run package` 构建通过
- [ ] 打 tag 并推送：`git push origin main --tags`
- [ ] GitHub Actions 构建成功，日志显示 `✓ Deployment verified`
- [ ] `curl https://recall-update.ppclaw.online/api/latest` 返回新版本号
