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

## 7. 当前实现检查点

截至本检查点，代码已经不再停留在基础设施阶段，而是完成了一条可验证的批次记忆主链：

```text
6 帧 BatchCaptureBundle
  -> L0 observations（逐帧落库）
  -> L1 episode / scene（规则切片）
  -> L2 facts（从 episode 抽取）
  -> L3 objects（project/task/person/decision）
  -> memory_edges（observation / scene / fact / object 之间的来源关系）
```

关键实现点：

- L0 批次观察：`CaptureBatcher` 默认攒 6 帧，`ObserverExtractorWorker.runObservationsForBatch` 只返回 observations，不直接抽 facts。
- L1 片段：`EpisodeBuilder` 从已落库 observations 生成 episode，并写入 scene -> observation 的 `contains` 边。
- L2 原子：`EpisodeFactExtractorWorker` 基于 episode 和真实 observation ids 抽取 facts。
- L3 对象：`LinkerSceneJudgeWorker` 基于 episode facts 创建或链接项目、任务、人物、决策。
- 关系投影：`SceneRelationProjector` 把 facts 和对象关系回填到 scene、project、task、decision、person，并补 scene -> object 边。
- 新建对象收口：新建或去重命中 L3 对象后，会补齐 fact -> object 边，并尽量回填 `fact.projectId`、`task.projectId`、`decision.projectId`、`person.relatedProjectIds`。

当前自动化验收命令：

```powershell
npm run typecheck:main
npm run typecheck:renderer
npm run build:main
npm run build:renderer
npm run smoke:memory
npm run smoke:renderer
```

`smoke:memory` 使用 Electron Node 模式运行，因为 `better-sqlite3` 是按 Electron ABI 编译的。该 smoke 不调用真实模型 API，而是使用合成的模型输出验证本地数据编排。一次通过应证明：

- 6 条 L0 observations 入库
- 至少 1 个 L1 episode/scene 入库
- L2 facts 能挂回 episode
- L3 project/task/person/decision 能创建并互相关联
- scene -> observation、scene -> fact、fact -> object、scene -> object 的 edges 均存在

`smoke:renderer` 启动隐藏 Electron BrowserWindow，加载真实打包后的 renderer，并通过 preload 注入受控 IPC 数据。该 smoke 验证前台能消费新链路数据：

- 今日页展示时间轴片段、待收尾和我的复盘。
- 待收尾页能打开来源弹窗，并显示来源事实。
- 项目页能进入项目详情，展示最近时间轴、待收尾、关键决策和相关人物。
- 人物页能进入人物详情，展示相关项目、最近协作和提到过的事。
- 记忆库页能正常进入搜索/问答入口。
- 报告页能展示工作日报，并打开来源面板显示来源事实和时间轴片段。

仍未完成的最终验收：

- 用真实应用运行一次观察，而不是只跑合成 smoke。
- 用真实模型输出验证 prompt 质量、失败降级和异常输出修复。
- 在真实数据库和真实采集数据下复核今日、待收尾、项目、人物、报告的展示质量。
- 根据真实数据再校正 L1 切片边界和 L2 抽取粒度。

## 8. 可靠性闭环检查点

在上述主链基础上，当前实现进一步补齐了记忆系统的工程闭环：

- 批次按 Observer、Episode、Atom、Linker 四个阶段分别记录状态和 checkpoint。下游失败不会再把整批误标为完成，重试会从最近成功阶段继续。
- Episode、Atom 和 Edge 使用稳定推导键或自然关系键，重复执行不会重复写入同一派生结果。
- Atom 明确保存 `sourceEpisodeIds`、`claimStatus`、`generationPath`、`generationVersion` 和 `derivationKey`。运行时新数据只走批次主链，旧单帧直出 Fact 的路径不再由调度器调用。
- Edge 写入会校验已支持节点的存在性，并按来源、目标和关系类型 upsert。
- 用户纠错会在同一事务中保存修改前后快照、更新 Claim 生命周期、记录反馈，并写入 Timeline、Report、Search、L3 投影失效队列。
- 投影失效处理器会重建受影响日期的 Timeline、标记相关 Report stale、重新投影 L3 关系；单项失败会保留错误状态。
- Memory Q&A 的来源由后端限定在本次检索结果中，并由后端重建来源标题和摘要。
- 工作报告和旧报告路径在调用模型前执行确定性的 reportable / privacy 过滤，模型返回的来源 ID 也会再次经过白名单校验。
- 忘记最近数据会同时清理 L0-L3 派生数据、关联边和对应 Capture Ledger；清空全部数据也会删除用户反馈与持久化模型 I/O。
- Today 的 TimelineBlock 被明确视为 L1 Episode 的派生展示投影，来源入口可以展示 Episode、Atom 和 Moment ID；Today 自用摘要不再提前套用对外报告过滤。

当前自动化验证覆盖：

```powershell
npm run typecheck
npm test
npm run test:sqlite
npm run build
npm run smoke:memory
npm run smoke:renderer
```

这些验证证明结构契约、迁移、幂等恢复、纠错失效、隐私清理和前台消费链可以工作，但不替代真实模型质量验收。发布前仍需使用真实应用数据连续运行，评估 L0 识别准确率、L1 切片边界、L2 主张粒度、L3 误创建率、提醒打扰率、报告隐私边界和不同 OpenAI-compatible provider 的结构化输出兼容性。
