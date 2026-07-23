// src/renderer/pages/ProjectsPage.tsx
// 项目页（Phase 6 重构，来自 spec.md "项目页"章节）
//
// 功能：
// - 项目列表卡片：项目名 / 最近进展摘要 / 未收尾数量 / 最近活跃时间 / 今日/本周标签
// - 操作：查看项目 / 生成项目报告 / 归档
// - 项目详情：项目标题 / 项目概览 / 最近时间轴 / 待收尾 / 关键决策 / 相关资料 / 相关人物 / 报告
// - 项目报告结构：项目当前状态 / 近期进展 / 关键决策 / 未收尾事项 / 风险 / 下一步建议
//
// 重要约束：
// - soft delete 优先（项目用 archive）
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语
// - 不显示 source ids

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";
import { CorrectionDialog } from "../components/CorrectionDialog";
import { MergeDialog } from "../components/MergeDialog";
import { NAMING, TASK_STATUS_LABELS } from "../app/naming";
import type { ProjectDetail, ProjectItem } from "../state/store";

/**
 * 判断时间是否在今天
 */
function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

/**
 * 判断时间是否在本周（含今天）
 */
function isThisWeek(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const diff = now.getTime() - d.getTime();
  // 7 天内算本周
  return diff >= 0 && diff <= 7 * oneDay;
}

function admissionReasonLabel(reason?: string | null): string {
  const labels: Record<string, string> = {
    project_without_exact_hint: "缺少明确的项目名称证据",
    project_needs_independent_episode: "目前只在一次独立活动中出现",
    source_author_or_list_only: "仅出现在资料名单或示例中",
    user_reject: "已由你排除",
  };
  return reason ? labels[reason] ?? "需要确认是否作为长期项目" : "需要确认是否作为长期项目";
}

/**
 * 根据项目详情生成项目报告（结构化展示，非 LLM 生成）
 * 报告结构来自 spec 行 2183-2195：
 * - 项目当前状态
 * - 近期进展
 * - 关键决策
 * - 未收尾事项
 * - 风险
 * - 下一步建议
 */
function buildProjectReport(detail: ProjectDetail): {
  status: string;
  recentProgress: string[];
  keyDecisions: string[];
  unfinished: string[];
  risks: string[];
  nextSteps: string[];
} {
  const openTasks = detail.tasks.filter((t) => t.status !== "done");
  const dedicatedThreads = (detail.unfinishedThreads ?? []).filter((t) => t.status === "open");
  const unfinishedTitles = dedicatedThreads.length > 0
    ? dedicatedThreads.map((thread) => thread.title)
    : openTasks.map((task) => task.title);
  const recentScenes = detail.scenes.slice(0, 3);

  return {
    status: detail.project.status === "active" ? "进行中" : detail.project.status,
    recentProgress: recentScenes.length
      ? recentScenes.map((s) => s.summary || s.title)
      : detail.project.summary
        ? [detail.project.summary]
        : ["暂无近期进展记录"],
    keyDecisions: detail.decisions.length
      ? detail.decisions.map((d) => `${d.title}：${d.decision}`)
      : ["暂无关键决策记录"],
    unfinished: unfinishedTitles.length
      ? unfinishedTitles
      : ["暂无未收尾事项"],
    risks: unfinishedTitles.length
      ? [`有 ${unfinishedTitles.length} 项未收尾事项，建议关注进展`]
      : ["暂无明显风险"],
    nextSteps: dedicatedThreads.length
      ? dedicatedThreads.slice(0, 3).map((thread) => thread.suggestedNextAction || thread.title)
      : openTasks.length
        ? openTasks.slice(0, 3).map((t) => t.title)
      : ["可继续推进项目相关工作"],
  };
}

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
  const unfinishedThreads = useAppStore((s) => s.unfinishedThreads);
  const loadUnfinishedThreads = useAppStore((s) => s.loadUnfinishedThreads);
  const projectsFilters = useAppStore((s) => s.projectsFilters);
  const setProjectsFilters = useAppStore((s) => s.setProjectsFilters);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // 012 新增：合并对话框状态
  const [mergeFrom, setMergeFrom] = useState<{ id: string; name: string } | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<{
    targetType: "project" | "task" | "decision";
    targetId: string;
  } | null>(null);
  const [reportExpanded, setReportExpanded] = useState(false);
  const [supplementalProjects, setSupplementalProjects] = useState<ProjectItem[]>([]);
  const [supplementalLoading, setSupplementalLoading] = useState(false);
  const [supplementalError, setSupplementalError] = useState<string | null>(null);
  const [reviewingProjectId, setReviewingProjectId] = useState<string | null>(null);
  const [supplementalRevision, setSupplementalRevision] = useState(0);

  const selectedProjectThreads = useMemo(() => {
    if (!projectDetail) return [];
    return unfinishedThreads.filter(
      (thread) => thread.status === "open" && thread.projectName === projectDetail.project.name
    );
  }, [projectDetail, unfinishedThreads]);

  const projectUnfinishedItems = useMemo(() => {
    if (!projectDetail) return [];
    if (selectedProjectThreads.length > 0) {
      return selectedProjectThreads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        summary: thread.suggestedNextAction || thread.reason,
        task: null,
      }));
    }
    return projectDetail.tasks
      .filter((task) => task.status !== "done")
      .map((task) => ({ id: task.id, title: task.title, summary: task.summary, task }));
  }, [projectDetail, selectedProjectThreads]);

  // 进入页面时加载今日数据
  useEffect(() => {
    if (isReady && todayData.projects.length === 0) {
      void loadToday();
    }
  }, [isReady, loadToday, todayData.projects.length]);

  useEffect(() => {
    if (isReady) void loadUnfinishedThreads();
  }, [isReady, loadUnfinishedThreads]);

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
    for (const project of todayData.projects) {
      const s = stats.get(project.id) ?? {
        openTaskCount: 0,
        decisionCount: 0,
        recentSummary: "",
      };
      if (project.summary) {
        s.recentSummary = project.summary.slice(0, 100);
      }
      stats.set(project.id, s);
    }
    return stats;
  }, [todayData.tasks, todayData.decisions, todayData.projects]);

  // 待确认和归档对象不进入普通 Today 投影，按当前视图单独读取。
  useEffect(() => {
    if (projectsFilters.status === "active") {
      setSupplementalProjects([]);
      setSupplementalError(null);
      return;
    }
    let cancelled = false;
    setSupplementalLoading(true);
    setSupplementalError(null);
    const input = projectsFilters.status === "candidate"
      ? { admissionStatus: "candidate" as const }
      : { includeArchived: true, includeNonPromoted: true };
    void getIpc().memory.listProjects<ProjectItem>(input)
      .then((res) => {
        if (cancelled) return;
        setSupplementalProjects(projectsFilters.status === "archived"
          ? res.projects.filter((project) => project.archivedAt || project.admissionStatus === "rejected")
          : res.projects);
      })
      .catch((err) => {
        if (cancelled) return;
        setSupplementalError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSupplementalLoading(false);
      });
    return () => { cancelled = true; };
  }, [projectsFilters.status, supplementalRevision]);

  // 客户端过滤 + 排序
  const filteredProjects = useMemo(() => {
    let list: ProjectItem[];
    if (projectsFilters.status === "active") {
      list = todayData.projects.filter((p) => !p.archivedAt);
    } else {
      list = supplementalProjects;
    }

    const kw = projectsFilters.keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((p) =>
        p.name.toLowerCase().includes(kw) ||
        p.summary.toLowerCase().includes(kw) ||
        (p.aliases ?? []).some((a) => a.toLowerCase().includes(kw))
      );
    }

    const sortBy = projectsFilters.sortBy;
    list = [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN");
      const aVal = a[sortBy] ?? "";
      const bVal = b[sortBy] ?? "";
      return bVal.localeCompare(aVal); // 降序
    });
    return list;
  }, [todayData.projects, supplementalProjects, projectsFilters]);

  const handleReviewProject = async (
    id: string,
    decision: "promote" | "reject" | "restore"
  ) => {
    setReviewingProjectId(id);
    setSupplementalError(null);
    try {
      await getIpc().memory.reviewAdmission({ objectType: "project", id, decision });
      setSupplementalRevision((revision) => revision + 1);
      await loadToday();
    } catch (error) {
      setSupplementalError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewingProjectId(null);
    }
  };

  const handleOpenDetail = (id: string) => {
    setSelectedProjectId(id);
  };

  const handleBackToList = () => {
    setSelectedProjectId(null);
    setReportExpanded(false);
  };

  const handleDeleteProject = (id: string) => {
    useAppStore.getState().requestConfirm({
      title: "归档项目",
      message: "确定要归档这个项目吗？项目归档后仍保留 source 链路，可恢复。",
      confirmText: "确认",
      onConfirm: async () => {
        try {
          await deleteObject(id, "project");
          if (selectedProjectId === id) {
            setSelectedProjectId(null);
          }
        } catch (err) {
          console.error("归档项目失败:", err);
        }
      },
    });
  };

  const handleCompleteTask = async (id: string) => {
    try {
      await updateTask(id, { status: "done", completedAt: new Date().toISOString() });
      if (selectedProjectId) {
        void loadProjectDetail(selectedProjectId);
      }
    } catch (err) {
      console.error("标记任务完成失败:", err);
    }
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
          <div className="projects-page__header-row">
            <button
              className="projects-page__back-btn"
              onClick={handleBackToList}
              type="button"
            >
              返回项目列表
            </button>
            <h2>{projectDetail?.project.name ?? "项目详情"}</h2>
          </div>
          <p className="page-header__sub">
            项目主线、最近时间轴、待收尾、关键决策、相关资料和人物。
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
            {/* 项目概览 */}
            <section className="card project-detail__section">
              <div className="project-detail__section-header">
                <h3 className="card__title">项目概览</h3>
                <div className="project-detail__actions">
                  <button
                    type="button"
                    onClick={() => setReportExpanded((v) => !v)}
                  >
                    {reportExpanded ? "收起报告" : "展开报告"}
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

            {/* 项目报告（折叠展开） */}
            <section className="card project-detail__section project-detail__section--collapsible">
              <div className="project-detail__section-header">
                <h3 className="card__title">项目报告</h3>
                <div className="project-detail__actions">
                  <button
                    type="button"
                    onClick={() => setReportExpanded((v) => !v)}
                  >
                    {reportExpanded ? "收起报告" : "展开报告"}
                  </button>
                </div>
              </div>
              {reportExpanded && (() => {
                const report = buildProjectReport({
                  ...projectDetail,
                  unfinishedThreads: selectedProjectThreads,
                });
                return (
                  <div className="card__body project-report">
                    <section className="project-report__section-inner">
                      <h4>项目当前状态</h4>
                      <p className="project-report__status">{report.status}</p>
                      {projectDetail.project.summary && (
                        <p className="project-report__summary">{projectDetail.project.summary}</p>
                      )}
                    </section>

                    <section className="project-report__section-inner">
                      <h4>近期进展</h4>
                      <ul className="project-report__list">
                        {report.recentProgress.map((item, idx) => (
                          <li key={`progress-${idx}`} className="project-report__list-item">{item}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="project-report__section-inner">
                      <h4>关键决策</h4>
                      <ul className="project-report__list">
                        {report.keyDecisions.map((item, idx) => (
                          <li key={`decision-${idx}`} className="project-report__list-item">{item}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="project-report__section-inner">
                      <h4>未收尾事项</h4>
                      <ul className="project-report__list">
                        {report.unfinished.map((item, idx) => (
                          <li key={`unfinished-${idx}`} className="project-report__list-item">{item}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="project-report__section-inner">
                      <h4>风险</h4>
                      <ul className="project-report__list">
                        {report.risks.map((item, idx) => (
                          <li key={`risk-${idx}`} className="project-report__list-item">{item}</li>
                        ))}
                      </ul>
                    </section>

                    <section className="project-report__section-inner">
                      <h4>下一步建议</h4>
                      <ul className="project-report__list">
                        {report.nextSteps.map((item, idx) => (
                          <li key={`next-${idx}`} className="project-report__list-item">{item}</li>
                        ))}
                      </ul>
                    </section>
                  </div>
                );
              })()}
            </section>

            {/* 最近时间轴 */}
            <section className="card project-detail__section">
              <h3 className="card__title">最近时间轴</h3>
              <div className="card__body">
                {projectDetail.scenes.length === 0 ? (
                  <p className="project-detail__empty">暂无最近活动记录。</p>
                ) : (
                  <ul className="project-detail__timeline">
                    {projectDetail.scenes.map((scene) => (
                      <li key={scene.id} className="project-detail__timeline-item">
                        <div className="project-detail__timeline-time">
                          {new Date(scene.startAt).toLocaleString("zh-CN")}
                        </div>
                        <div className="project-detail__timeline-content">
                          <div className="project-detail__timeline-title">{scene.title}</div>
                          {scene.summary && (
                            <div className="project-detail__timeline-summary">{scene.summary}</div>
                          )}
                          {scene.entityNames.length > 0 && (
                            <div className="project-detail__timeline-meta">
                              涉及：{scene.entityNames.join("、")}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 待收尾 */}
            <section className="card project-detail__section">
              <h3 className="card__title">
                待收尾
                <span className="project-detail__count">
                  {projectUnfinishedItems.length}
                </span>
              </h3>
              <div className="card__body">
                {projectUnfinishedItems.length === 0 ? (
                  <p className="project-detail__empty">没有待收尾事项。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectUnfinishedItems.map((item) => (
                        <li key={item.id} className="project-detail__list-item">
                          <div className="project-detail__list-title">
                            {item.title}
                            {item.task && (
                              <span className="project-detail__status">
                                {TASK_STATUS_LABELS[item.task.status] ?? item.task.status}
                              </span>
                            )}
                          </div>
                          {item.summary && (
                            <div className="project-detail__list-summary">{item.summary}</div>
                          )}
                          {item.task && <div className="project-detail__list-actions">
                            <button
                              type="button"
                              onClick={() => void handleCompleteTask(item.task!.id)}
                            >
                              标记完成
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setCorrectionTarget({
                                  targetType: "task",
                                  targetId: item.task!.id,
                                })
                              }
                            >
                              纠错
                            </button>
                          </div>}
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 关键决策 */}
            <section className="card project-detail__section">
              <h3 className="card__title">
                关键决策
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
                        <div className="project-detail__list-title">{d.title}</div>
                        <div className="project-detail__list-summary">{d.decision}</div>
                        {d.rationale && (
                          <div className="project-detail__list-meta">理由：{d.rationale}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 相关资料 */}
            <section className="card project-detail__section">
              <h3 className="card__title">
                相关资料
                <span className="project-detail__count">
                  {projectDetail.facts.length}
                </span>
              </h3>
              <div className="card__body">
                {projectDetail.facts.length === 0 ? (
                  <p className="project-detail__empty">没有相关资料。</p>
                ) : (
                  <ul className="project-detail__list">
                    {projectDetail.facts.slice(0, 10).map((f) => (
                      <li key={f.id} className="project-detail__list-item">
                        <div className="project-detail__list-summary">{f.content}</div>
                        <div className="project-detail__list-meta">
                          {new Date(f.createdAt).toLocaleString("zh-CN")}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* 相关人物 */}
            <section className="card project-detail__section">
              <h3 className="card__title">相关人物</h3>
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
                          <div className="project-detail__list-meta">组织：{p.organization}</div>
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

            {/* 报告 */}
            <section className="card project-detail__section">
              <h3 className="card__title">报告</h3>
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
                            <span className="project-detail__stale-chip">需重新生成</span>
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
                <button
                  type="button"
                  className="project-detail__report-btn"
                  onClick={() => setReportExpanded(true)}
                >
                  生成项目报告
                </button>
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
      </div>
    );
  }

  // 列表视图
  return (
    <div className="projects-page">
      <header className="page-header">
        <h2>{NAMING.project}</h2>
        <p className="page-header__sub">
          查看项目进展、待收尾事项和相关决策。Recall 会从工作上下文中识别并归类项目。
        </p>
      </header>

      {todayError && (
        <div className="projects-page__error">
          <span>加载失败：{todayError}</span>
          <button onClick={() => void loadToday()}>重试</button>
        </div>
      )}

      {supplementalError && (
        <div className="projects-page__error">
          <span>加载失败：{supplementalError}</span>
          <button onClick={() => setSupplementalRevision((revision) => revision + 1)}>重试</button>
        </div>
      )}

      {/* 筛选栏 */}
      <div className="memory-filters">
        <div className="memory-filters__group">
          <label className="memory-filters__label">搜索</label>
          <input
            type="text"
            className="memory-filters__input"
            placeholder="项目名 / 摘要 / 别名"
            value={projectsFilters.keyword}
            onChange={(e) => setProjectsFilters({ keyword: e.target.value })}
          />
        </div>
        <div className="memory-filters__group">
          <label className="memory-filters__label">状态</label>
          <select
            className="memory-filters__select"
            value={projectsFilters.status}
            onChange={(e) => setProjectsFilters({
              status: e.target.value as "active" | "candidate" | "archived",
            })}
          >
            <option value="active">活跃</option>
            <option value="candidate">待确认</option>
            <option value="archived">已归档</option>
          </select>
        </div>
        <div className="memory-filters__group">
          <label className="memory-filters__label">排序</label>
          <select
            className="memory-filters__select"
            value={projectsFilters.sortBy}
            onChange={(e) => setProjectsFilters({ sortBy: e.target.value as "lastActiveAt" | "createdAt" | "name" })}
          >
            <option value="lastActiveAt">最后活跃</option>
            <option value="createdAt">创建时间</option>
            <option value="name">名称</option>
          </select>
        </div>
      </div>

      {(projectsFilters.status === "active" ? todayLoading : supplementalLoading)
        && filteredProjects.length === 0 ? (
        <p className="state-loading">正在加载项目...</p>
      ) : filteredProjects.length === 0 ? (
        <div className="empty-state">
          <p>{projectsFilters.status === "candidate"
            ? "当前没有待确认的项目。"
            : projectsFilters.status === "archived"
              ? "当前没有已归档的项目。"
              : "当前没有符合筛选条件的项目。"}</p>
          <p className="empty-state__hint">
            {projectsFilters.status === "active"
              ? "调整搜索关键词或筛选条件，或持续观察让 Recall 归纳更多项目。"
              : "这里的对象不会进入日常项目列表，直到你确认或恢复。"}
          </p>
        </div>
      ) : (
        <div className="projects-grid">
          {filteredProjects.map((project) => {
            const stat = projectStats.get(project.id) ?? {
              openTaskCount: 0,
              decisionCount: 0,
              recentSummary: "",
            };
            const today = isToday(project.lastActiveAt);
            const thisWeek = isThisWeek(project.lastActiveAt);
            return (
              <div
                key={project.id}
                className="project-card"
                onClick={() => projectsFilters.status === "active" && handleOpenDetail(project.id)}
                role={projectsFilters.status === "active" ? "button" : undefined}
                tabIndex={projectsFilters.status === "active" ? 0 : undefined}
                onKeyDown={(e) => {
                  if (projectsFilters.status === "active" && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    handleOpenDetail(project.id);
                  }
                }}
              >
                <div className="project-card__header">
                  <h3 className="project-card__name">{project.name}</h3>
                  <div className="project-card__tags">
                    {projectsFilters.status === "candidate" && (
                      <span className="project-card__tag admission-card__status">待确认</span>
                    )}
                    {projectsFilters.status === "archived" && (
                      <span className="project-card__tag admission-card__status">已归档</span>
                    )}
                    {projectsFilters.status === "active" && today && (
                      <span className="project-card__tag project-card__tag--today">今日</span>
                    )}
                    {projectsFilters.status === "active" && !today && thisWeek && (
                      <span className="project-card__tag project-card__tag--week">本周</span>
                    )}
                  </div>
                </div>
                {project.aliases && project.aliases.length > 0 && (
                  <div className="project-card__aliases" title="已合并过的旧名字">
                    别名：{project.aliases.join("、")}
                  </div>
                )}
                <div className="project-card__summary">
                  {stat.recentSummary || project.summary || "暂无最近进展"}
                </div>
                {projectsFilters.status !== "active" && (
                  <div className="admission-card__reason">
                    {admissionReasonLabel(project.admissionReason)}
                  </div>
                )}
                <div className="project-card__meta">
                  {projectsFilters.status === "active" ? (
                    <span className="project-card__stat">待收尾：{stat.openTaskCount} 项</span>
                  ) : (
                    <span className="project-card__stat">
                      相关证据：{project.admissionEvidence?.length ?? project.sourceFactIds.length} 条
                    </span>
                  )}
                  <span className="project-card__time">
                    最后活跃：
                    {project.lastActiveAt
                      ? new Date(project.lastActiveAt).toLocaleDateString("zh-CN")
                      : "未知"}
                  </span>
                </div>
                <div className="project-card__actions">
                  {projectsFilters.status === "active" && <><button
                    type="button"
                    className="project-card__action project-card__action--primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleOpenDetail(project.id);
                    }}
                  >
                    查看项目
                  </button>
                  <button
                    type="button"
                    className="project-card__action"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedProjectId(project.id);
                      void loadProjectDetail(project.id).then(() => {
                        setReportExpanded(true);
                      });
                    }}
                  >
                    生成项目报告
                  </button>
                  <button
                    type="button"
                    className="project-card__action project-card__action--merge"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMergeFrom({ id: project.id, name: project.name });
                    }}
                    title="把此项目合并到其他项目（同一项目但识别成多个名字时）"
                  >
                    合并到...
                  </button>
                  <button
                    type="button"
                    className="project-card__action project-card__action--danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteProject(project.id);
                    }}
                  >
                    归档
                  </button>
                  </>}
                  {projectsFilters.status === "candidate" && <>
                    <button
                      type="button"
                      className="project-card__action project-card__action--primary"
                      disabled={reviewingProjectId === project.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleReviewProject(project.id, "promote");
                      }}
                    >
                      确认为项目
                    </button>
                    <button
                      type="button"
                      className="project-card__action project-card__action--danger"
                      disabled={reviewingProjectId === project.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleReviewProject(project.id, "reject");
                      }}
                    >
                      排除
                    </button>
                  </>}
                  {projectsFilters.status === "archived" && (
                    <button
                      type="button"
                      className="project-card__action project-card__action--primary"
                      disabled={reviewingProjectId === project.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleReviewProject(project.id, "restore");
                      }}
                    >
                      恢复项目
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mergeFrom && (
        <MergeDialog
          open={true}
          objectType="project"
          fromId={mergeFrom.id}
          fromName={mergeFrom.name}
          onClose={() => setMergeFrom(null)}
          onMerged={() => {
            setMergeFrom(null);
            void loadToday();
          }}
        />
      )}
    </div>
  );
}
