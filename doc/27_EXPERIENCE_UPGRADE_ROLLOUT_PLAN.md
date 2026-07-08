# 27. 体验升级实施计划与总验收

本文档给 AI coding agent 使用，定义 19-26 号文档的实施顺序。

## 1. 必读文档顺序

执行体验升级时按顺序阅读：

1. `19_RECALL_PRODUCT_EXPERIENCE_UNIFIED_SPEC.md`
2. `20_AI_PROMPTS_IMPLEMENTATION_SPEC.md`
3. `22_GLOBAL_DESIGN_SYSTEM_IMPLEMENTATION_SPEC.md`
4. `21_TODAY_PAGE_PIXEL_IMPLEMENTATION_SPEC.md`
5. `23_REPORTS_PAGE_IMPLEMENTATION_SPEC.md`
6. `24_UNFINISHED_TASKS_PAGE_IMPLEMENTATION_SPEC.md`
7. `25_PROJECTS_MEMORY_PEOPLE_PAGES_SPEC.md`
8. `26_SETTINGS_TRUST_CENTER_IMPLEMENTATION_SPEC.md`
9. `27_EXPERIENCE_UPGRADE_ROLLOUT_PLAN.md`

## 2. 实施阶段

### Phase 1：全局设计系统

实现：

- CSS tokens。
- AppShell。
- Sidebar。
- Button/Card/Tag/Empty/Error/Skeleton。
- 禁用用户界面技术词。

验收：

- 所有页面视觉统一。
- 不像后台管理系统。

### Phase 2：AI Prompts 和数据对象

实现：

- Observer/Extractor 字段扩展。
- TimelineBuilder。
- PersonalReviewWriter。
- WorkReportWriter。
- timeline_blocks 数据表。
- report selections。

验收：

- 能生成 TimelineBlock。
- 能生成我的复盘。
- 能生成工作日报。

### Phase 3：今日页

实现：

- 三栏布局。
- TimelineBlock 卡片。
- 右侧结果面板。
- 工作日报选择模式。
- 我的复盘入口。

验收：

- 用户一打开能理解今天。
- 可以选择片段生成工作日报。

### Phase 4：报告页

实现：

- 我的复盘 tab。
- 工作日报 tab。
- 周报 tab。
- 月报 tab。
- 历史 tab。
- 编辑、复制、导出。

验收：

- 工作日报可复制提交。
- 我的复盘和工作日报语气不同。

### Phase 5：待收尾页

实现：

- 分组列表。
- 标记完成/稍后/忽略。
- 查看来源。

验收：

- 不把所有 facts 当任务。
- 每条都有原因和建议下一步。

### Phase 6：项目、记忆库、人物页

实现：

- 项目列表和详情。
- 记忆库搜索。
- 人物列表和详情基础版。

验收：

- 能按项目和人物找回上下文。
- 不显示技术术语。

### Phase 7：设置和信任中心

实现：

- 模型配置。
- 截图保留。
- 黑名单。
- 通知。
- 数据管理。
- 信任中心 5 张卡片。

验收：

- 用户知道 Recall 如何工作。
- 不做虚假隐私承诺。

## 3. 总体验收清单

### 产品验收

- 用户知道今天做了什么。
- 用户知道还有什么没收尾。
- 用户能生成自己的复盘。
- 用户能生成给上司/团队看的工作日报。
- 用户能找回过去记忆。

### AI 验收

- TimelineBuilder 输出务实标题。
- WorkReportWriter 只使用用户选择内容。
- PersonalReviewWriter 更真实温和。
- 每个重要输出有来源。

### UI 验收

- 首页是时间轴中间、右侧结果面板。
- 报告页可编辑可复制。
- 待收尾页可操作。
- 项目/记忆库/人物页可找回上下文。
- 设置和信任中心完整。

### 文案验收

普通用户界面不得出现：

- L0/L1/L2
- Fact/Scene/Observation
- confidence
- 检测到用户
- 今日颂歌
- 深海沉浸
- 摸鱼

### 隐私验收

- 工作日报生成前可选择片段。
- 未选择片段不进入 WorkReportWriter prompt。
- API Key 不写数据库。
- 用户可暂停、删除、导出。

## 4. 不要做

不要优先做：

- 粒子动画。
- 无级变焦。
- 截图墙。
- 复杂图谱。
- 大面积仪表盘。
- 聊天作为主界面。

先把“今日 -> 复盘/日报 -> 长期记忆”闭环做好。

