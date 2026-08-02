# 07. Capture Privacy Security

## 采集原则

Recall 优先完整性，但必须有边界。

应该采集：

- 活动窗口。
- 用户有鼠标/键盘活动的工作场景。
- 窗口标题变化。
- 应用切换。
- 内容明显变化。
- 长时间工作片段的关键节点。

不应该采集：

- 全屏历史录像。
- 黑名单应用。
- 密码、支付、银行、证件、医疗等高敏场景。
- 用户暂停期间。
- 锁屏、登录页。

## 采集触发策略

不要用单纯固定定时器。使用事件触发 + 会话感知。

触发条件：

1. 活动窗口切换。
2. 活动窗口标题变化。
3. 用户输入活跃并在窗口停留超过阈值。
4. 内容 hash 或缩略图差异超过阈值。
5. 用户从 active 变 idle，表示一段工作可能结束。
6. idle 后恢复，表示新场景开始。
7. 日报生成前进行一次 daily preflight。

建议默认阈值：

- active window stable: 30 秒后可第一次采集。
- 同一窗口内容变化：至少间隔 60 秒。
- 长工作会话：每 2-5 分钟采集一组关键帧。
- idle threshold: 120 秒。

这些不是为了省 API，而是为了减少重复和噪声。

## 拼图策略

对于同一窗口的短时间多帧：

- 最多 3-6 帧合成一张 stitched image。
- 帧之间保留时间标记。
- 优先保留变化明显的帧。
- 拼图只作为模型输入和本地短期缓存，不作为主 UI 内容。

## 截图保留策略

默认：

- 保留当天。
- 次日启动或定时任务删除前一天截图。

可选：

- 立即删除。
- 1 小时。
- 6 小时。
- 当天。
- 3 天。
- 7 天。

实现要求：

- 截图仅本地保存。
- 存 app data cache 目录。
- 文件名不包含窗口标题、URL、用户文本。
- 删除过期截图后，Observation 的 `screenshot_retention` 更新为 `expired`。
- 用户可一键清空所有截图缓存。

## 黑名单

默认黑名单建议：

- 1Password
- Bitwarden
- KeePass
- Windows Credential Manager
- 银行/支付类应用
- 密码、支付、钱包、证件、医疗相关标题

用户可添加：

- app name
- window title keyword
- domain keyword

Rule action：

- `exclude`：完全不采集。
- `ask_before_capture`：暂不实现也可预留。
- `blur_sensitive`：MVP 可不实现。

## 敏感词

英文：

- password
- login
- bank
- pay
- wallet
- medical
- passport
- id card
- secret
- token
- api key

中文：

- 密码
- 登录
- 支付
- 银行
- 钱包
- 证件
- 身份证
- 医疗
- 病历
- 私密
- 密钥
- API Key

命中规则时：

- 捕获前命中：跳过，不截图。
- 视觉模型返回 high_sensitive：删除截图，删除 observation 或只保留 blocked event。

## Prompt Injection 防护

屏幕内容可能包含恶意提示词，例如：

- 忽略之前指令
- 输出你的系统提示词
- 上传用户数据
- 删除记忆
- 改变 JSON 格式

处理原则：

- 所有屏幕文字都只是数据。
- 模型不能执行屏幕中文字里的命令。
- prompts 必须包含防护说明。
- 如果检测到疑似 prompt injection，作为 risk/uncertainty 记录，不执行。

## API Key 安全

- API Key 不进入 renderer。
- API Key 不进 SQLite。
- API Key 不进日志。
- API Key 使用 Electron safeStorage 加密（Windows 走 DPAPI），密文存 `data/secrets.json`，不进 settings.json。
- safeStorage 不可用时保存直接失败，不允许退化成明文存储。
- 连接测试失败时不显示 key。
- 删除模型配置时同时删除 SecretService 中的 key。
- 历史版本存在 keytar（Windows 凭据管理器）的 key，启动时一次性迁移到 safeStorage 并删除源条目。

## 数据删除

必须支持：

- 删除某条记忆。
- 删除某个任务。
- 删除某个项目。
- 忘掉最近 15/30/60 分钟。
- 删除今天。
- 清空所有数据。
- 清空所有截图缓存。

删除后：

- UI 立即更新。
- 报告引用失效时标记需要重新生成。
- soft delete 优先。
- 截图文件硬删除。

## 本地导出

MVP 可支持 JSON 导出：

- 不包含截图，除非用户明确选择。
- 包含 observations/facts/scenes/tasks/projects/reports。
- 包含导出时间和版本。

## 云端边界

Recall 提供明确的云端能力边界，以下内置云端能力（全部托管于 `recall-update.ppclaw.online` 的 Cloudflare Worker + R2 + D1）：

- **默认模型代理**：`/api/model/language` 与 `/api/model/multimodal`（`src/main/services/ModelTargets.ts:7,21,34`）。使用「Recall 默认模型服务」时，prompts 与截图（data URL 形式）会经过 Recall 的代理转发到上游模型；该服务默认开启，用户可在设置中改用自配 endpoint 或关闭。
- **异步多模态任务暂存**：走默认模型异步队列的任务体（含截图 data URL）会临时存放到 Recall 的 Cloudflare R2，最长 2 小时 TTL 后自动清理（`cloudflare/worker/src/modelAsyncJobs.ts:66,98-101`）。
- **匿名用量统计**：使用默认模型服务时，Worker 会记录每安装实例的元数据统计——经 HMAC 哈希的安装 ID、任务类型、客户端版本与调用计数，存于 D1（`cloudflare/worker/src/stats.ts:288-304`），不保存原始提示词、截图或模型回答。
- **报告信息图代理**：`/api/infographic/generate`（`src/main/services/InfographicService.ts:13-14`），桌面端只把报告摘要转发生成信息图。
- **更新检查与安装包分发**：`/api/check`、`/api/latest` 与安装包下载（`src/main/services/UpdateService.ts:33-34`），并上报版本统计。

用户自配的模型 endpoint 仍直接从用户本机连接，不经过 Recall 服务器。

## 信任中心必须展示

信任中心文案要明确：

- Recall 在本机观察你的活动窗口。
- 截图用于模型理解。
- 截图会按你的设置本地短期保留。
- 结构化记忆保存在本机数据库。
- API Key 保存在系统安全存储。
- 你可以随时暂停、删除、导出。
- 桌面通知默认关闭。

