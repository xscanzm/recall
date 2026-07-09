// src/renderer/pages/PeoplePage.tsx
// 人物页（Phase 6 新增，来自 spec.md "人物页"章节）
//
// 人物列表（spec 行 2258-2266）：
// - 姓名 / 角色组织 / 相关项目 / 最近互动时间 / 未收尾承诺数
//
// 人物详情（spec 行 2267-2279）：
// - 人物概览 / 相关项目 / 最近互动 / 我答应过的事 / 对方提到的需求/意见 / 相关资料
//
// 隐私文案（spec 行 2280-2287）：
// - 不出现"监控"/"追踪"/"行为分析"
// - 使用"相关记忆"/"最近协作"/"提到过的事"
//
// 重要约束：
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语
// - 不显示 source ids
// - 人物页是用户自己的关系记忆，不是监控别人

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../state/store";
import type { PersonItem, ProjectItem, SceneItem, TaskItem, FactItem } from "../state/store";
import { getIpc } from "../state/ipc";
import { CorrectionDialog } from "../components/CorrectionDialog";
import { MergeDialog } from "../components/MergeDialog";

/**
 * 派生：人物相关项目（来自 todayData.projects，按 relatedProjectIds 匹配）
 */
function getRelatedProjects(person: PersonItem, projects: ProjectItem[]): ProjectItem[] {
  return projects.filter((p) => person.relatedProjectIds.includes(p.id));
}

/**
 * 派生：人物相关任务（任务 sourceFactIds 与人物 sourceFactIds 有交集）
 */
function getRelatedTasks(person: PersonItem, tasks: TaskItem[]): TaskItem[] {
  const personFactIdSet = new Set(person.sourceFactIds);
  return tasks
    .filter((t) => !t.deletedAt)
    .filter((t) => t.sourceFactIds.some((fid) => personFactIdSet.has(fid)));
}

/**
 * 派生：未收尾承诺数（相关任务中状态非 done 的数量）
 */
function getUnfinishedPromiseCount(person: PersonItem, tasks: TaskItem[]): number {
  return getRelatedTasks(person, tasks).filter((t) => t.status !== "done").length;
}

interface PersonDetailData {
  person: PersonItem;
  relatedProjects: ProjectItem[];
  relatedScenes: SceneItem[];
  relatedTasks: TaskItem[];
  relatedFacts: FactItem[];
}

export function PeoplePage() {
  const isReady = useAppStore((s) => s.isReady);
  const todayData = useAppStore((s) => s.todayData);
  const todayLoading = useAppStore((s) => s.todayLoading);
  const todayError = useAppStore((s) => s.todayError);
  const loadToday = useAppStore((s) => s.loadToday);

  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonDetailData | null>(null);
  const [personDetailLoading, setPersonDetailLoading] = useState(false);
  const [personDetailError, setPersonDetailError] = useState<string | null>(null);
  const [personDetailReloadKey, setPersonDetailReloadKey] = useState(0);
  // 012 新增：合并对话框状态
  const [mergeFrom, setMergeFrom] = useState<{ id: string; name: string } | null>(null);

  // 进入页面时加载今日数据
  useEffect(() => {
    if (isReady && todayData.people.length === 0) {
      void loadToday();
    }
  }, [isReady, loadToday, todayData.people.length]);

  useEffect(() => {
    if (!selectedPersonId) {
      setPersonDetail(null);
      setPersonDetailLoading(false);
      setPersonDetailError(null);
      return;
    }

    let cancelled = false;
    setPersonDetailLoading(true);
    setPersonDetailError(null);

    void getIpc().memory.getPersonDetail({ id: selectedPersonId })
      .then((detail) => {
        if (cancelled) return;
        setPersonDetail(detail as PersonDetailData);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPersonDetail(null);
        setPersonDetailError(message);
      })
      .finally(() => {
        if (!cancelled) setPersonDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPersonId, personDetailReloadKey]);

  // 选中的人物
  const selectedPerson = useMemo(() => {
    if (!selectedPersonId) return null;
    return personDetail?.person ?? todayData.people.find((p) => p.id === selectedPersonId) ?? null;
  }, [selectedPersonId, personDetail, todayData.people]);

  // 详情派生数据
  const detailData = useMemo(() => {
    if (!personDetail) return null;
    return {
      relatedProjects: personDetail.relatedProjects,
      relatedScenes: personDetail.relatedScenes,
      relatedTasks: personDetail.relatedTasks,
      relatedFacts: personDetail.relatedFacts,
      unfinishedPromises: personDetail.relatedTasks.filter(
        (t) => t.status !== "done"
      ),
    };
  }, [personDetail]);

  // 列表派生数据（每个人物的统计）
  const peopleStats = useMemo(() => {
    const stats = new Map<
      string,
      { latestInteraction: string | null; unfinishedCount: number; projectNames: string[] }
    >();
    for (const person of todayData.people) {
      stats.set(person.id, {
        latestInteraction: person.updatedAt,
        unfinishedCount: getUnfinishedPromiseCount(person, todayData.tasks),
        projectNames: getRelatedProjects(person, todayData.projects).map((p) => p.name),
      });
    }
    return stats;
  }, [todayData.people, todayData.tasks, todayData.projects]);

  if (!isReady) {
    return (
      <div className="people-page">
        <header className="page-header">
          <h2>人物</h2>
        </header>
        <p className="state-loading">正在加载...</p>
      </div>
    );
  }

  // 详情视图
  if (selectedPersonId) {
    const person = selectedPerson;
    return (
      <div className="people-page">
        <header className="page-header">
          <div className="people-page__header-row">
            <button
              className="people-page__back-btn"
              onClick={() => setSelectedPersonId(null)}
              type="button"
            >
              返回人物列表
            </button>
            <h2>{person?.name ?? "人物详情"}</h2>
          </div>
          <p className="page-header__sub">
            相关记忆、最近协作和提到过的事。
          </p>
        </header>

        {personDetailLoading && (
          <p className="state-loading">正在加载人物记忆...</p>
        )}

        {personDetailError && (
          <div className="people-page__error">
            <span>加载失败：{personDetailError}</span>
            <button onClick={() => setPersonDetailReloadKey((key) => key + 1)}>重试</button>
          </div>
        )}

        {!personDetailLoading && !personDetailError && (!person || !detailData) && (
          <div className="empty-state">
            <p>没有找到这个人物的详细记忆。</p>
          </div>
        )}

        {person && detailData && (

        <div className="person-detail">
          {/* 人物概览 */}
          <section className="card person-detail__section">
            <h3 className="card__title">人物概览</h3>
            <div className="card__body">
              <p className="person-detail__summary">
                {person.summary || "暂无概览信息。"}
              </p>
              <div className="person-detail__meta">
                {person.role && <span>角色：{person.role}</span>}
                {person.organization && <span>组织：{person.organization}</span>}
              </div>
            </div>
          </section>

          {/* 相关项目 */}
          <section className="card person-detail__section">
            <h3 className="card__title">
              相关项目
              <span className="person-detail__count">
                {detailData.relatedProjects.length}
              </span>
            </h3>
            <div className="card__body">
              {detailData.relatedProjects.length === 0 ? (
                <p className="person-detail__empty">暂无相关项目。</p>
              ) : (
                <ul className="person-detail__list">
                  {detailData.relatedProjects.map((p) => (
                    <li key={p.id} className="person-detail__list-item">
                      <div className="person-detail__list-title">{p.name}</div>
                      {p.summary && (
                        <div className="person-detail__list-summary">{p.summary}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 最近互动 */}
          <section className="card person-detail__section">
            <h3 className="card__title">
              最近协作
              <span className="person-detail__count">
                {detailData.relatedScenes.length}
              </span>
            </h3>
            <div className="card__body">
              {detailData.relatedScenes.length === 0 ? (
                <p className="person-detail__empty">暂无最近协作记录。</p>
              ) : (
                <ul className="person-detail__timeline">
                  {detailData.relatedScenes.slice(0, 8).map((scene) => (
                    <li key={scene.id} className="person-detail__timeline-item">
                      <div className="person-detail__timeline-time">
                        {new Date(scene.startAt).toLocaleString("zh-CN")}
                      </div>
                      <div className="person-detail__timeline-content">
                        <div className="person-detail__timeline-title">{scene.title}</div>
                        {scene.summary && (
                          <div className="person-detail__timeline-summary">{scene.summary}</div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 我答应过的事 */}
          <section className="card person-detail__section">
            <h3 className="card__title">
              我答应过的事
              <span className="person-detail__count">
                {detailData.unfinishedPromises.length}
              </span>
            </h3>
            <div className="card__body">
              {detailData.unfinishedPromises.length === 0 ? (
                <p className="person-detail__empty">暂无未完成的承诺。</p>
              ) : (
                <ul className="person-detail__list">
                  {detailData.unfinishedPromises.map((t) => (
                    <li key={t.id} className="person-detail__list-item">
                      <div className="person-detail__list-title">{t.title}</div>
                      {t.summary && (
                        <div className="person-detail__list-summary">{t.summary}</div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 对方提到的需求/意见 */}
          <section className="card person-detail__section">
            <h3 className="card__title">提到过的事</h3>
            <div className="card__body">
              {detailData.relatedFacts.length === 0 ? (
                <p className="person-detail__empty">暂无相关记忆。</p>
              ) : (
                <ul className="person-detail__list">
                  {detailData.relatedFacts.slice(0, 10).map((f) => (
                    <li key={f.id} className="person-detail__list-item">
                      <div className="person-detail__list-summary">{f.content}</div>
                      <div className="person-detail__list-meta">
                        {new Date(f.createdAt).toLocaleString("zh-CN")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* 相关资料 */}
          <section className="card person-detail__section">
            <h3 className="card__title">相关资料</h3>
            <div className="card__body">
              {detailData.relatedFacts.length === 0 && detailData.relatedScenes.length === 0 ? (
                <p className="person-detail__empty">暂无相关资料。</p>
              ) : (
                <ul className="person-detail__list">
                  {detailData.relatedFacts.slice(0, 5).map((f) => (
                    <li key={f.id} className="person-detail__list-item">
                      <div className="person-detail__list-summary">{f.content}</div>
                      <div className="person-detail__list-meta">
                        {new Date(f.createdAt).toLocaleString("zh-CN")}
                      </div>
                    </li>
                  ))}
                  {detailData.relatedScenes.slice(0, 3).map((s) => (
                    <li key={s.id} className="person-detail__list-item">
                      <div className="person-detail__list-title">{s.title}</div>
                      {s.summary && (
                        <div className="person-detail__list-summary">{s.summary}</div>
                      )}
                      <div className="person-detail__list-meta">
                        {new Date(s.startAt).toLocaleString("zh-CN")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
        )}
      </div>
    );
  }

  // 列表视图
  return (
    <div className="people-page">
      <header className="page-header">
        <h2>人物</h2>
        <p className="page-header__sub">
          你自己的关系记忆。查看最近和谁有协作、相关项目和答应过的事。
        </p>
      </header>

      {todayError && (
        <div className="people-page__error">
          <span>加载失败：{todayError}</span>
          <button onClick={() => void loadToday()}>重试</button>
        </div>
      )}

      {todayLoading && todayData.people.length === 0 ? (
        <p className="state-loading">正在加载人物...</p>
      ) : todayData.people.length === 0 ? (
        <div className="empty-state">
          <p>当前没有人物记录。</p>
          <p className="empty-state__hint">
            持续观察后，Recall 会从工作上下文中识别相关人物。
          </p>
        </div>
      ) : (
        <div className="people-grid">
          {todayData.people.map((person) => {
            const stat = peopleStats.get(person.id) ?? {
              latestInteraction: null,
              unfinishedCount: 0,
              projectNames: [],
            };
            return (
              <div
                key={person.id}
                className="person-card"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedPersonId(person.id);
                  }
                }}
              >
                <div className="person-card__header">
                  <h3 className="person-card__name">{person.name}</h3>
                  <div className="person-card__header-right">
                    {stat.unfinishedCount > 0 && (
                      <span className="person-card__badge">{stat.unfinishedCount} 项待办</span>
                    )}
                    <button
                      type="button"
                      className="person-card__merge-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMergeFrom({ id: person.id, name: person.name });
                      }}
                      title="把此人合并到其他人物（来自同一人但识别成多个名字时）"
                    >
                      合并到...
                    </button>
                  </div>
                </div>
                {person.aliases && person.aliases.length > 0 && (
                  <div className="person-card__aliases" title="已合并过的旧名字">
                    别名：{person.aliases.join("、")}
                  </div>
                )}
                <div className="person-card__body" onClick={() => setSelectedPersonId(person.id)}>
                  <div className="person-card__role">
                    {[person.role, person.organization].filter(Boolean).join(" · ") || "角色未知"}
                  </div>
                  <div className="person-card__projects">
                    {stat.projectNames.length > 0
                      ? stat.projectNames.slice(0, 2).join("、")
                      : "暂无相关项目"}
                    {stat.projectNames.length > 2 && ` 等 ${stat.projectNames.length} 个`}
                  </div>
                  <div className="person-card__meta">
                    <span className="person-card__time">
                      最近协作：
                      {stat.latestInteraction
                        ? new Date(stat.latestInteraction).toLocaleDateString("zh-CN")
                        : "暂无记录"}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mergeFrom && (
        <MergeDialog
          open={true}
          objectType="person"
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
