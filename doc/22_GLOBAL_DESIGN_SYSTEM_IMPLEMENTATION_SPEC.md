# 22. 全局设计系统施工规格

本文档给 AI coding agent 使用。目标是统一 Recall 全应用的视觉、组件、文案和交互，避免每个页面各自发挥。

## 1. 设计目标

Recall 应该像一个安静、可信、精致的个人工作空间。

关键词：

- 暖白
- 清楚
- 克制
- 有温度
- 不像后台
- 不像监控
- 不像截图工具
- 不像鸡汤产品

## 2. CSS Tokens

请在全局样式中定义以下变量。

```css
:root {
  --recall-bg: #F7F6F2;
  --recall-bg-subtle: #FBFAF7;
  --recall-surface: #FFFFFF;
  --recall-surface-muted: #F3F1EA;
  --recall-text: #1E2423;
  --recall-text-muted: #66706D;
  --recall-text-faint: #8C9491;
  --recall-border: #E2E0D8;
  --recall-border-strong: #D3D0C6;
  --recall-accent: #2F8F83;
  --recall-accent-hover: #287B72;
  --recall-accent-soft: #E5F2EF;
  --recall-amber: #D9912B;
  --recall-amber-soft: #F8EEDB;
  --recall-danger: #C74D3C;
  --recall-danger-soft: #F7E6E2;
  --recall-info: #4C7299;
  --recall-info-soft: #E8EEF4;

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-pill: 999px;

  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;

  --shadow-popover: 0 12px 32px rgba(30, 36, 35, 0.12);
}
```

禁止：

- 大面积紫蓝渐变。
- 黑色仪表盘风格。
- 荧光高饱和色。
- 每个页面自定义一套色彩。

## 3. Typography

字体：

```css
font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
```

字号规范：

| 用途 | font-size | line-height | weight |
|---|---:|---:|---:|
| 页面标题 | 24px | 32px | 650 |
| 二级标题 | 18px | 28px | 650 |
| 卡片标题 | 16px | 24px | 650 |
| 区块标题 | 13px | 20px | 650 |
| 正文 | 14px | 22px | 400 |
| 辅助文字 | 12px | 18px | 400 |
| 标签 | 12px | 18px | 500 |

不要使用 viewport 动态字号。

## 4. App Shell

所有主页面使用统一 AppShell。

结构：

```text
AppShell
  Sidebar
  MainContent
```

如果页面需要右侧面板，页面内部自己实现。

Sidebar：

- 宽度 76px。
- 背景 `--recall-surface`。
- 右边框 `1px solid --recall-border`。
- 只显示图标。
- hover tooltip 显示中文名称。

导航项顺序：

1. 今日
2. 待收尾
3. 报告
4. 项目
5. 记忆库
6. 人物
7. 设置
8. 信任中心

如果图标库可用，使用 lucide 图标：

- 今日：CalendarDays
- 待收尾：ListTodo
- 报告：FileText
- 项目：FolderKanban
- 记忆库：Search
- 人物：Users
- 设置：Settings
- 信任中心：ShieldCheck

## 5. 基础组件

### 5.1 Button

类型：

- primary
- secondary
- ghost
- danger

尺寸：

```css
.btn {
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 20px;
}

.btn-sm {
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
}
```

primary：

```css
background: var(--recall-accent);
color: #FFFFFF;
```

secondary：

```css
background: var(--recall-surface);
border: 1px solid var(--recall-border);
color: var(--recall-text);
```

ghost：

```css
background: transparent;
color: var(--recall-text-muted);
```

按钮文案必须是动作：

- 生成工作日报
- 复制
- 编辑
- 查看来源
- 标记完成

不要写：

- 开启魔法
- 点亮回声
- 灵感提炼

### 5.2 Card

卡片只用于具体内容项，不要用卡片包页面区块。

```css
.card {
  border: 1px solid var(--recall-border);
  border-radius: var(--radius-md);
  background: var(--recall-surface);
}
```

禁止卡片套卡片。

### 5.3 Tag

```css
.tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font-size: 12px;
  background: var(--recall-surface-muted);
  color: var(--recall-text-muted);
}
```

类型：

- project
- category
- warning
- private
- reportable

### 5.4 Empty State

空状态结构：

```text
标题
说明
主操作按钮
次操作按钮 optional
```

语气务实，不要过度安慰。

### 5.5 Source Link

所有 AI 输出的重要条目都应该能查看来源。

SourceLink 文案：

- 查看来源
- 来自 3 个片段
- 来自今天 14:20 的记录

不要显示 source ids 给普通用户。

## 6. 页面共通状态

### 6.1 Loading

使用 skeleton，不要大 spinner。

### 6.2 Error

错误要说明用户能做什么。

模型错误：

```text
模型连接失败。请检查 endpoint、model 和 API Key。
```

数据为空：

```text
今天还没有足够内容。
```

### 6.3 Privacy State

敏感内容跳过：

```text
当前内容可能比较敏感，Recall 已跳过。
```

不要写：

```text
检测到高敏场景。
```

## 7. 文案禁用词

普通用户界面禁止出现：

- L0
- L1
- L2
- Fact
- Scene
- Observation
- Model Job
- confidence
- 检测到用户
- 置信度
- 今日颂歌
- 深海沉浸
- 心流年轮
- 摸鱼
- 闲置过久

开发调试模式可以显示，但必须隐藏在 debug 开关后。

## 8. 动效

MVP 只做轻动效。

允许：

- hover 背景变化 120ms。
- 卡片展开 160ms ease。
- drawer slide 180ms ease。
- skeleton shimmer。

禁止：

- 大量粒子动画。
- 复杂光幕。
- 长时间打字机动画。
- 果冻夸张弹跳。

## 9. 可访问性

- 所有按钮可 keyboard focus。
- focus ring 不能去掉。
- 文本和背景对比度满足基本可读性。
- tooltip 不作为唯一信息来源。
- 重要操作有明确文字。

## 10. 验收

通过标准：

- 所有主页面使用统一颜色和字体。
- 页面不像后台表格。
- 没有技术术语泄露。
- 主操作按钮清楚。
- 空/错/加载状态齐全。
- 没有过度诗意文案。

