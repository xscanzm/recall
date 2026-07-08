# 21. 今日页像素级实现规格

本文档给 AI coding agent 使用。目标是把 Recall 今日页从工程后台页面改造成用户每天愿意打开的主界面。

必须严格按本文实现。不要自由发挥成聊天页、后台表格页或截图墙。

## 1. 今日页目标

今日页回答三个问题：

1. 我今天做了什么？
2. 还有什么没收尾？
3. 我如何生成自己的复盘和可提交的工作日报？

页面核心布局：

```text
左侧导航栏 | 中间今日时间轴 | 右侧结果面板
```

中间时间轴是主视觉。右侧结果面板是结果和操作。

## 2. 页面尺寸和布局

### 2.1 根容器

```css
.today-page {
  display: grid;
  grid-template-columns: 76px minmax(560px, 1fr) 360px;
  height: 100vh;
  background: #F7F6F2;
  color: #1E2423;
  overflow: hidden;
}
```

响应式：

- 窗口宽度 >= 1280px：三栏显示。
- 1024px - 1279px：右侧面板宽度降到 320px。
- < 1024px：右侧面板变为可收起 drawer；默认显示时间轴。

### 2.2 左侧导航栏

宽度：76px。

背景：`#FFFFFF` 或 `rgba(255,255,255,0.72)`。

边框：右侧 `1px solid #E2E0D8`。

导航项：

- 今日
- 待收尾
- 报告
- 项目
- 记忆库
- 设置

只显示图标 + hover tooltip。当前页图标使用低饱和青绿色背景。

不要使用大面积彩色按钮。

### 2.3 中间主区域

结构：

```text
TimelineHeader
TimelineToolbar
TimelineList
```

内边距：

- 左右：32px。
- 顶部：24px。
- 底部：32px。

CSS 建议：

```css
.timeline-main {
  min-width: 0;
  overflow-y: auto;
  padding: 24px 32px 32px;
}
```

### 2.4 右侧结果面板

宽度：360px，最小 320px，最大 420px。

背景：`#FFFFFF`。

边框：左侧 `1px solid #E2E0D8`。

内边距：20px。

滚动：右侧面板内部滚动，不影响中间时间轴。

CSS：

```css
.today-side-panel {
  width: 360px;
  overflow-y: auto;
  padding: 20px;
  border-left: 1px solid #E2E0D8;
  background: #FFFFFF;
}
```

## 3. 视觉系统

### 3.1 颜色

```css
:root {
  --recall-bg: #F7F6F2;
  --recall-surface: #FFFFFF;
  --recall-surface-soft: #FBFAF7;
  --recall-text: #1E2423;
  --recall-text-muted: #66706D;
  --recall-text-faint: #8C9491;
  --recall-border: #E2E0D8;
  --recall-accent: #2F8F83;
  --recall-accent-soft: #E5F2EF;
  --recall-amber: #D9912B;
  --recall-amber-soft: #F8EEDB;
  --recall-danger: #C74D3C;
  --recall-danger-soft: #F7E6E2;
}
```

不要使用：

- 大面积紫色/蓝色渐变。
- 纯黑大块背景。
- 大面积霓虹发光。

### 3.2 字体

Windows 默认：

```css
font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
```

字号：

- 页面标题：24px / 32px，font-weight 650。
- 区块标题：15px / 22px，font-weight 650。
- 卡片标题：16px / 24px，font-weight 650。
- 正文：14px / 22px。
- 辅助信息：12px / 18px。

不要使用 viewport 动态字号。

### 3.3 圆角和阴影

- 大卡片圆角：8px。
- 小按钮圆角：8px。
- 标签圆角：999px。
- 阴影只用于浮层，不用于所有卡片。

卡片默认用边框：

```css
border: 1px solid var(--recall-border);
```

## 4. TimelineHeader

位置：中间主区域顶部。

内容：

```text
今日
一句今日主线 summary
右侧：观察状态 pill + 暂停按钮 + 忘掉最近
```

示例：

```text
今日
今天主要围绕 Recall 产品体验升级展开，重点是时间轴、双轨日报和 AI prompt 改造。
```

不要显示：

- “识别到 18 facts”
- “L2 scenes”
- “model jobs”

状态 pill：

- 观察中：绿色柔和点 + “观察中”
- 已暂停：灰色点 + “已暂停”
- 跳过敏感内容：琥珀点 + “已跳过敏感内容”
- 模型异常：红色点 + “模型连接异常”

CSS：

```css
.status-pill {
  height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--recall-border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--recall-text-muted);
  background: var(--recall-surface);
}
```

## 5. TimelineToolbar

位置：Header 下方，TimelineList 上方。

内容：

- 日期选择：今天 / 前一天 / 后一天。
- 视图切换：片段 / 细节。
- 生成工作日报按钮。
- 搜索今天。

按钮文案：

- `生成工作日报`
- `我的复盘`
- `仅看工作`

不要放太多按钮。

## 6. TimelineList

### 6.1 默认状态

显示 TimelineBlock 卡片列表。

每张卡片结构：

```text
时间范围
标题
摘要
项目标签 / 类型标签
关键产出 chips
底部操作：查看来源 / 加入日报 / 忽略
```

### 6.2 卡片尺寸

```css
.timeline-card {
  position: relative;
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 16px;
  padding: 16px;
  margin-bottom: 12px;
  border: 1px solid var(--recall-border);
  border-radius: 8px;
  background: var(--recall-surface);
}
```

时间列：

```css
.timeline-card__time {
  font-size: 12px;
  line-height: 18px;
  color: var(--recall-text-faint);
}
```

标题：

```css
.timeline-card__title {
  font-size: 16px;
  line-height: 24px;
  font-weight: 650;
  color: var(--recall-text);
  margin-bottom: 6px;
}
```

摘要：

```css
.timeline-card__summary {
  font-size: 14px;
  line-height: 22px;
  color: var(--recall-text-muted);
  margin-bottom: 12px;
}
```

### 6.3 时间轴线

卡片左侧可以有一条细竖线和时间节点，但要克制。

实现：

- `.timeline-list` 内使用伪元素画一条 `1px` 竖线。
- 每张卡片时间附近有 8px 圆点。
- 颜色用 `#D6D3CA`。

不要做很重的时间线，不要像项目管理甘特图。

### 6.4 标签

标签类型：

- 项目：青绿色浅底。
- 类型：灰色浅底。
- 风险/待确认：琥珀浅底。

```css
.tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 22px;
  background: var(--recall-surface-soft);
  color: var(--recall-text-muted);
}
```

## 7. 时间轴内容规则

### 7.1 标题

标题来自 TimelineBlock.title。

必须是务实标题。

正确：

- 整理 Recall 产品体验升级方向
- 评估双轨日报和时间轴设计
- 修复模型连接配置问题
- 与团队确认本周交付范围

错误：

- 深海沉浸
- 今日颂歌
- 心流年轮
- 灵感拼图

### 7.2 摘要

摘要来自 TimelineBlock.summary。

要求：

- 1-2 句。
- 说明这段时间做了什么和产生什么价值。
- 不评判用户。

正确：

```text
这段时间主要在阅读和筛选体验升级建议，重点确认了首页时间轴和双轨日报的方向。
```

错误：

```text
你在灵感海洋里穿梭，为今日点亮了新的创造微光。
```

### 7.3 休息和空白片段

如果 category=break：

标题用：

- 短暂休息
- 离开电脑
- 暂无明显活动

不要写：

- 摸鱼
- 闲置过久
- 无效时间

摘要示例：

```text
这段时间没有明显电脑操作，可能是离开电脑或暂时休息。
```

## 8. 右侧结果面板

### 8.1 模块顺序

右侧面板必须按以下顺序：

1. 今日主线
2. 待收尾
3. 今日成果
4. 今日决策
5. 我的复盘
6. 工作日报
7. 明天接着做

### 8.2 模块样式

每个模块：

```css
.side-section {
  padding: 14px 0;
  border-bottom: 1px solid var(--recall-border);
}

.side-section__title {
  font-size: 13px;
  line-height: 20px;
  font-weight: 650;
  color: var(--recall-text);
  margin-bottom: 8px;
}
```

不要把右侧每个模块都做成重卡片，否则会卡片套卡片。

### 8.3 今日主线

显示 dayMainThread。

示例：

```text
今天主要围绕 Recall 产品体验升级展开，重点是时间轴、双轨日报和 AI prompt 改造。
```

### 8.4 待收尾

最多显示 3 条。

每条：

```text
标题
建议下一步
```

操作：

- 标记完成
- 稍后

如果超过 3 条，底部显示：

```text
查看全部待收尾
```

### 8.5 今日成果

显示 reportable highlights。

最多 4 条。

如果没有：

```text
今天还没有整理出明确成果。继续工作一会儿后，Recall 会自动补充。
```

### 8.6 今日决策

显示 decisions。

最多 3 条。

每条可以点击查看来源。

### 8.7 我的复盘模块

按钮：

- `生成我的复盘`
- 如果已生成：`查看复盘`

说明文案：

```text
给自己看的真实回顾，帮助你知道今天做了什么、明天从哪里继续。
```

### 8.8 工作日报模块

按钮：

- `选择片段生成日报`

说明文案：

```text
只使用你选择的工作片段生成，适合复制给上司或团队。
```

如果已有草稿：

- `查看工作日报`
- `重新选择片段`

### 8.9 明天接着做

显示 tomorrowStartHere 或 unfinishedThreads 里的 suggestedNextAction。

最多 3 条。

## 9. 工作日报选择模式

用户点击 `选择片段生成日报` 后进入选择模式。

### 9.1 页面变化

- TimelineToolbar 显示选择模式提示。
- TimelineCard 左侧显示 checkbox。
- reportable=true 且 privateRisk=low 的卡片默认选中。
- privateRisk=high 的卡片默认不可选，除非用户展开并强制选择，MVP 可以不支持强制选择。
- 右侧面板切换为“日报选择面板”。

### 9.2 选择模式顶部提示

文案：

```text
选择要写进工作日报的片段
未选择的内容不会进入本次日报生成。
```

按钮：

- 取消
- 仅选工作相关
- 清空
- 生成日报

### 9.3 卡片选中样式

选中：

```css
.timeline-card.is-selected {
  border-color: var(--recall-accent);
  background: var(--recall-accent-soft);
}
```

未选：

- 正常背景。
- 不要过度变暗，避免像被惩罚。

不可选：

- opacity: 0.56。
- 显示小标签：`含私人/敏感内容，默认不用于日报`。

### 9.4 右侧日报选择面板

显示：

```text
将使用 6 个工作片段
预计生成：标准工作日报

已排除：
- 2 个私人/敏感片段
- 1 个休息片段

[预览内容]
[生成工作日报]
```

### 9.5 生成前预览

必须提供预览弹层或页面区域。

预览内容：

- 将发送给 WorkReportWriter 的 TimelineBlock 标题列表。
- 不显示截图。
- 显示隐私提示。

文案：

```text
以下内容将用于生成工作日报。未列出的片段不会进入本次生成。
```

按钮：

- 返回修改
- 确认生成

## 10. 报告生成结果

工作日报生成后，右侧面板显示草稿预览。

必须有：

- 复制按钮。
- 编辑按钮。
- 重新选择片段。

不要只显示 JSON。

plainText 渲染为可读文本。

## 11. 空状态

### 11.1 今日无记录

```text
今天还没有记录。
开启观察后，Recall 会把你的电脑工作整理成时间轴、待收尾和日报素材。
```

按钮：

- 开始观察
- 配置模型

### 11.2 模型未配置

```text
还没有连接模型。
Recall 需要你自己的视觉模型和语言模型来理解屏幕内容。
```

按钮：

- 去配置

### 11.3 暂停中

```text
Recall 已暂停。
暂停期间不会采集窗口，也不会调用模型。
```

按钮：

- 恢复观察

## 12. 加载状态

Timeline 正在生成：

显示 skeleton，不显示 spinner 大转圈。

Skeleton：

- 4 张灰色卡片。
- 每张有时间条、标题条、摘要条。

报告生成中：

按钮变为：

```text
正在生成...
```

不要使用长时间打字机动画阻止用户操作。

## 13. 错误状态

### 13.1 模型错误

```text
模型连接失败。请检查 endpoint、model 和 API Key。
```

按钮：

- 去设置
- 重试

### 13.2 生成日报失败

```text
日报生成失败。你选择的片段还在，可以稍后重试。
```

按钮：

- 重试
- 返回选择

### 13.3 没有可生成日报的片段

```text
今天还没有适合写进工作日报的片段。
你也可以手动选择时间轴中的工作内容。
```

## 14. 禁止出现的 UI 文案

前台禁止出现：

- L0
- L1
- L2
- Fact
- Scene
- Observation
- Model job
- Confidence: 0.87
- 检测到用户
- 今日颂歌
- 深海沉浸
- 心流年轮
- 摸鱼
- 闲置过久

可以在开发调试模式出现，但普通用户模式不得出现。

## 15. 组件拆分

建议组件：

```text
TodayPage
  AppSidebar
  TodayHeader
  TimelineToolbar
  TimelineList
    TimelineCard
    TimelineEmptyState
    TimelineSkeleton
  TodaySidePanel
    MainThreadSection
    UnfinishedSection
    HighlightsSection
    DecisionsSection
    PersonalReviewSection
    WorkReportSection
    TomorrowSection
  WorkReportSelectionPanel
  WorkReportPreviewModal
```

## 16. 数据接口

TodayPage 需要的数据：

```ts
interface TodayPageData {
  dateKey: string;
  appStatus: {
    observing: boolean;
    paused: boolean;
    currentState: "observing" | "paused" | "sensitive_skipped" | "model_error" | "idle";
  };
  dayMainThread: string;
  timelineBlocks: TimelineBlock[];
  unfinishedThreads: UnfinishedThread[];
  highlights: Array<{
    text: string;
    sourceTimelineBlockIds: string[];
  }>;
  decisions: Array<{
    text: string;
    sourceFactIds: string[];
  }>;
  personalReview?: {
    id: string;
    title: string;
    overview: string;
  };
  workReport?: {
    id: string;
    title: string;
    plainText: string;
  };
  tomorrowStartHere: string[];
}
```

## 17. 交互验收

### 17.1 今日页基础验收

- 打开今日页能看到中间时间轴。
- 右侧能看到今日主线。
- 没有技术词。
- 没有截图墙。
- 卡片标题务实清楚。

### 17.2 工作日报选择验收

- 点击选择片段生成日报后，卡片出现 checkbox。
- 工作相关片段默认选中。
- 私人/敏感片段默认不选。
- 右侧显示将使用几个片段。
- 预览中只显示被选片段。
- 生成结果可复制。

### 17.3 复盘验收

- 可以生成我的复盘。
- 复盘不是工作日报口吻。
- 复盘包含未收尾和明天接续。

### 17.4 视觉验收

- 页面不像后台表格。
- 卡片间距舒服。
- 右侧面板清楚但不拥挤。
- 按钮文案清楚。
- 没有大面积炫酷动画。

## 18. 最小可交付范围

如果时间有限，优先完成：

1. 三栏布局。
2. TimelineBlock 卡片。
3. 右侧结果面板。
4. 工作日报选择模式。
5. 工作日报生成和复制。
6. 我的复盘生成。

不要先做：

- 无级变焦。
- 粒子动画。
- 截图缩略图墙。
- 复杂仪表盘。

