// src/renderer/pages/TasksPage.tsx
// 任务页（来自 spec.md "任务页"章节）
//
// 功能：
// - 任务按状态分组：进行中/未完成/可能已完成/阻塞/待确认/已完成
// - 每任务显示：标题/项目/最近证据/状态/优先级/更新时间
// - 操作：标记完成/改项目/编辑标题/删除/查看来源/纠错
//
// 重要约束：
// - soft delete 优先
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语

import { useEffect, useMemo, useState } from "react";
import { useAppStore, type TaskItem } from "../state/store";
import { TaskRow } from "../components/TaskRow";
import { CorrectionDialog } from "../components/CorrectionDialog";
import { TASK_STATUS_LABELS, NAMING } from "../app/naming";

/**
 * 任务状态分组顺序（来自 spec.md）
 * 与 TASK_STATUS_LABELS 一致，但分组顺序按"待办优先"
 */
const STATUS_GROUPS: Array<{
  status: string;
  label: string;
  emptyHint: string;
}> = [
  {
    status: "in_progress",
    label: TASK_STATUS_LABELS.in_progress,
    emptyHint: "没有进行中的任务",
  },
  {
    status: "open",
    label: TASK_STATUS_LABELS.open,
    emptyHint: "没有未完成的任务",
  },
  {
    status: "likely_done",
    label: TASK_STATUS_LABELS.likely_done,
    emptyHint: "没有可能已完成的任务",
  },
  {
    status: "blocked",
    label: TASK_STATUS_LABELS.blocked,
    emptyHint: "没有阻塞的任务",
  },
  {
    status: "needs_confirmation",
    label: TASK_STATUS_LABELS.needs_confirmation,
    emptyHint: "没有待确认的任务",
  },
  {
    status: "done",
    label: TASK_STATUS_LABELS.done,
    emptyHint: "没有已完成的任务",
  },
];

/**
 * 编辑任务的内联表单
 */
interface EditState {
  id: string;
  mode: "title" | "project";
  value: string;
}

export function TasksPage() {
  const isReady = useAppStore((s) => s.isReady);
  const todayData = useAppStore((s) => s.todayData);
  const todayLoading = useAppStore((s) => s.todayLoading);
  const todayError = useAppStore((s) => s.todayError);
  const loadToday = useAppStore((s) => s.loadToday);
  const updateTask = useAppStore((s) => s.updateTask);
  const deleteObject = useAppStore((s) => s.deleteObject);
  const projects = useAppStore((s) => s.todayData.projects);
  const setPage = useAppStore((s) => s.setPage);

  const [editState, setEditState] = useState<EditState | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<{
    targetType: "task";
    targetId: string;
  } | null>(null);

  // 进入页面时加载今日数据
  useEffect(() => {
    if (isReady) {
      void loadToday();
    }
  }, [isReady, loadToday]);

  // 构建项目 ID -> 项目名 映射
  const projectNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      map.set(p.id, p.name);
    }
    return map;
  }, [projects]);

  // 过滤未删除的任务
  const activeTasks = useMemo(() => {
    return todayData.tasks.filter((t) => !t.deletedAt);
  }, [todayData.tasks]);

  // 按状态分组
  const tasksByStatus = useMemo(() => {
    const groups = new Map<string, TaskItem[]>();
    for (const task of activeTasks) {
      const list = groups.get(task.status) ?? [];
      list.push(task);
      groups.set(task.status, list);
    }
    // 每组内按 updated_at 降序
    for (const list of groups.values()) {
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return groups;
  }, [activeTasks]);

  // 操作处理
  const handleComplete = async (id: string) => {
    try {
      await updateTask(id, { status: "done", completedAt: new Date().toISOString() });
    } catch (err) {
      console.error("标记完成失败:", err);
    }
  };

  const handleEdit = (id: string) => {
    const task = activeTasks.find((t) => t.id === id);
    setEditState({
      id,
      mode: "title",
      value: task?.title ?? "",
    });
  };

  const handleChangeProject = (id: string) => {
    const task = activeTasks.find((t) => t.id === id);
    setEditState({
      id,
      mode: "project",
      value: task?.projectId ?? "",
    });
  };

  const handleEditSubmit = async () => {
    if (!editState) return;
    try {
      if (editState.mode === "title") {
        await updateTask(editState.id, { title: editState.value.trim() });
      } else if (editState.mode === "project") {
        await updateTask(editState.id, { projectId: editState.value || null });
      }
    } catch (err) {
      console.error("编辑任务失败:", err);
    }
    setEditState(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定要删除这个任务吗？删除后会写入 user_feedback，后续 Judge 会参考。")) {
      return;
    }
    try {
      await deleteObject(id, "task");
    } catch (err) {
      console.error("删除任务失败:", err);
    }
  };

  const handleViewSource = (id: string) => {
    // 查看来源：跳转到记忆库搜索，搜索任务相关线索
    setPage("memory");
    // 这里简化处理，仅跳转页面
    // 完整实现应该带上搜索 query 到 memory 页面
    console.log("查看任务来源:", id);
  };

  const handleCorrect = (id: string) => {
    setCorrectionTarget({ targetType: "task", targetId: id });
  };

  if (!isReady) {
    return (
      <div className="tasks-page">
        <header className="page-header">
          <h2>{NAMING.task}</h2>
        </header>
        <p className="state-loading">正在加载...</p>
      </div>
    );
  }

  return (
    <div className="tasks-page">
      <header className="page-header">
        <h2>{NAMING.task}</h2>
        <p className="page-header__sub">
          Recall 自动从工作上下文中识别任务。你可以确认、编辑或删除。
        </p>
      </header>

      {todayError && (
        <div className="tasks-page__error">
          <span>加载失败：{todayError}</span>
          <button onClick={() => void loadToday()}>重试</button>
        </div>
      )}

      {todayLoading && activeTasks.length === 0 ? (
        <p className="state-loading">正在加载任务...</p>
      ) : activeTasks.length === 0 ? (
        <div className="empty-state">
          <p>当前没有任务。</p>
          <p className="empty-state__hint">
            开始观察后，Recall 会把发现的事项整理到这里。
          </p>
        </div>
      ) : (
        <div className="tasks-groups">
          {STATUS_GROUPS.map((group) => {
            const tasks = tasksByStatus.get(group.status) ?? [];
            if (tasks.length === 0) return null;
            return (
              <section key={group.status} className="tasks-group">
                <header className="tasks-group__header">
                  <h3 className="tasks-group__title">
                    {group.label}
                    <span className="tasks-group__count">{tasks.length}</span>
                  </h3>
                </header>
                <div className="tasks-group__list">
                  {tasks.map((task) => (
                    <div key={task.id}>
                      <TaskRow
                        id={task.id}
                        title={task.title}
                        status={task.status as never}
                        projectName={
                          task.projectId ? projectNameMap.get(task.projectId) : undefined
                        }
                        summary={task.summary}
                        priority={task.priority}
                        sourceFactIds={task.sourceFactIds}
                        updatedAt={task.updatedAt}
                        orphanStatus={task.orphanStatus}
                        onComplete={task.status !== "done" ? handleComplete : undefined}
                        onEdit={handleEdit}
                        onChangeProject={handleChangeProject}
                        onViewSource={handleViewSource}
                        onCorrect={handleCorrect}
                        onDelete={handleDelete}
                      />
                      {editState?.id === task.id && editState.mode === "title" && (
                        <div className="task-edit">
                          <p className="task-edit__hint">编辑任务标题</p>
                          <input
                            type="text"
                            className="task-edit__input"
                            value={editState.value}
                            onChange={(e) =>
                              setEditState({ ...editState, value: e.target.value })
                            }
                            autoFocus
                          />
                          <div className="task-edit__actions">
                            <button
                              className="primary"
                              onClick={handleEditSubmit}
                              disabled={!editState.value.trim()}
                            >
                              保存
                            </button>
                            <button onClick={() => setEditState(null)}>取消</button>
                          </div>
                        </div>
                      )}
                      {editState?.id === task.id && editState.mode === "project" && (
                        <div className="task-edit">
                          <p className="task-edit__hint">选择归属项目</p>
                          <select
                            className="task-edit__select"
                            value={editState.value}
                            onChange={(e) =>
                              setEditState({ ...editState, value: e.target.value })
                            }
                            autoFocus
                          >
                            <option value="">-- 无项目 --</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                          <div className="task-edit__actions">
                            <button className="primary" onClick={handleEditSubmit}>
                              保存
                            </button>
                            <button onClick={() => setEditState(null)}>取消</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* 用户纠错对话框 */}
      <CorrectionDialog
        open={correctionTarget !== null}
        targetType="task"
        targetId={correctionTarget?.targetId ?? ""}
        onClose={() => setCorrectionTarget(null)}
        onSubmitted={() => {
          // 纠错后重新加载今日数据
          void loadToday();
        }}
      />

      <style>{`
        .tasks-page__error {
          background-color: #fbeeeb;
          border: 1px solid var(--danger);
          border-radius: var(--radius-card);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: var(--danger);
          font-size: 13px;
        }
        .tasks-groups {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .tasks-group {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          overflow: hidden;
          box-shadow: var(--shadow-sm);
        }
        .tasks-group__header {
          padding: 12px 16px;
          background-color: #f0eee7;
          border-bottom: 1px solid var(--border);
        }
        .tasks-group__title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .tasks-group__count {
          background-color: var(--accent-green);
          color: #fff;
          font-size: 11px;
          padding: 1px 8px;
          border-radius: var(--radius-pill);
          font-weight: 500;
        }
        .tasks-group__list {
          display: flex;
          flex-direction: column;
        }
        .task-edit {
          padding: 12px 16px;
          background-color: var(--bg);
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .task-edit__hint {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0;
        }
        .task-edit__input,
        .task-edit__select {
          padding: 8px 10px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          font-family: inherit;
          font-size: 13px;
          background-color: var(--surface);
        }
        .task-edit__input:focus,
        .task-edit__select:focus {
          outline: none;
          border-color: var(--accent-green);
        }
        .task-edit__actions {
          display: flex;
          gap: 6px;
        }
      `}</style>
    </div>
  );
}
