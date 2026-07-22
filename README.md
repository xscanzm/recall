# 回声 Recall

> 把你在电脑前流逝的工作上下文，变成可行动的记忆和提醒。

回声 Recall 是一个**主动型桌面上下文助理**。它获得你的授权后，会观察你在电脑前的工作活动，把原本会自然流失的上下文转化为结构化记忆、任务追踪、项目进展、应用内提醒、日报和周报。

截图只是模型输入，不是用户资产。
Recall 真正长期沉淀的是你今天做了什么事、决定过什么、下一步该做什么。

---

## 直接下载（用户版）

- **官网**：<https://recall.ppclaw.online/>（含产品介绍与演示）
- **下载最新版**：<https://recall-update.ppclaw.online/download/latest>（自动更新通道，Windows x64 NSIS 安装包，约 90 MB）
- **GitHub Release**：<https://github.com/xscanzm/recall/releases>（含历史版本与 SHA-256）

> 下载后可校验完整性：`certutil -hashfile Recall-0.4.4-setup.exe SHA256`，与 [GitHub Release](https://github.com/xscanzm/recall/releases/latest) 页面公布的 SHA-256 比对。

---

## 核心特性

- **安静观察，主动不冒犯**：默认不弹桌面通知，应用内提醒克制呈现。
- **OCR + 大模型双管线**：Windows.Media.Ocr 读取未压缩原图文字 + 多模态大模型理解压缩图，小字保真度从 26% 提升到 90%+。
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
Windows OCR + 多模态大模型双管线理解：L0 Observation
       ↓
抽取与关联：L1 Fact · L2 Scene（含活动分类）· L3 Memory Object
       ↓
主动性判断：提醒 / 待确认 / 风险
       ↓
今日时间轴 · 活动可视化 · 提醒 · 日报 · 复盘
```

---

## 版本演进

- **v0.4.4**（最新）：模型调用稳健性（ModelGateway Retry-After + endpoint 级冷却 + Full Jitter 退避 + 请求预算 + 用量与延迟指标）+ 应用优雅关闭（shutdownRuntime 统一编排，best-effort → critical 两层排空）+ Today 活动概览性能优化（minimal 查询 + Map/Set 索引 + 移除 LIMIT 1000 + 跨日边界修复）+ Observer 帧近似去重（dHash 汉明距离 ≤ 2 复用前一帧）+ IPC handlers 与 Reports 页面模块化拆分 + 离线测试基础设施与 CI/发布流程完善
- **v0.4.3**：修复自动日报在工作日报页面显示不出来的问题（新增 reportAdapters 适配器层 + store 兜底查询 + ReportsPage UI 适配，自动日报带「自动生成」标签）+ 日报默认时间 19:00→17:30 + ReporterWorker 数据窗口与配置时间联动 + 官网运营数据采集与公测用户社群引导
- **v0.4.2**：报告信息图生成（16:9 中文信息图，嵌入报告正文上方）+ 月报独立契约（专属 schema/prompt/调度入口，自然月首末日）+ 报告生成通知（桌面卡片弹窗 + 顶栏 Bell 角标 + 未读持久化）+ 调度器始终自动执行（不再受 autoGenerate 门控，周报触发日改为周五）+ 今日活动窗口化与节奏图重构（实际观察时段映射，相邻同类 Episode 自动合并）
- **v0.4.1**：今日活动可视化（注意力甜甜圈 / 一天节奏路径 / 关键词云）+ 报告需求系统（4 类报告 × 3 字段 + 本次补充要求）+ Episode 活动分类（11 类，打通 L2 抽取层到 L1 scenes 表与 TodayPage 可视化）
- **v0.3.x**：OCR + 大模型双管线架构升级（v0.3.0）、OCR 证据传输稳定性优化（v0.3.1）、episode_fact_extractor 巨量数据严重问题修复（v0.3.2）、prompt cache 前缀失效 + WPS 黑屏截图修复（v0.3.3）
- **v0.2.x**：记忆系统重构、版本更新系统、CI 自动发布

完整发布说明见 [`cloudflare/worker/release-notes.md`](./cloudflare/worker/release-notes.md)。

---

## 快速开始（用户视角）

1. 前往 <https://recall.ppclaw.online/> 了解产品，或直接下载最新版：<https://recall-update.ppclaw.online/download/latest>。
2. 双击安装 `Recall-0.4.4-setup.exe`，桌面会出现 **Recall** 图标。
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
npm run package         # electron-builder NSIS，输出到 release/
```

> 构建产物 `release/Recall-0.4.4-setup.exe` 即对应发布通道的分发物。

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
