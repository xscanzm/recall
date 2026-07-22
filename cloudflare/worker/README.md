# Recall 更新分发与默认能力代理 Worker

Cloudflare Worker + R2 托管的桌面端版本更新分发后端，并代理统一的信息图和默认模型能力。
- API 端点返回版本元数据
- 安装包文件存到 R2，客户端从 R2 下载（国内访问快、免出口流量费）
- KV 记录官网访问、下载与更新请求的聚合统计
- 信息图服务密钥仅保存在 Worker Secret，桌面客户端只拿到生成后的图片地址
- 默认语言/多模态模型密钥仅保存在 Worker Secret，桌面端不持有共享 Key

## 前置条件

- Cloudflare 账号
- 已安装 Node.js 18+
- 已安装 wrangler CLI（项目内 devDependency）
- Git Bash 或 WSL（用于发布脚本）

## 首次部署

```bash
# 1. 进入子项目目录
cd cloudflare/worker

# 2. 安装依赖
npm install

# 3. 登录 Cloudflare（浏览器会打开授权页）
npx wrangler login

# 4. 创建 R2 存储桶（保存安装包与 manifest.json）
npx wrangler r2 bucket create recall-releases

# 5. 创建 KV 命名空间（保存官网访问、下载与更新请求统计）
npx wrangler kv namespace create recall-stats
# 命令会输出形如：
#   [[kv_namespaces]]
#   binding = "STATS"
#   id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
# 把返回的 id 填到 wrangler.toml 中 STATS 的 id 字段

# 6. 本地调试（带 R2/KV 本地模拟）
npm run dev

# 7. 部署到 workers.dev
npm run deploy

# 8. 配置服务密钥（不要写入 wrangler.toml 或客户端源码）
npx wrangler secret put INFOGRAPHIC_API_KEY
npx wrangler secret put DEFAULT_LANGUAGE_API_KEY
npx wrangler secret put DEFAULT_MULTIMODAL_API_KEY
npx wrangler secret put MODEL_STATS_HASH_SECRET
```

部署后你会得到形如 `https://recall-update-worker.<your-subdomain>.workers.dev` 的域名。

## 发布新版本

使用 `npm run publish-release` 脚本：

```bash
npm run publish-release -- 0.1.2 ./Recall-0.1.2-setup.exe ./release-notes.md
```

脚本流程：
1. 校验版本号格式与文件存在
2. 计算安装包 SHA256
3. 上传安装包到 R2（key 为 `Recall-{version}-setup.exe`）
4. 生成 `manifest.json` 临时文件
5. 上传 `manifest.json` 到 R2
6. 输出成功提示与下载地址

`release-notes.md` 为 markdown 格式的更新日志。

## API 文档

所有 JSON 响应：
- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: no-store`
- CORS：允许所有 Origin、方法 `GET, POST, OPTIONS`、请求头 `Content-Type, X-Client-Version`

### `GET /api/latest`

返回最新版本 manifest。无 manifest 时返回 `404` + `{ error: "no manifest" }`。

成功响应：
```json
{
  "version": "0.1.2",
  "downloadUrl": "/download/Recall-0.1.2-setup.exe",
  "sha256": "<小写十六进制>",
  "releaseNotes": "## v0.1.2\n- 修复...",
  "publishedAt": "2024-12-31T10:00:00Z"
}
```

### `GET /api/check?currentVersion=x.y.z`

对比版本，返回是否有更新及详情。

响应：
```json
{
  "hasUpdate": true,
  "currentVersion": "0.1.0",
  "latestVersion": "0.1.2",
  "downloadUrl": "/download/Recall-0.1.2-setup.exe",
  "sha256": "<小写十六进制>",
  "releaseNotes": "## v0.1.2\n- 修复...",
  "publishedAt": "2024-12-31T10:00:00Z"
}
```

当 manifest 不存在时返回 `hasUpdate: false` 且 `latestVersion` 等于客户端上报版本。

### 分发统计

官网打开时会向 `POST /api/metrics/website-visit` 发出一个空请求；Worker 只按中国标准时间日期记录总数，不接收页面、设备或用户数据。

Worker 同时按日期和版本记录：

- `GET /download/latest` 的官网发起下载次数；
- 最终安装包的无 Range 请求次数，区分官网重定向和直接请求；
- `GET /api/check` 的更新检查次数，以及检测到新版本的次数。

运营读取日汇总前，先设置仅用于读取的 Worker Secret：

```bash
npx wrangler secret put STATS_READ_TOKEN
```

再通过 `GET /api/metrics/daily?date=YYYY-MM-DD` 请求，并附上 `Authorization: Bearer <STATS_READ_TOKEN>`。响应只包含当日的聚合计数与按版本的计数。

运营数据页位于 `GET /admin/stats?date=YYYY-MM-DD&range=7|30|all`，使用浏览器标准 Basic Auth。页面提供近 7 天、近 30 天和全部历史的累计、每日趋势与按版本统计。先分别设置 `STATS_ADMIN_USERNAME` 与 `STATS_ADMIN_PASSWORD` 两个 Worker Secret；它们不会写入仓库或返回给浏览器。

### `POST /api/infographic/generate`

桌面端在正式报告落库后异步调用。Worker 固定代理 `sensenova-u1-fast`，默认尺寸为 `2752x1536`（16:9 横版），每次只生成一张图片；同一客户端 IP 每日最多 100 次。

请求体：
```json
{
  "reportType": "weekly",
  "prompt": "将以下报告整理成清晰的信息图……"
}
```

成功响应：`{ "url": "https://..." }`。未配置 `INFOGRAPHIC_API_KEY` 时返回 `503 capability-unavailable`，桌面端会保持文字报告可用并隐藏图片区域。

### 默认模型代理

- `POST /api/model/language/v1/chat/completions`
- `POST /api/model/multimodal/v1/chat/completions`

两个端点兼容 OpenAI Chat Completions 的 JSON 与 SSE 响应。Worker 会覆盖客户端传入的 `model`，只允许调用 `wrangler.toml` 中固定的上游与模型，并从对应 Worker Secret 注入 Key。请求体最大 32 MiB，字段和图片输入格式均经过白名单校验。

桌面端只发送随机安装 UUID、任务类型和客户端版本。Worker 使用 `MODEL_STATS_HASH_SECRET` 对安装 UUID 做 HMAC 后才写入 KV，不保存原始标识、提示词、截图或模型回答。`/admin/stats` 只展示经过 Recall 默认代理的调用；用户自配 Key 的直连调用不上报。

紧急停用默认模型代理时，将 `MODEL_PROXY_ENABLED` 设为 `false` 并重新部署。

### `GET /download/:filename`

从 R2 流式返回安装包。支持 Range 请求（断点续传 / 多线程下载）。

响应头：
- `Content-Type: application/octet-stream`
- `Content-Disposition: attachment; filename="Recall-0.1.2-setup.exe"`
- `Cache-Control: public, max-age=3600`
- `Content-Length` / `Content-Range`（如为部分内容则返回 `206`）

文件不存在时返回 `404` + `{ error: "not found" }`。

## 可选：自定义域名

如果你不想用 `*.workers.dev` 域名（国内访问可能不稳定），可以为 Worker 绑定自定义域名：

1. 在 Cloudflare Dashboard 中将你的域名接入 Cloudflare（DNS）
2. 修改 `wrangler.toml`，添加路由配置：
   ```toml
   routes = [
     { pattern = "update.yourdomain.com/*", zone_name = "yourdomain.com" }
   ]
   ```
3. 重新部署：`npm run deploy`

之后所有 API 都可通过 `https://update.yourdomain.com/...` 访问。客户端 `downloadUrl` 中的相对路径会基于调用域自动解析，无需修改 manifest。

## CI 自动发布（GitHub Actions）

推送 `v*.*.*` 格式的 tag 会触发 [`.github/workflows/release.yml`](../../.github/workflows/release.yml)，自动完成构建 + 上传 R2 + 验证。

**完整流程见 [RELEASING.md](../../RELEASING.md)**，关键步骤：

1. 在 GitHub 仓库 Settings → Secrets 中配置：
   - `CLOUDFLARE_API_TOKEN`：CF API Token（需 R2 Edit 权限）
   - `CLOUDFLARE_ACCOUNT_ID`：`db3ada487316e61362bc4e8d0e415c8d`
2. 更新版本号 + 写 release-notes.md：
   ```bash
   npm version minor          # 0.1.1 → 0.2.0，自动 commit + tag
   # 编辑 cloudflare/worker/release-notes.md 写更新日志
   git push origin main --tags
   ```
3. GitHub Actions 自动构建 NSIS 安装包 → 计算 SHA256 → 上传到 R2 → 生成并上传 manifest.json → 验证 `/api/latest`
4. 构建产物同时上传到 GitHub Release

## 文件结构

```
cloudflare/worker/
├── src/
│   ├── index.ts        # 主入口，路由分发
│   ├── version.ts      # semver 解析与比较（自实现）
│   ├── manifest.ts     # R2 manifest 读取
│   └── stats.ts        # KV 统计写入
├── scripts/
│   └── publish-release.sh   # 发布新版本脚本
├── package.json
├── tsconfig.json
├── wrangler.toml
└── README.md
```

## 运行约束

- 无运行时依赖（仅 wrangler + @cloudflare/workers-types 作为 devDependencies）
- TypeScript strict 模式
- Worker 代码可在 Cloudflare 免费额度内运行（<10 万次/天、<10ms CPU/请求）
- `manifest.json` 在 R2 中的 key 是 `manifest.json`，安装包 key 是 `Recall-{version}-setup.exe`
