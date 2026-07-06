// src/renderer/pages/ProjectsPage.tsx
// 项目页（来自 spec.md "项目页"章节）
//
// 功能：
// - 项目卡片：项目名/最近进展/未完成任务数/决策数/最后活跃时间
// - 项目详情：项目主线/最近场景/任务/决策/人物/报告片段
// - 点击项目卡片查看详情
// - 操作：编辑项目名/纠错/删除（archive）
//
// 重要约束：
// - soft delete 优先（项目用 archive）
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../state/store";
import { CorrectionDialog } from "../components/CorrectionDialog";
import { NAMING, TASK_STATUS_LABELS } from "../app/naming";

export function ProjectsPage() {
  const isReady = useAppStore((s) => s.isReady);
  const todayData = useAppStore((s) => s.todayData);
  const todayLoading = useAppStore((s) => s.todayLoading);
  const todayError = useAppStore((s) => s.todayError);
  const loadToday = useAppStore((s) => s.loadToday);
  const loadProjectDetail = useAppStore((s) => s.loadProjectDetail);
  const projectDetail = useAppStore((s) => s.projectDetail);
  const projectDetailLoading = useAppStore((s) => s.projectDetailLoading);
  const projectDetailError = useAppStore((s) => s.projectDetailError);
  const clearProjectDetail = useAppStore((s) => s.clearProjectDetail);
  const deleteObject = useAppStore((s) => s.deleteObject);
  const updateTask = useAppStore((s) => s.updateTask);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<{
    targetType: "project" | "task" | "decision";
    targetId: string;
  } | null>(null);
  const [editingProjectName, setEditingProjectName] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // 进入页面时加载今日数据
  useEffect(() => {
    if (isReady && todayData.projects.length === 0) {
      void loadToday();
    }
  }, [isReady, loadToday, todayData.projects.length]);

  // 选中项目时加载详情
  useEffect(() => {
    if (selectedProjectId) {
      void loadProjectDetail(selectedProjectId);
    } else {
      clearProjectDetail();
    }
  }, [selectedProjectId, loadProjectDetail, clearProjectDetail]);

  // 构建项目卡片所需统计
  const projectStats = useMemo(() => {
    const stats = new Map<
      string,
      { openTaskCount: number; decisionCount: number; recentSummary: string }
    >();
    // 统计每个项目的未完成任务数和决策数
    for (const task of todayData.tasks) {
      if (task.deletedAt) continue;
      if (task.status === "done") continue;
      if (!task.projectId) continue;
      const s = stats.get(task.projectId) ?? {
        openTaskCount: 0,
        decisionCount: 0,
        recentSummary: "",
      };
      s.openTaskCount += 1;
      stats.set(task.projectId, s);
    }
    for (const decision of todayData.decisions) {
      if (decision.deletedAt) continue;
      if (!decision.projectId) continue;
      const s = stats.get(decision.projectId) ?? {
        openTaskCount: 0,
        decisionCount: 0,
        recentSummary: "",
      };
      s.decisionCount += 1;
      stats.set(decision.projectId, s);
    }
    // 最近进展：基于 facts 中 project_id == project.id 的最新一条
    for (const project of todayData.projects) {
      const s = stats.get(project.id) ?? {
        openTaskCount: 0,
        decisionCount: 0,
        recentSummary: "",
      };
      const projectFacts = todayData.facts
        .filter((f) => !f.deletedAt && f.projectId === project.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (projectFacts.length > 0) {
        s.recentSummary = projectFacts[0].content.slice(0, 100);
      } else if (project.summary) {
        s.recentSummary = project.summary.slice(0, 100);
      }
      stats.set(project.id, s);
    }
    return stats;
  }, [todayData.tasks, todayData.decisions, todayData.facts, todayData.projects]);

  // 操作处理
  const handleOpenDetail = (id: string) => {
    setSelectedProjectId(id);
  };

  const handleBackToList = () => {
    setSelectedProjectId(null);
  };

  const handleDeleteProject = async (id: string) => {
    if (!confirm("确定要归档删除这个项目吗？项目归档后仍保留 source 链路，可恢复。")) {
      return;
    }
    try {
      await deleteObject(id, "project");
      if (selectedProjectId === id) {
        setSelectedProjectId(null);
      }
    } catch (err) {
      console.error("删除项目失败:", err);
    }
  };

  const handleCompleteTask = async (id: string) => {
    try {
      await updateTask(id, { status: "done", completedAt: new Date().toISOString() });
      // 重新加载项目详情
      if (selectedProjectId) {
        void loadProjectDetail(selectedProjectId);
      }
    } catch (err) {
      console.error("标记任务完成失败:", err);
    }
  };

  const handleSubmitProjectName = async () => {
    if (!editingProjectName) return;
    try {
      // 通过 updateTask 不适用，project 编辑通过 createUserFeedback 触发 content_wrong
      // 这里直接调用 createUserFeedback
      const { createUserFeedback } = useAppStore.getState();
      await createUserFeedback({
        targetType: "project",
        targetId: editingProjectName.id,
        feedbackType: "content_wrong",
        patch: { name: editingProjectName.name.trim() },
      });
      // 重新加载
      await loadToday();
      if (selectedProjectId) {
        await loadProjectDetail(selectedProjectId);
      }
    } catch (err) {
      console.error("编辑项目名失败:", err);
    }
    setEditingProjectName(null);
  };

  if (!isReady) {
    return (
      <div className="projects-page">
        <header className="page-header">
          <h2>{NAMING.project}</h2>
        </header>
        <p className="state-loading">正在加载...</p>
      </div>
    );
  }

  // 详情视图
  if (selectedProjectId) {
    return (
      <div className="projects-page">
        <header className="page-header">
          <div className="page-header__row">
            <button
              className="page-header__back"
              onClick={handleBackToList}
              type="button"
            >
              返回项目列表
            </button>
            <h2>{projectDetail?.project.name ?? "项目详情"}</h2>
          </div>
          <p className="page-header__sub">
            项目主线、最近场景、任务、决策、人物和报告片段。
          </p>
        </header>

        {projectDetailError && (
          <div className="projects-page__error">
            <span>加载详情失败：{projectDetailError}</span>
            <button onClick={() => void loadProjectDetail(selectedProjectId)}>重试</button>
          </div>
        )}

        {projectDetailLoading && !projectDetail ? (
          <p className="state-loading">正在加载项目详情...</p>
        ) : !projectDetail ? (
          <div className="empty-state">
            <p>未找到项目详情。</p>
          </div>
        ) : (
          <div className="project-detail">
            {/* 项目主线 */}
            <section className="card project-detail__section">
              <div className="project-detail__section-header">
                <h3 className="card__title">项目主线</h3>
                <div className="project-detail__actions">
                  <button
                    type="button"
                    onClick={() =>
                      setEditingProjectName({
                        id: projectDetail.project.id,
                        name: projectDetail.project.name,
                      })
                    }
                  >
                    编辑名称
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setCorrectionTarget({
                        targetType: "project",
                        targetId: projectDetail.project.id,
                      })
                    }
                  >
                    纠错
                  </button>
                  <button
                    type="button"
                    className="project-detail__delete-btn"
                    onClick={() => void handleDeleteProject(projectDetail.project.id)}
                  >
                    归档
                  </button>
                </div>
              </div>
              <div className="card__body">
                <p className="project-detail__summary">{projectDetail.project.summary}</p>
                <div className="project-detail__meta">
                  <span>
                    最后活跃：
                    {projectDetail.project.lastActiveAt
                      ? new Date(projectDetail.project.lastActiveAt).toLocaleString("zh-CN")
                      : "未知"}
                  </span>
                  <span>状态：{projectDetail.project.status}</span>
                </div>
              </div>
            </section>

            {editingProjectName && (
              <div className="project-detail__edit-name">
                <p className="project-detail__edit-name-hint">编辑项目名称</p>
                <input
                  type="text"
                  className="project-detail__edit-input"
                  value={editingProjectName.name}
                  onChange={(e) =>
                    setEditingProjectName({ ...editingProjectName, name: e.target.value })
                  }
                  autoFocus
                />
                <div className="project-detail__edit-actions">
                  <button
                    className="primary"
                    onClick={handleSubmitProjectName}
                    disabled={!editingProjectName.name.trim()}
                  >
                    保存
                  </button>
                  <button onClick={() => setEditingProjectName(null)}>取消</button>
                </div>
              </div>
            )}

            {/* 最近场景 */}
            <section className="card project-detail__section">
              <h3 className="card__title">最近{NAMING.scene}</h3>
              <div className="card__body">
                {projectDetail.scenes.length === 0 ? (
                  <p className="project-detail__empty">没有{NAMING.scene}记录。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.scenes.map((scene) => (
                      <li key={scene.id} className="project-detail__list-item">
                        <div className="project-detail__list-title">{scene.title}</div>
                        <div className="project-detail__list-summary">{scene.summary}</div>
                        <div className="project-detail__list-meta">
                          {new Date(scene.startAt).toLocaleString("zh-CN")}
                          {scene.entityNames.length > 0 && (
                            <span>涉及：{scene.entityNames.join("、")}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 任务 */}
            <section className="card project-detail__section">
              <h3 className="card__title">
                {NAMING.task}
                <span className="project-detail__count">
                  {projectDetail.tasks.length}
                </span>
              </h3>
              <div className="card__body">
                {projectDetail.tasks.length === 0 ? (
                  <p className="project-detail__empty">没有任务。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.tasks.map((task) => (
                      <li key={task.id} className="project-detail__list-item">
                        <div className="project-detail__list-title">
                          {task.title}
                          <span
                            className="project-detail__status"
                            style={{
                              color:
                                task.status === "done" ? "#2f8f83" : "#66706d",
                            }}
                          >
                            {TASK_STATUS_LABELS[task.status] ?? task.status}
                          </span>
                          {(task.orphanStatus === "source_deleted" ||
                            task.orphanStatus === "needs_review") && (
                            <span
                              className="project-detail__orphan-chip"
                              title="该任务的来源已被删除，需复核"
                            >
                              来源失效
                            </span>
                          )}
                        </div>
                        {task.summary && (
                          <div className="project-detail__list-summary">{task.summary}</div>
                        )}
                        <div className="project-detail__list-actions">
                          {task.status !== "done" && (
                            <button
                              type="button"
                              onClick={() => void handleCompleteTask(task.id)}
                            >
                              标记完成
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setCorrectionTarget({
                                targetType: "task",
                                targetId: task.id,
                              })
                            }
                          >
                            纠错
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 决策 */}
            <section className="card project-detail__section">
              <h3 className="card__title">
                {NAMING.decision}
                <span className="project-detail__count">
                  {projectDetail.decisions.length}
                </span>
              </h3>
              <div className="card__body">
                {projectDetail.decisions.length === 0 ? (
                  <p className="project-detail__empty">没有决策记录。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.decisions.map((d) => (
                      <li key={d.id} className="project-detail__list-item">
                        <div className="project-detail__list-title">
                          {d.title}
                          {(d.orphanStatus === "source_deleted" ||
                            d.orphanStatus === "needs_review") && (
                            <span
                              className="project-detail__orphan-chip"
                              title="该决策的来源已被删除，需复核"
                            >
                              来源失效
                            </span>
                          )}
                        </div>
                        <div className="project-detail__list-summary">{d.decision}</div>
                        {d.rationale && (
                          <div className="project-detail__list-meta">
                            理由：{d.rationale}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 人物 */}
            <section className="card project-detail__section">
              <h3 className="card__title">{NAMING.person}</h3>
              <div className="card__body">
                {projectDetail.people.length === 0 ? (
                  <p className="project-detail__empty">没有相关人物。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.people.map((p) => (
                      <li key={p.id} className="project-detail__list-item">
                        <div className="project-detail__list-title">
                          {p.name}
                          {p.role && (
                            <span className="project-detail__role">{p.role}</span>
                          )}
                        </div>
                        {p.organization && (
                          <div className="project-detail__list-meta">
                            组织：{p.organization}
                          </div>
                        )}
                        {p.summary && (
                          <div className="project-detail__list-summary">{p.summary}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 报告片段 */}
            <section className="card project-detail__section">
              <h3 className="card__title">{NAMING.dailyReport}片段</h3>
              <div className="card__body">
                {projectDetail.recentReports.length === 0 ? (
                  <p className="project-detail__empty">没有相关报告。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.recentReports.map((r) => (
                      <li key={r.id} className="project-detail__list-item">
                        <div className="project-detail__list-title">
                          {r.title}
                          {r.isStale === 1 && (
                            <span
                              className="project-detail__orphan-chip"
                              title="该报告的部分来源已被删除，需重新生成"
                            >
                              需重新生成
                            </span>
                          )}
                        </div>
                        <div className="project-detail__list-meta">
                          {r.type === "daily" ? NAMING.dailyReport : NAMING.weeklyReport}
                          {r.dateKey}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        )}

        <CorrectionDialog
          open={correctionTarget !== null}
          targetType={correctionTarget?.targetType ?? "project"}
          targetId={correctionTarget?.targetId ?? ""}
          onClose={() => setCorrectionTarget(null)}
          onSubmitted={() => {
            void loadToday();
            if (selectedProjectId) {
              void loadProjectDetail(selectedProjectId);
            }
          }}
        />

        <style>{`
          .page-header__row {
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
          }
          .page-header__row h2 {
            margin: 0;
          }
          .page-header__back {
            font-size: 12px;
            padding: 4px 10px;
            background-color: transparent;
            border: 1px solid var(--border);
          }
          .projects-page__error {
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
          .project-detail {
            display: flex;
            flex-direction: column;
            gap: 16px;
          }
          .project-detail__section {
            padding: 16px 20px;
          }
          .project-detail__section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
            gap: 8px;
            flex-wrap: wrap;
          }
          .project-detail__actions {
            display: flex;
            gap: 4px;
            flex-wrap: wrap;
          }
          .project-detail__actions button {
            font-size: 11px;
            padding: 4px 8px;
          }
          .project-detail__delete-btn {
            color: var(--danger) !important;
            border-color: var(--danger) !important;
          }
          .project-detail__summary {
            color: var(--text-primary);
            line-height: 1.7;
            margin: 0 0 8px 0;
          }
          .project-detail__meta {
            display: flex;
            gap: 16px;
            font-size: 12px;
            color: var(--text-secondary);
            flex-wrap: wrap;
          }
          .project-detail__count {
            background-color: var(--accent-green);
            color: #fff;
            font-size: 11px;
            padding: 1px 8px;
            border-radius: var(--radius-pill);
            font-weight: 500;
            margin-left: 6px;
          }
          .project-detail__list {
            list-style: none;
            margin: 0;
            padding: 0;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .project-detail__list-item {
            padding: 10px 12px;
            background-color: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-button);
          }
          .project-detail__list-title {
            font-size: 13px;
            font-weight: 500;
            color: var(--text-primary);
            margin-bottom: 4px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
          }
          .project-detail__list-summary {
            font-size: 12px;
            color: var(--text-secondary);
            line-height: 1.6;
            margin-bottom: 4px;
          }
          .project-detail__list-meta {
            font-size: 11px;
            color: var(--text-secondary);
            display: flex;
            gap: 12px;
            flex-wrap: wrap;
          }
          .project-detail__list-actions {
            display: flex;
            gap: 4px;
            margin-top: 6px;
          }
          .project-detail__list-actions button {
            font-size: 11px;
            padding: 2px 8px;
          }
          .project-detail__status {
            font-size: 11px;
            font-weight: 500;
          }
          .project-detail__orphan-chip {
            display: inline-block;
            padding: 2px 8px;
            background-color: rgba(217, 145, 43, 0.12);
            border: 1px solid #d9912b;
            border-radius: var(--radius-pill);
            font-size: 11px;
            color: #d9912b;
            font-weight: 500;
          }
          .project-detail__role {
            font-size: 11px;
            color: var(--text-secondary);
            background-color: var(--bg);
            padding: 1px 6px;
            border-radius: var(--radius-pill);
          }
          .project-detail__empty {
            font-size: 12px;
            color: var(--text-secondary);
            margin: 0;
            font-style: italic;
          }
          .project-detail__edit-name {
            padding: 12px 20px;
            background-color: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-card);
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .project-detail__edit-name-hint {
            font-size: 12px;
            color: var(--text-secondary);
            margin: 0;
          }
          .project-detail__edit-input {
            padding: 8px 10px;
            border: 1px solid var(--border);
            border-radius: var(--radius-button);
            font-family: inherit;
            font-size: 13px;
          }
          .project-detail__edit-input:focus {
            outline: none;
            border-color: var(--accent-green);
          }
          .project-detail__edit-actions {
            display: flex;
            gap: 6px;
          }
        `}</style>
      </div>
    );
  }

  // 列表视图
  return (
    <div className="projects-page">
      <header className="page-header">
        <h2>{NAMING.project}</h2>
        <p className="page-header__sub">
          Recall 会从工作上下文中识别并归类项目进展。
        </p>
      </header>

      {todayError && (
        <div className="projects-page__error">
          <span>加载失败：{todayError}</span>
          <button onClick={() => void loadToday()}>重试</button>
        </div>
      )}

      {todayLoading && todayData.projects.length === 0 ? (
        <p className="state-loading">正在加载项目...</p>
      ) : todayData.projects.length === 0 ? (
        <div className="empty-state">
          <p>当前没有项目。</p>
          <p className="empty-state__hint">
            持续观察后，Recall 会把同一主题的工作归纳为项目。
          </p>
        </div>
      ) : (
        <div className="projects-grid">
          {todayData.projects.map((project) => {
            const stat = projectStats.get(project.id) ?? {
              openTaskCount: 0,
              decisionCount: 0,
              recentSummary: "",
            };
            return (
              <div
                key={project.id}
                className="project-card"
                onClick={() => handleOpenDetail(project.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleOpenDetail(project.id);
                  }
                }}
              >
                <div className="project-card__header">
                  <h3 className="project-card__name">{project.name}</h3>
                  <span className="project-card__status">{project.status}</span>
                </div>
                <div className="project-card__summary">
                  {stat.recentSummary || project.summary || "暂无最近进展"}
                </div>
                <div className="project-card__meta">
                  <span className="project-card__stat">
                    {NAMING.task}：{stat.openTaskCount} 项未完成
                  </span>
                  <span className="project-card__stat">
                    {NAMING.decision}：{stat.decisionCount} 项
                  </span>
                  <span className="project-card__time">
                    最后活跃：
                    {project.lastActiveAt
                      ? new Date(project.lastActiveAt).toLocaleString("zh-CN")
                      : "未知"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        .projects-page__error {
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
        .projects-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 12px;
        }
        .project-card {
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 14px 16px;
          cursor: pointer;
          transition: border-color 0.12s ease, box-shadow 0.12s ease;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .project-card:hover {
          border-color: var(--accent-green);
          box-shadow: var(--shadow-md);
        }
        .project-card__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 8px;
        }
        .project-card__name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
          flex: 1;
        }
        .project-card__status {
          font-size: 10px;
          color: var(--text-secondary);
          background-color: var(--bg);
          padding: 2px 6px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--border);
        }
        .project-card__summary {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.6;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .project-card__meta {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: var(--text-secondary);
          flex-wrap: wrap;
          border-top: 1px solid var(--border);
          padding-top: 8px;
        }
        .project-card__stat {
          font-weight: 500;
        }
        .project-card__time {
          opacity: 0.7;
        }
      `}</style>
    </div>
  );
}
