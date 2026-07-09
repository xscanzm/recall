# 28. 记忆系统重构设计：瞬间、片段、记忆原子与长期对象

## 1. 核心判断

Recall 的记忆系统不应该把“识别屏幕”和“得出结论”揉在一次模型调用里。旧设计里 L0 observation 和 L1 fact 一起生成，一旦多模态调用失败或输出不稳定，底层观察和后续事实都会同时丢失，长期记忆自然无法积累。

新的系统目标是：先保存可追溯的观察，再逐层沉淀。每一层都能独立失败、重试、纠错和重建。

```text
L-1 Capture Ledger
  原始采集账本，不是记忆层。

L0 Moment
  瞬间观察：这个时间点看见了什么。

L1 Episode
  活动片段：一段时间在做什么。

L2 Memory Atom / Claim
  记忆原子：从片段中提炼出的可沉淀主张。

L3 Memory Object
  长期对象：项目、任务、人物、偏好、决策、知识等跨时间积累的对象。

Edges
  关系层：连接瞬间、片段、记忆原子、长期对象和报告。
```

L0-L3 是记忆主链；Edges 不是 L4，而是贯穿所有层的连接组织。

## 2. 分层定义

### L-1 Capture Ledger

Capture Ledger 只记录采集事实，不进用户时间轴，也不参与总结。

它保存：

- captureId
- capturedAt
- appName
- windowTitle
- urlOrDomain
- captureReason
- activitySignals
- screenshot paths / retention state
- model processing status

它的价值是工程追溯：即使模型失败，系统也知道这里发生过一次采集。

### L0 Moment

L0 是瞬间观察层。它的内核是“我看见了什么”，不是“这件事意味着什么”。

L0 应该低判断、强证据、可回放、可降级保存。

L0 可以包含：

- 应用、窗口、时间
- 可见内容类型：chat / document / code / webpage / terminal 等
- 屏幕内容摘要
- 关键文字片段
- 候选实体：人、项目、文件、产品、概念
- possible intent / possible task 等弱线索
- uncertainties
- confidence
- screenshot retention state

L0 不应该直接创建任务、项目进展、长期人物关系或报告结论。

### L1 Episode

L1 是活动片段层。它的内核是“这段时间在做什么”。

L1 从多个 L0 moments 生成，是前台“今日”时间线的主体。

L1 应该包含：

- startAt / endAt
- title
- summary
- involved apps / windows
- entity candidates
- project/person candidates
- sourceMomentIds
- confidence
- 用户纠错状态

L1 的重点不是精准提炼所有事实，而是把碎片化瞬间组织成用户能回忆的一段上下文。

### L2 Memory Atom / Claim

L2 是可沉淀记忆原子。它不是独立页面，而是项目、人物、待收尾、记忆库和报告的底层材料。

建议前台不要直接叫“Fact”。更合适的内部语义是 Claim / Atom：有证据支持的记忆主张，允许被修正、驳回、替代。

L2 类型包括：

- task
- decision
- project_progress
- person_context
- preference
- knowledge
- risk
- question
- note

每个 L2 必须引用来源：

- sourceEpisodeIds
- sourceMomentIds
- evidenceText
- confidence
- lifecycle status: candidate / active / corrected / rejected / superseded

### L3 Memory Object

L3 是跨时间积累的长期对象。

对象类型包括：

- Project
- Task
- Person
- Preference
- Decision
- Knowledge

L3 不应该由单个 L0 直接生成，也不应该只靠一次模型判断创建。它应由 L2 atoms 持续更新，并保留来源关系。

## 3. 关系层 Edges

人、事、物之间的关联必须做，但不要一开始做成重型知识图谱。SQLite 中的轻量关系表足够作为第一版。

系统负责稳定关系：

- Episode contains Moment
- Atom derived_from Episode
- Object supported_by Atom
- Report uses Episode / Atom
- 时间相邻
- 同 app/window/url 的弱关系

模型负责语义候选：

- Atom belongs_to Project
- Atom updates Task
- Episode involves Person
- Atom duplicates / contradicts / continues another Atom
- Object alias / merge suggestion

系统最后做校验和落库：

- source / target 是否存在
- confidence 是否够
- 是否重复
- 是否和用户纠错冲突
- 是否需要 pending confirmation

关系表建议：

```text
memory_edges

id
from_type
from_id
to_type
to_id
relation_type
confidence
created_by: system | model | user
evidence_ids_json
status: active | pending | rejected | superseded
reason
created_at
updated_at
```

## 4. 前台信息架构

前台不展示 L0/L1/L2/L3 术语，而展示自然入口：

```text
今日
待收尾
项目
人物
记忆库
报告
设置
```

### 今日

今日页是首页，主体来自 L1 Episode。

用户看到的是一天的片段流：

```text
14:02 - 14:12
微信：和张三讨论 Recall 记忆系统分层

摘要：
围绕 L0-L3 的重新定义展开，重点讨论 L1 作为工作片段。

相关：
张三 · Recall · 记忆系统

提炼：
- L1 应该表示工作片段
- L2 应该表示记忆原子
- 后续需要整理新版设计
```

今日页是自用界面，应该忠实记录，不提前替用户做敏感降级。隐私筛选和对外措辞由报告生成阶段处理。

今日页还承载“我的复盘”：某一天的自用小结。打开历史日期时，可以看到当天时间线和当天复盘。

### 待收尾

待收尾不是传统任务管理器，而是 open loops 页面。

它收纳：

- 需要继续的事
- 需要确认的事
- 可能遗忘的承诺
- 有阻塞的事项

页面内可分组：

```text
需要继续
需要确认
可能遗忘
有阻塞
已完成
已忽略
```

### 项目

项目页展示 L3 Project Object，但内容由 L1 episodes 和 L2 atoms 支撑。

页面展示：

- 当前项目摘要
- 最近片段
- 关键记忆
- 待收尾
- 相关人物
- 来源

### 人物

人物页展示“我和这个人的上下文”，不是监控别人。

页面展示：

- 最近互动
- 相关项目
- 提到过的事
- 待跟进 / 待收尾
- 来源片段

### 记忆库

记忆库是全局搜索与问答入口，横跨：

- L1 episodes
- L2 atoms
- L3 objects
- reports

搜索和问答必须列来源。

### 报告

报告页负责对外表达：

- 日报
- 周报
- 月报
- 项目复盘 / 阶段总结

报告生成阶段才使用 reportable、privacy risk、external summary 等字段，负责筛选、脱敏、改写和重组。

### 设置

设置页承载：

- 观察开关
- 模型配置
- 截图保留
- 隐私规则
- 通知设置
- 数据导出/清空
- 调试入口开关

## 5. 我的复盘

“我的复盘”应该保留，但不必作为主导航。它更适合作为今日页的日期级视图。

复盘面向自己，区别于报告：

```text
报告 = 对外表达
复盘 = 对内理解
```

复盘内容建议：

- 今日脉络
- 重要推进
- 反复出现的主题
- 还悬着的事
- 值得记住
- 明天从这里开始

复盘可以提及私人上下文、犹豫、不确定和过程；报告只讲可交付、项目进展、风险和计划。

## 6. 实施顺序

不要再一次性重写 L0-L3。按层推进：

1. 定义新文档、命名、关系表和前台导航。
2. 重构 L0：多帧提交，但只生成 N 个 Moment；按帧落库；失败可降级。
3. 重构 L1：从 L0 moments 生成 Episode，作为今日时间线主体。
4. 重构 L2：从 Episode 提炼 Memory Atom / Claim，不再从单帧直接抽事实。
5. 重构 L3：由 Memory Atom 更新长期对象，并通过 Edges 保留来源。
6. 调整报告：只在报告生成阶段做对外筛选和措辞。

第一批代码修改只做低风险基础设施，不直接接管旧 pipeline。
