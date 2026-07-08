# 回声 Recall

> 把你在电脑前流逝的工作上下文，变成可行动的记忆和提醒。

回声 Recall 是一个**主动型桌面上下文助理**。它获得你的授权后，会观察你在电脑前的工作活动，把原本会自然流失的上下文转化为结构化记忆、任务追踪、项目进展、应用内提醒、日报和周报。

截图只是模型输入，不是用户资产。
Recall 真正长期沉淀的是你今天做了什么事、决定过什么、下一步该做什么。

---

## 直接下载（用户版）

最新可执行安装包请前往 **[xscanzm/recall-releases](https://github.com/xscanzm/recall-releases)** 获取：

- **NSIS 安装包**（推荐）：`Recall-0.1.0-setup.exe`，约 90 MB
- **绿色版**（免安装）：`Recall.exe`，约 178 MB

下载后请用发布仓库 `SHA256SUMS.txt` 校验文件完整性。

---

## 核心特性

- **安静观察，主动不冒犯**：默认不弹桌面通知，应用内提醒克制呈现。
- **截图只作输入**：默认保留当天，可配置数小时到 7 天；UI 不展示截图墙。
- **L0 → L1 → L2 → L3 自动记忆**：观察、抽取、关联、主动性判断、日报由视觉模型自动完成；用户可以编辑、删除、合并、纠错。
- **每日工作主线**：今日页按时间轴呈现今天的主线、线索、提醒和复盘。
- **双轨报告**：工作日报 + 个人复盘，固定时间自动生成草稿，可编辑可复制。
- **本地优先 + 隐私边界**：截图与数据库全在本地，不上传到 Recall 自有服务器；自带 API Key，模型调用直连你自己的 endpoint。
- **可审计开源**：完整源码公开（BUSL 1.1），无后门，无远程上传。

---

## 工作流概览

```text
桌面活动（窗口、标题、输入、变化）
       ↓
本地事件触发采集（黑名单与敏感场景自动跳过）
       ↓
视觉模型理解：L0 Observation
       ↓
抽取与关联：L1 Fact · L2 Scene · L3 Memory Object
       ↓
主动性判断：提醒 / 待确认 / 风险
       ↓
今日时间轴 · 提醒 · 日报 · 复盘
```

---

## 快速开始（用户视角）

1. 前往 [recall-releases](https://github.com/xscanzm/recall-releases) 下载 `Recall-0.1.0-setup.exe`。
2. 双击安装，桌面会出现 **Recall** 图标。
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

> 构建产物 `release/Recall-0.1.0-setup.exe` 与 `release/win-unpacked/Recall.exe` 即对应发布仓库的分发物。

类型检查：

```bash
npm run typecheck:main
npm run typecheck:renderer
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

- 主仓库：https://github.com/xscanzm/recall
- 发布仓库：https://github.com/xscanzm/recall-releases
- Issues：https://github.com/xscanzm/recall/issues

> 由于采用 BUSL 1.1 许可证，**生产环境相关的 PR 不会被合并到主仓**。如希望商业集成或重分发，请联系 Licensor 协商替代许可安排。
