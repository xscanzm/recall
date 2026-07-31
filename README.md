# 回声 Recall

> 把你在电脑前流逝的工作上下文，变成可行动的记忆和提醒。

回声 Recall 是一个**主动型桌面上下文助理**。它获得你的授权后，会观察你在电脑前的工作活动，把原本会自然流失的上下文转化为结构化记忆、任务追踪、项目进展、应用内提醒、日报和周报。

截图只是模型输入，不是用户资产。
Recall 真正长期沉淀的是你今天做了什么事、决定过什么、下一步该做什么。

---

## 直接下载（用户版）

- **官网**：<https://recall.ppclaw.online/>（含产品介绍与 macOS / Windows 客户端下载）
- **Windows 下载**：<https://recall-update.ppclaw.online/download/latest>（Windows x64 NSIS 安装包）
- **macOS 下载**：<https://github.com/xscanzm/recall/releases/latest>（支持 Apple Silicon `arm64` 与 Intel `x64` DMG 包）
- **GitHub Release**：<https://github.com/xscanzm/recall/releases>（含历史版本与 SHA-256）

> 💡 **macOS 首次安装提示“应用已损坏，无法打开”解决指南**：
> 由于未购买 Apple 商业证书签名，macOS 会对从网络下载的应用标记隔离。解决办法：
> 1. **推荐（一键修复）**：打开安装包 `.dmg`，将 `Recall.app` 拖入【应用程序】文件夹后，双击运行 DMG 内内置的 **`双击修复安装.command`** 脚本。
> 2. **手动修复**：打开 Mac 终端执行命令：`sudo xattr -rd com.apple.quarantine /Applications/Recall.app` 即可解锁。

---

## 核心特性

- **安静观察，主动不冒犯**：默认不弹桌面通知，应用内提醒克制呈现。
- **OCR + 大模型双管线**：RapidOCR + PP-OCRv6 Small ONNX 读取未压缩原图文字，多模态大模型理解压缩图；大屏小字会自适应分块识别，RapidOCR 不可用时自动回退 Windows OCR。
- **L0 → L1 → L2 → L3 自动记忆**：观察、抽取、关联、主动性判断、日报由模型自动完成；用户可以编辑、删除、合并、纠错。
- **今日活动可视化**：注意力甜甜圈、一天节奏路径、关键词云三卡看板，基于 Episode 活动分类（11 类）一眼掌握当天的注意力分布与节奏。
- **每日工作主线**：今日页按时间轴呈现今天的主线、线索、提醒和复盘。
- **双轨报告 + 报告需求系统**：工作日报 + 个人复盘，固定时间自动生成草稿；可长期维护 4 类报告的「重点关注 / 呈现要求 / 注意提醒」，并支持每次生成时附加补充要求。
- **本地优先 + 隐私边界**：截图与数据库全在本地，不上传到 Recall 自有服务器；自带 API Key，模型调用直连你自己的 endpoint。
- **可审计开源**：完整源码公开（BUSL 1.1），无后门，无远程上传。

---

## 工作流概览

```text
桌面活动（窗口、标题、输入、变化）
       ↓
本地事件触发采集（黑名单与敏感场景自动跳过）
       ↓
RapidOCR（PP-OCRv6 Small ONNX）+ 多模态大模型双管线理解：L0 Observation
       ↓
抽取与关联：L1 Fact · L2 Scene（含活动分类）· L3 Memory Object
       ↓
主动性判断：提醒 / 待确认 / 风险
       ↓
今日时间轴 · 活动可视化 · 提醒 · 日报 · 复盘
```

---

## 版本演进

- **v0.5.6**（最新）：更新下载分片 + 断点续传（解决国内访问 Cloudflare R2 下载 180MB+ 安装包不稳定问题，UpdateService 重写 downloadUpdate 方法：HEAD 探测 Accept-Ranges → 4MB 分片 Range 请求 → 单片 30s 超时 + 5 次重试退避 → .part + .meta.json 断点续传元数据，中断后从断点继续 → 6 轮整体重试 → 整体 SHA256 校验；不支持 Range 时回退原流式下载）
- **v0.5.5**：截图采集架构重构（WindowFrameGrabber 单窗口 getDisplayMedia + WGC 捕获，替代 desktopCapturer 全窗口抓图，零 WM_PRINT 副作用，不再导致钉钉等 GPU 合成应用白屏）+ captureOcclusion 遮挡门禁（扫描线并集算法 + 35% 良性遮挡阈值 + 敏感遮挡一律跳过，防止裁到隐私）+ CaptureService 三后端降级链（window_display_media → screen_crop_fallback → 旧 window 禁用，三路不通则跳过不硬采）+ ActivityService 增强（getFreshActiveWindowInfo 双重校验 + getOpenWindowsSnapshot Z 序窗口列表）+ 退化帧检测（analyzeCaptureVisualQuality 全黑帧自动降级）
- **v0.5.4**：混合搜索（FTS5 trigram 词法召回 + BGE bge-small-zh-v1.5 本地 embedding 语义召回 + RRF 融合 + 静默降级，支持中文子串精确匹配与语义召回）+ 身份归一化与重复对象审计（normalizeIdentity + comparePersonIdentity + IdentityAuditService 只读审计 + 精确身份匹配 + 合并建议事务完整性）+ BatchProcessor lane 化并发（backlog/fresh/window 三 lane，始终保留 1 槽给最新数据）+ DataLifecycleService 事务安全（exclusive 清理隔离 + embedding 索引器暂停）+ TimelineHeader 新增"忘掉最近"按钮 + migration 028/029（安装包体积因内置 BGE embedding 模型增大至约 184 MB）
- **v0.5.3**：批次重试耗尽死锁修复（failExhaustedBatches 启动时把 retry-exhausted pending/running batch 落到 failed，避免卡死时间轴窗口）+ CaptureBatcher 攒批优化（固定 5 分钟定时器改为"空闲 150s + 年龄上限 10min"双约束，避免抢切近满批次）+ TimelineWindowCoordinator 三类死锁修复（跨天窗口 force 封窗 + sealing 首次排空去重 + onBatchSettled 环形等待规避）+ 窗口拖动改进（CSS app-region → IPC window:drag + PointerEvent + setPointerCapture）
- **v0.5.2**：密钥存储迁移（keytar 原生模块 → Electron safeStorage/DPAPI，secretsMigration 幂等迁移 + 写成功才删源）+ 导航护栏（navigationGuard，BrowserWindow 导航白名单防御 prompt injection 逃逸，覆盖 window.open/will-navigate/iframe/webview 四类）+ 数据库稳健性（busy_timeout=5000ms + 迁移备份自动清理保留 2 份）+ 渲染层架构重构（global.css 拆分为按页面/组件 CSS 多文件 + store.ts 拆分为 Zustand slice 模式，对外 API 不变）+ 工程基础设施（ESLint 9 扁平配置 + 契约测试 + CI 调整）
- **v0.5.1**：时间轴生成窗口化（TimelineWindowCoordinator，事件时间窗口状态机 collecting→sealing→ready→generating，替代固定 10 分钟增量）+ 记忆对象准入机制（MemoryObjectAdmissionService，projects/people 三态决策 promoted/candidate/rejected，基于事实证据自动评估）+ TimelineBuilderWorker 窗口化适配（TimelineBuildWindowRequest，MAX_OBSERVATIONS=2000）+ ProjectionInvalidationProcessor 窗口级重建（claimPending 状态机）+ 配套基础设施完善（shutdownRuntime/ReportScheduler/BatchProcessor/TrayService 适配）+ 测试基础设施（TimelineWindowCoordinator/MemoryObjectAdmissionService 单测 + E2E 准入流程）+ migration 026/027
- **v0.5.0**：RapidOCR 引擎升级（基于 ONNX Runtime + PP-OCRv6 模型，PyInstaller 打包为常驻 worker 进程，中文与复杂版式识别准确率显著提升，Windows OCR 降级为 fallback）+ OCR 引擎抽象层（OcrBatchService 接口）+ Worker 端异步模型任务队列（D1 持久化 + HMAC 鉴权）+ OCR 证据传输与 prompt 透明化 + 配套基础设施完善（安装包体积因内置 RapidOCR 运行时增大至约 184 MB）
- **v0.4.5**：默认模型服务（ModelTargets + DefaultModelConsentService，新用户开箱即用无需自备 API Key）+ 安装身份识别（InstallationIdentityService，持久化 UUID 用于匿名统计）+ Cloudflare Worker 模型代理路由（/api/model/language + /api/model/multimodal）+ 全量 Worker 接入默认模型机制 + UI 适配（Onboarding/SettingsPage/TrustCenterPage）+ 测试基础设施完善
- **v0.4.4**：模型调用稳健性（ModelGateway Retry-After + endpoint 级冷却 + Full Jitter 退避 + 请求预算 + 用量与延迟指标）+ 应用优雅关闭（shutdownRuntime 统一编排，best-effort → critical 两层排空）+ Today 活动概览性能优化（minimal 查询 + Map/Set 索引 + 移除 LIMIT 1000 + 跨日边界修复）+ Observer 帧近似去重（dHash 汉明距离 ≤ 2 复用前一帧）+ IPC handlers 与 Reports 页面模块化拆分 + 离线测试基础设施与 CI/发布流程完善
- **v0.4.3**：修复自动日报在工作日报页面显示不出来的问题（新增 reportAdapters 适配器层 + store 兜底查询 + ReportsPage UI 适配，自动日报带「自动生成」标签）+ 日报默认时间 19:00→17:30 + ReporterWorker 数据窗口与配置时间联动 + 官网运营数据采集与公测用户社群引导
- **v0.4.2**：报告信息图生成（16:9 中文信息图，嵌入报告正文上方）+ 月报独立契约（专属 schema/prompt/调度入口，自然月首末日）+ 报告生成通知（桌面卡片弹窗 + 顶栏 Bell 角标 + 未读持久化）+ 调度器始终自动执行（不再受 autoGenerate 门控，周报触发日改为周五）+ 今日活动窗口化与节奏图重构（实际观察时段映射，相邻同类 Episode 自动合并）
- **v0.4.1**：今日活动可视化（注意力甜甜圈 / 一天节奏路径 / 关键词云）+ 报告需求系统（4 类报告 × 3 字段 + 本次补充要求）+ Episode 活动分类（11 类，打通 L2 抽取层到 L1 scenes 表与 TodayPage 可视化）
- **v0.3.x**：OCR + 大模型双管线架构升级（v0.3.0）、OCR 证据传输稳定性优化（v0.3.1）、episode_fact_extractor 巨量数据严重问题修复（v0.3.2）、prompt cache 前缀失效 + WPS 黑屏截图修复（v0.3.3）
- **v0.2.x**：记忆系统重构、版本更新系统、CI 自动发布

完整发布说明见 [`cloudflare/worker/release-notes.md`](./cloudflare/worker/release-notes.md)。

---

## 快速开始（用户视角）

1. 前往 <https://recall.ppclaw.online/> 了解产品，或直接下载最新版：<https://recall-update.ppclaw.online/download/latest>。
2. 双击安装 `Recall-0.5.6-setup.exe`，桌面会出现 **Recall** 图标。
3. 首次启动进入「模型配置」：填入你自带的视觉模型与语言模型 endpoint / model / API key。
4. 前往「设置 → 隐私」确认默认黑名单应用和截图保留策略。
5. 点击「**开始观察**」。

> MVP 阶段要求用户自备 OpenAI-compatible 端点的 API Key。Recall 不内置任何远程服务。

---

## 开发者构建

```bash
git clone https://github.com/xscanzm/recall.git
cd recall
npm install
npm run build           # 编译 main + renderer
npm run package         # 先构建独立 OCR worker，再输出 NSIS 到 release/
```

`npm run package` 需要 Windows x64、Python 3.11 和可用网络来安装锁定的 OCR 构建依赖。生成的安装包内含 RapidOCR、ONNX Runtime 和 PP-OCRv6 Small detector/recognizer 模型；终端用户不需要安装 Python，运行时也不会下载 OCR 模型。仅调试 Electron 主进程时，可通过 `RECALL_RAPIDOCR_WORKER_PATH` 指向已构建的 worker；未构建 worker 时开发态会使用 `resources/ocr/rapidocr_worker.py`，并可用 `RECALL_PYTHON_PATH` 指定 Python。

OCR 去重按信息层级处理：整图与分块检测结果先按位置和文字保守合并；仅解码像素完全一致的帧复用 OCR 和视觉观察；近似帧仍执行 OCR 与多模态观察，但 OCR block 变化会压缩为 delta 证据，减少提示词体积而不丢失每帧 L0 `fullText`。

> 构建产物 `release/Recall-0.5.6-setup.exe` 即对应发布通道的分发物。

类型检查：

```bash
npm run typecheck:main
npm run typecheck:renderer
```

官网构建与部署（Cloudflare Pages，输出到 `website/`）：

```bash
cd website
npm install
npm run build           # vite build
npm run deploy          # wrangler pages deploy
```

---

## 文档索引

完整产品规格、施工规格、UI/UX 规格、AI pipeline、JSON schemas、验收标准等见 [`doc/README.md`](./doc/README.md)。

按推荐阅读顺序：

1. [00_PRODUCT_DEFINITION.md](./doc/00_PRODUCT_DEFINITION.md) — 产品定义、原则、目标用户
2. [01_MVP_SCOPE.md](./doc/01_MVP_SCOPE.md) — MVP 范围
3. [02_USER_FLOWS.md](./doc/02_USER_FLOWS.md) — 用户流程
4. [07_CAPTURE_PRIVACY_SECURITY.md](./doc/07_CAPTURE_PRIVACY_SECURITY.md) — 隐私与安全边界
5. [08_UI_UX_BRAND_SPEC.md](./doc/08_UI_UX_BRAND_SPEC.md) — 界面与品牌
6. [19_RECALL_PRODUCT_EXPERIENCE_UNIFIED_SPEC.md](./doc/19_RECALL_PRODUCT_EXPERIENCE_UNIFIED_SPEC.md) — 体验升级总纲

完整 27 份文档见 `doc/`。

---

## 技术栈

- **运行时**：Electron + Node.js
- **前端**：React + TypeScript + Vite
- **持久化**：SQLite（`better-sqlite3`）
- **打包**：`electron-builder` NSIS 安装包
- **AI**：OpenAI-compatible 多模态端点（用户自备 key）

---

## 许可证

本项目以 **Business Source License 1.1 (BUSL-1.1)** 发布。
完整文本见 [LICENSE](./LICENSE)。

关键条款：

- ✅ 源码完全可见，可审计与学习
- ✅ 个人非生产使用、修改、内部研究允许
- ❌ **禁止生产环境商用**（SaaS、再分发、商业产品集成），需另行授权
- ⏰ **变更日期 2030-07-08**：届时本项目自动转为 **Apache License 2.0**

---

## 隐私与信任声明

Recall 不收集任何遥测数据，不上传截图，不内置任何远程服务。

- 截图仅保存在用户本地 `appData` 缓存目录，文件名不含窗口标题或 URL。
- API Key 通过系统级安全存储（Windows Credential Manager），不进 SQLite。
- 模型调用直连用户自配的 endpoint，不经过 Recall 自有服务器。
- 完整源码公开，可自行审计、fork、构建。

如发现安全问题，请提 GitHub Issue 或联系维护者。

---

## 贡献

欢迎提交 Issue 与 Pull Request。

- 主仓库：<https://github.com/xscanzm/recall>
- 官网：<https://recall.ppclaw.online/>
- Issues：<https://github.com/xscanzm/recall/issues>
- Releases：<https://github.com/xscanzm/recall/releases>

> 由于采用 BUSL 1.1 许可证，**生产环境相关的 PR 不会被合并到主仓**。如希望商业集成或重分发，请联系 Licensor 协商替代许可安排。
