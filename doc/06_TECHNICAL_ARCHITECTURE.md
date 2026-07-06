# 06. Technical Architecture

## 技术栈

MVP 推荐：

- Electron
- React
- TypeScript
- SQLite
- better-sqlite3 或 sqlite wrapper
- Zustand 或轻量 React store
- zod 做 schema 校验
- keytar 或 Electron safeStorage 保存 API Key
- OpenAI-compatible HTTP client

Windows-first。不要在 MVP 中追求多端。

## 进程边界

### Main Process

负责：

- 活动窗口检测。
- 截图捕获。
- 截图缓存管理。
- 模型调用。
- SQLite 读写。
- API Key 安全存储。
- 后台任务队列。
- 托盘菜单。
- 隐私规则判断。

### Renderer

负责：

- UI 展示。
- 用户设置。
- 用户编辑记忆。
- 展示提醒、任务、报告。
- 通过 IPC 调用 main process。

Renderer 禁止：

- 直接持有 API Key。
- 直接访问截图文件真实路径后展示截图墙。
- 直接调用模型 API。
- 直接写 SQLite。

## 模块结构建议

```text
src/
  main/
    app.ts
    ipc/
      channels.ts
      handlers.ts
    services/
      CaptureService.ts
      ActivityService.ts
      PrivacyGuard.ts
      ScreenshotCache.ts
      ModelGateway.ts
      ModelJobQueue.ts
      MemoryPipeline.ts
      ReportScheduler.ts
      SecretService.ts
      SettingsService.ts
      TrayService.ts
    db/
      Database.ts
      migrations/
      repositories/
        ObservationRepository.ts
        FactRepository.ts
        SceneRepository.ts
        MemoryObjectRepository.ts
        ReportRepository.ts
        SettingsRepository.ts
    models/
      schemas.ts
      types.ts
      prompts.ts
  renderer/
    app/
    pages/
      TodayPage.tsx
      RemindersPage.tsx
      TasksPage.tsx
      ProjectsPage.tsx
      ReportsPage.tsx
      MemorySearchPage.tsx
      SettingsPage.tsx
      TrustCenterPage.tsx
    components/
      AppShell.tsx
      StatusPill.tsx
      ReminderCard.tsx
      TaskRow.tsx
      SceneBlock.tsx
      ReportEditor.tsx
      ModelConfigForm.tsx
      PrivacyRuleList.tsx
    state/
    styles/
  shared/
    types.ts
    constants.ts
```

## 服务职责

### ActivityService

职责：

- 监听活动窗口。
- 获取 app name、window title、可能的 URL/domain。
- 监听键盘/鼠标活跃状态。
- 识别 idle / active session。
- 发出 capture candidate event。

MVP 可使用平台能力或 npm 库实现。若 URL 难获取，先保存 domain 为空，不阻塞。

### CaptureService

职责：

- 捕获活动窗口截图。
- 支持单帧和短时间多帧。
- 生成 stitched image。
- 返回 CaptureBundle。

注意：

- 只采活动窗口。
- 不采全屏。
- 捕获前必须调用 PrivacyGuard。
- 捕获后必须交给 ScreenshotCache 管理。

### ScreenshotCache

职责：

- 保存截图到本地 cache 目录。
- 按 retention policy 删除。
- 应用启动时清理过期截图。
- 支持用户手动“忘掉最近”。

缓存路径建议：

```text
%APPDATA%/Recall/cache/screenshots/YYYY-MM-DD/
```

文件名：

```text
capture_<timestamp>_<random>.png
stitched_<timestamp>_<random>.png
```

### PrivacyGuard

职责：

- 判断当前窗口是否可采集。
- 黑名单应用。
- 标题/URL 敏感词。
- 用户暂停状态。
- 高敏场景跳过。

注意：

- 捕获前检查一次。
- 视觉模型返回 high_sensitive 后再处理一次。

### ModelGateway

职责：

- 读取模型配置。
- 从 SecretService 获取 API Key。
- 统一调用 OpenAI-compatible endpoint。
- 支持 vision 和 language 两类模型。
- 处理超时、网络错误、鉴权错误。

第一版不要做复杂 provider plugin。只做：

- endpoint
- api key
- model
- temperature
- max tokens
- extra options JSON

### ModelJobQueue

职责：

- 管理 Observer、Extractor、Linker、Judge、Reporter 任务。
- 控制并发。
- 失败重试。
- 保存 job 状态。

建议表：

```sql
CREATE TABLE model_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### MemoryPipeline

职责：

执行：

```text
CaptureBundle
  -> Observer
  -> Observation
  -> Extractor
  -> Facts
  -> Linker
  -> L3 objects/links
  -> SceneBuilder
  -> Judge
  -> ProactiveItems
```

每一步必须可单独失败和重试。不要一个巨大函数做完全部。

### ReportScheduler

职责：

- 每日固定时间生成日报。
- 每周固定时间生成周报。
- 支持手动生成。
- 报告生成失败时显示可重试状态。

## IPC 白名单

建议 IPC channels：

```ts
type IpcChannel =
  | "app:getStatus"
  | "app:startObserving"
  | "app:pauseObserving"
  | "settings:get"
  | "settings:update"
  | "model:testConnection"
  | "privacy:listRules"
  | "privacy:addRule"
  | "privacy:updateRule"
  | "privacy:deleteRule"
  | "memory:listToday"
  | "memory:search"
  | "memory:updateFact"
  | "memory:updateTask"
  | "memory:deleteObject"
  | "reminders:list"
  | "reminders:updateStatus"
  | "reports:list"
  | "reports:get"
  | "reports:generate"
  | "reports:update"
  | "capture:forgetRecent";
```

IPC handler 必须校验参数。不要开放任意 SQL、任意文件路径读取、任意 shell。

## 状态管理

全局 app status：

```ts
interface AppStatus {
  observing: boolean;
  paused: boolean;
  currentWindow?: {
    appName: string;
    windowTitle: string;
    privacyState: "allowed" | "blocked" | "sensitive" | "unknown";
  };
  pipelineState: "idle" | "capturing" | "observing" | "extracting" | "linking" | "judging" | "reporting" | "error";
  lastError?: string;
}
```

## 数据迁移

实现 migrations：

- `001_initial_schema.sql`
- 后续每次 schema 变化新增 migration。

启动时：

1. 打开数据库。
2. 获取当前 migration version。
3. 按顺序执行未执行 migrations。
4. 失败则阻止应用进入观察状态。

## 日志

本地日志只记录：

- job id
- job type
- 状态
- 错误码
- 耗时
- 不记录截图内容
- 不记录 API Key
- 不记录完整模型输入输出，除非用户开启开发调试

## 性能原则

- 捕获和模型调用不能阻塞 UI。
- SQLite 写入在 main process 串行或事务中处理。
- 截图拼接和压缩放后台任务。
- 今日页列表分页或虚拟化。
- 图片缓存定时清理。

## 构建目标

MVP 至少支持：

- dev 启动。
- Windows 打包。
- 本地数据库初始化。
- 首次启动引导。
- 设置保存。
- 模型连接测试。

