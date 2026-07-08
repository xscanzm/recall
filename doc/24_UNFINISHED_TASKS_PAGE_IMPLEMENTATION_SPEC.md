# 24. 待收尾页施工规格

待收尾页不是传统任务管理器。它负责帮用户找回“今天或近期可能还没处理完的事情”。

## 1. 页面目标

回答：

- 哪些事今天还没收尾？
- 哪些承诺需要继续？
- 哪些任务可能已经完成，需要确认？
- 明天从哪里继续？

## 2. 页面名称

导航名称：待收尾。

不要叫：

- 任务中心
- Task Manager
- Todo Facts

## 3. 布局

```text
页面标题
筛选栏
分组列表
右侧详情 drawer optional
```

页面标题：

```text
待收尾
这里整理了 Recall 认为可能还需要你继续看一眼的事情。
```

## 4. 分组

必须使用以下分组：

1. 今天要看一眼
2. 近期未收尾
3. 可能已完成，待确认
4. 已完成
5. 已忽略

## 5. 条目字段

```ts
interface UnfinishedThreadViewModel {
  id: string;
  title: string;
  reason: string;
  suggestedNextAction: string;
  priority: "low" | "medium" | "high";
  projectName?: string;
  lastSeenAt: string;
  sourceTimelineBlockIds: string[];
  sourceFactIds: string[];
  status: "open" | "snoozed" | "done" | "ignored" | "needs_confirmation";
}
```

## 6. 卡片 UI

卡片结构：

```text
标题
原因
建议下一步
项目标签 / 最近出现时间
操作按钮
```

操作：

- 标记完成
- 稍后
- 忽略
- 改项目
- 查看来源

## 7. 文案规则

正确：

```text
这件事今天已经被明确提到，但还没有看到完成迹象，可以放到明天继续处理。
```

错误：

```text
检测到用户未完成任务。
```

错误：

```text
别让灵感熄灭。
```

## 8. 空状态

```text
目前没有需要收尾的事。
如果今天出现明确待办或未完成事项，Recall 会把它们放在这里。
```

## 9. 验收

- 页面不显示技术字段。
- 每条待收尾都有原因和建议下一步。
- 用户可以标记完成、稍后、忽略。
- 可以查看来源。
- 不把所有 facts 都变成待收尾。

