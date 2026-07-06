# 09. Implementation Plan

## 开发原则

先做能运转的智能闭环，再做完整漂亮界面。

正确顺序：

```text
项目骨架
  -> 数据库
  -> 模型配置
  -> 截图采集
  -> AI pipeline
  -> 今日页最小展示
  -> 提醒和日报
  -> UI polish
```

不要先做一堆静态页面。

## Milestone 0: 项目初始化

目标：创建可启动的 Electron + React + TypeScript 应用。

任务：

- 初始化项目。
- 配置 TypeScript。
- 配置 Electron main/renderer。
- 配置开发启动脚本。
- 配置 Windows 打包脚本。
- 建立基础目录结构。
- 建立 IPC 白名单基础。

验收：

- `npm install` 成功。
- `npm run dev` 启动桌面应用。
- Renderer 能通过 IPC 获取 app status。

## Milestone 1: 数据库和设置

目标：本地 SQLite 和设置系统可用。

任务：

- 建立 SQLite。
- 实现 migrations。
- 建立 04 文档中的核心表。
- 实现 Repository。
- 实现 SettingsService。
- 实现模型配置表。
- 实现 SecretService 保存 API Key。

验收：

- 首次启动自动建库。
- 重启后设置仍在。
- API Key 不出现在 SQLite。
- 可创建/更新/删除模型配置。

## Milestone 2: 模型网关

目标：视觉模型和语言模型都能通过 OpenAI-compatible endpoint 调用。

任务：

- 实现 ModelGateway。
- 支持 vision call。
- 支持 language call。
- 实现超时、错误码、重试。
- 实现连接测试。
- 实现 zod schema 校验。
- 实现 JSON repair 一次重试。

验收：

- 用户填入 endpoint/key/model 后能测试成功。
- 错误 key 显示鉴权错误。
- 模型输出非法 JSON 时能尝试修复。
- 修复失败不写入正式数据。

## Milestone 3: 采集和截图缓存

目标：能观察活动窗口并生成 CaptureBundle。

任务：

- 实现 ActivityService。
- 实现 CaptureService。
- 实现 ScreenshotCache。
- 实现 PrivacyGuard。
- 支持黑名单。
- 支持截图 retention 设置。
- 支持清理过期截图。

验收：

- 观察中时能捕获活动窗口。
- 暂停时不捕获。
- 黑名单应用不捕获。
- 截图保存到 cache 目录。
- 过期截图可被清理。
- UI 不展示截图墙。

## Milestone 4: AI Pipeline 最小闭环

目标：一次活动窗口采集能自动生成 observation、facts、links、提醒。

任务：

- 实现 ModelJobQueue。
- 实现 Observer 调用。
- 实现 Observation Normalizer。
- 实现 Extractor 调用。
- 实现 Linker 调用。
- 实现 Scene Builder。
- 实现 Judge 调用。
- 写入 observations/facts/scenes/tasks/projects/proactive_items。

验收：

- 捕获一个文档窗口后能生成 L0 observation。
- Extractor 能生成 L1 facts。
- Linker 能创建或关联项目/任务。
- Judge 能生成应用内提醒。
- 所有模型输出可追溯 source ids。

## Milestone 5: 今日页和提醒页

目标：用户能看到 Recall 正在理解今天。

任务：

- 实现 AppShell。
- 实现顶部状态。
- 实现今日概览。
- 实现工作片段列表。
- 实现提醒栏。
- 实现提醒操作：确认、忽略、稍后、标记完成、编辑。

验收：

- 今日页显示今天 scenes/facts/tasks。
- 提醒可操作。
- 标记完成后任务状态更新。
- 编辑内容写入 user_feedback。

## Milestone 6: 日报和周报

目标：系统能基于结构化记忆生成报告。

任务：

- 实现 Reporter 调用。
- 实现 daily report scheduler。
- 实现 manual generate。
- 实现报告编辑器。
- 实现复制。
- 实现周报生成。

验收：

- 日报不直接引用截图。
- 日报条目有 source fact/scene ids。
- 用户可编辑日报。
- 用户可复制日报。
- 周报能按项目组织。

## Milestone 7: 任务、项目、记忆库

目标：长期记忆可浏览、搜索、修正。

任务：

- 任务页。
- 项目页。
- 记忆库搜索。
- 轻量问答。
- 来源详情。
- 编辑/删除/合并基础能力。

验收：

- 用户能查看某项目最近进展。
- 用户能搜索历史事实。
- 用户能追溯提醒来源。
- 用户能删除错误记忆。

## Milestone 8: 设置和信任中心

目标：用户能控制产品。

任务：

- 模型设置页。
- 观察设置。
- 截图保留设置。
- 黑名单管理。
- 通知设置。
- 清空数据。
- 导出 JSON。
- 信任中心。

验收：

- 用户能设置截图保留为立即删除/1h/6h/当天/3天/7天。
- 用户能清空截图缓存。
- 用户能关闭桌面通知。
- 用户能暂停观察。
- 信任中心清楚说明保存什么。

## Milestone 9: Polish 和打包

目标：可给种子用户试用。

任务：

- UI polish。
- 错误状态。
- 空状态。
- 加载状态。
- 性能优化。
- Windows 打包。
- 基础日志。

验收：

- 种子用户能安装。
- 首次启动 5 分钟内完成配置并开始观察。
- 连续使用 1 天不崩溃。
- 日报可用。

## 开发注意事项

### 不要把术语暴露给用户

前台不要直接显示 L0/L1/L2/L3，除非开发调试模式。

### 不要省掉 schema 校验

模型输出必须严格校验。不能用正则或字符串拼接凑。

### 不要让 UI 等待长模型调用

所有模型调用后台队列化。UI 显示状态。

### 不要默认展示截图

截图可以本地缓存，但不要做截图主界面。

### 不要把规则写死为智能

任务发现、重要性判断、提醒内容必须来自 AI workers，不要只靠关键词规则。

## 推荐开发分支顺序

如果多个 agent 分工：

1. Agent A：Electron + DB + IPC。
2. Agent B：ModelGateway + schema + prompts。
3. Agent C：Capture + ScreenshotCache + PrivacyGuard。
4. Agent D：MemoryPipeline + repositories。
5. Agent E：UI pages。
6. Agent F：Reports + acceptance tests。

合并前必须跑 `10_ACCEPTANCE_TESTS.md`。

