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
import { MoreHorizontal } from "lucide-react";
import { useAppStore } from "../state/store";
import type { PersonItem, ProjectItem, SceneItem, TaskItem, FactItem } from "../state/store";
import { getIpc } from "../state/ipc";
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

function admissionReasonLabel(reason?: string | null): string {
  const labels: Record<string, string> = {
    person_without_exact_hint: "缺少明确的人物名称证据",
    person_without_direct_relationship: "尚未发现直接沟通或协作关系",
    source_author_or_list_only: "仅出现在作者、名单或示例中",
    user_reject: "已由你排除",
  };
  return reason ? labels[reason] ?? "需要确认是否作为长期人物" : "需要确认是否作为长期人物";
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
  const deleteObject = useAppStore((s) => s.deleteObject);
  const updatePerson = useAppStore((s) => s.updatePerson);
  const peopleFilters = useAppStore((s) => s.peopleFilters);
  const setPeopleFilters = useAppStore((s) => s.setPeopleFilters);

  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [personDetail, setPersonDetail] = useState<PersonDetailData | null>(null);
  const [personDetailLoading, setPersonDetailLoading] = useState(false);
  const [personDetailError, setPersonDetailError] = useState<string | null>(null);
  const [personDetailReloadKey, setPersonDetailReloadKey] = useState(0);
  // 012 新增：合并对话框状态
  const [mergeFrom, setMergeFrom] = useState<{ id: string; name: string } | null>(null);
  // 022 新增：人物编辑弹窗状态
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editForm, setEditForm] = useState({
    name: "",
    role: "",
    organization: "",
    relationship: "",
    summary: "",
  });
  const [editSaving, setEditSaving] = useState(false);
  const [supplementalPeople, setSupplementalPeople] = useState<PersonItem[]>([]);
  const [supplementalLoading, setSupplementalLoading] = useState(false);
  const [supplementalError, setSupplementalError] = useState<string | null>(null);
  const [reviewingPersonId, setReviewingPersonId] = useState<string | null>(null);
  const [supplementalRevision, setSupplementalRevision] = useState(0);

  // 进入页面时加载今日数据
  useEffect(() => {
    if (isReady && todayData.people.length === 0) {
      void loadToday();
    }
  }, [isReady, loadToday, todayData.people.length]);

  // 候选和已删除对象不会进入 Today 投影，按当前视图单独读取。
  useEffect(() => {
    if (peopleFilters.status === "active") {
      setSupplementalPeople([]);
      setSupplementalError(null);
      return;
    }
    let cancelled = false;
    setSupplementalLoading(true);
    setSupplementalError(null);
    const input = peopleFilters.status === "candidate"
      ? { admissionStatus: "candidate" as const }
      : { includeDeleted: true, includeNonPromoted: true };
    void getIpc().memory.listPeople<PersonItem>(input)
      .then((result) => {
        if (cancelled) return;
        setSupplementalPeople(peopleFilters.status === "deleted"
          ? result.people.filter((person) => person.deletedAt || person.admissionStatus === "rejected")
          : result.people);
      })
      .catch((error) => {
        if (cancelled) return;
        setSupplementalError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setSupplementalLoading(false);
      });
    return () => { cancelled = true; };
  }, [peopleFilters.status, supplementalRevision]);

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

  // 客户端过滤 + 排序
  const filteredPeople = useMemo(() => {
    let list = peopleFilters.status === "active"
      ? todayData.people.filter((p) => !p.deletedAt)
      : supplementalPeople;

    const kw = peopleFilters.keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter((p) =>
        p.name.toLowerCase().includes(kw) ||
        (p.role ?? "").toLowerCase().includes(kw) ||
        (p.organization ?? "").toLowerCase().includes(kw) ||
        (p.aliases ?? []).some((a) => a.toLowerCase().includes(kw))
      );
    }

    if (peopleFilters.status === "active" && peopleFilters.projectId) {
      list = list.filter((p) => p.relatedProjectIds.includes(peopleFilters.projectId));
    }

    const sortBy = peopleFilters.sortBy;
    list = [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN");
      const aVal = a[sortBy] ?? "";
      const bVal = b[sortBy] ?? "";
      return bVal.localeCompare(aVal); // 降序
    });
    return list;
  }, [todayData.people, supplementalPeople, peopleFilters]);

  const handleReviewPerson = async (
    id: string,
    decision: "promote" | "reject" | "restore"
  ) => {
    setReviewingPersonId(id);
    setSupplementalError(null);
    try {
      await getIpc().memory.reviewAdmission({ objectType: "person", id, decision });
      setSupplementalRevision((revision) => revision + 1);
      await loadToday();
    } catch (error) {
      setSupplementalError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewingPersonId(null);
    }
  };

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

  /** 删除人物（软删除，保留 source 链路可恢复） */
  const handleDeletePerson = (id: string) => {
    useAppStore.getState().requestConfirm({
      title: "删除人物",
      message: "确定要删除这个人物吗？删除后仍保留 source 链路，可恢复。",
      confirmText: "确认",
      onConfirm: async () => {
        try {
          await deleteObject(id, "person");
          if (selectedPersonId === id) {
            setSelectedPersonId(null);
          }
        } catch (err) {
          console.error("删除人物失败:", err);
        }
      },
    });
  };

  /** 打开人物编辑弹窗（用当前人物信息初始化表单） */
  const handleOpenEditDialog = () => {
    if (!selectedPerson) return;
    setEditForm({
      name: selectedPerson.name || "",
      role: selectedPerson.role || "",
      organization: selectedPerson.organization || "",
      relationship: selectedPerson.relationship || "",
      summary: selectedPerson.summary || "",
    });
    setEditDialogOpen(true);
  };

  /** 保存人物编辑（调用 IPC + 触发详情重新拉取） */
  const handleSavePerson = async () => {
    if (!selectedPerson) return;
    setEditSaving(true);
    try {
      await updatePerson(selectedPerson.id, {
        name: editForm.name.trim() || undefined,
        role: editForm.role.trim() || null,
        organization: editForm.organization.trim() || null,
        relationship: editForm.relationship.trim() || null,
        summary: editForm.summary.trim() || null,
      });
      setEditDialogOpen(false);
      // 重新拉取详情以同步展示
      setPersonDetailReloadKey((key) => key + 1);
    } catch (err) {
      console.error("保存人物失败:", err);
    } finally {
      setEditSaving(false);
    }
  };

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
            <div className="person-detail__section-header">
              <h3 className="card__title">人物概览</h3>
              <div className="person-detail__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleOpenEditDialog}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => handleDeletePerson(person.id)}
                >
                  删除
                </button>
              </div>
            </div>
            <div className="card__body">
              <p className="person-detail__summary">
                {person.summary || "暂无概览信息。"}
              </p>
              <div className="person-detail__meta">
                {person.relationship && <span>关系：{person.relationship}</span>}
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

        {/* 022 新增：人物编辑弹窗 */}
        {editDialogOpen && (
          <div
            className="person-edit-dialog__overlay"
            onClick={() => !editSaving && setEditDialogOpen(false)}
          >
            <div
              className="person-edit-dialog"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="person-edit-dialog__title">编辑人物信息</h3>
              <div className="person-edit-dialog__form">
                <label className="person-edit-dialog__field">
                  <span>姓名</span>
                  <input
                    type="text"
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    maxLength={120}
                  />
                </label>
                <label className="person-edit-dialog__field">
                  <span>角色</span>
                  <input
                    type="text"
                    value={editForm.role}
                    onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
                    placeholder="如：产品经理、设计师"
                    maxLength={120}
                  />
                </label>
                <label className="person-edit-dialog__field">
                  <span>组织</span>
                  <input
                    type="text"
                    value={editForm.organization}
                    onChange={(e) => setEditForm({ ...editForm, organization: e.target.value })}
                    placeholder="如：腾讯、字节跳动"
                    maxLength={120}
                  />
                </label>
                <label className="person-edit-dialog__field">
                  <span>关系</span>
                  <input
                    type="text"
                    value={editForm.relationship}
                    onChange={(e) => setEditForm({ ...editForm, relationship: e.target.value })}
                    placeholder="如：同事、客户、朋友"
                    maxLength={120}
                  />
                </label>
                <label className="person-edit-dialog__field">
                  <span>简介</span>
                  <textarea
                    value={editForm.summary}
                    onChange={(e) => setEditForm({ ...editForm, summary: e.target.value })}
                    rows={3}
                    maxLength={1000}
                  />
                </label>
              </div>
              <div className="person-edit-dialog__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setEditDialogOpen(false)}
                  disabled={editSaving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSavePerson}
                  disabled={editSaving}
                >
                  {editSaving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>
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

      {supplementalError && (
        <div className="people-page__error">
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
            placeholder="姓名 / 角色 / 组织 / 别名"
            value={peopleFilters.keyword}
            onChange={(e) => setPeopleFilters({ keyword: e.target.value })}
          />
        </div>
        <div className="memory-filters__group">
          <label className="memory-filters__label">状态</label>
          <select
            className="memory-filters__select"
            value={peopleFilters.status}
            onChange={(e) => setPeopleFilters({
              status: e.target.value as "active" | "candidate" | "deleted",
            })}
          >
            <option value="active">人物</option>
            <option value="candidate">待确认</option>
            <option value="deleted">已删除</option>
          </select>
        </div>
        <div className="memory-filters__group">
          <label className="memory-filters__label">关联项目</label>
          <select
            className="memory-filters__select"
            value={peopleFilters.projectId}
            onChange={(e) => setPeopleFilters({ projectId: e.target.value })}
            disabled={peopleFilters.status !== "active"}
          >
            <option value="">全部项目</option>
            {todayData.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="memory-filters__group">
          <label className="memory-filters__label">排序</label>
          <select
            className="memory-filters__select"
            value={peopleFilters.sortBy}
            onChange={(e) => setPeopleFilters({ sortBy: e.target.value as "updatedAt" | "createdAt" | "name" })}
          >
            <option value="updatedAt">最近协作</option>
            <option value="createdAt">创建时间</option>
            <option value="name">姓名</option>
          </select>
        </div>
      </div>

      {(peopleFilters.status === "active" ? todayLoading : supplementalLoading)
        && filteredPeople.length === 0 ? (
        <p className="state-loading">正在加载人物...</p>
      ) : filteredPeople.length === 0 ? (
        <div className="empty-state">
          <p>{peopleFilters.status === "candidate"
            ? "当前没有待确认的人物。"
            : peopleFilters.status === "deleted"
              ? "当前没有已删除的人物。"
              : "当前没有符合筛选条件的人物。"}</p>
          <p className="empty-state__hint">
            {peopleFilters.status === "active"
              ? "调整搜索关键词或筛选条件，或持续观察让 Recall 识别更多人物。"
              : "这里的对象不会进入日常人物列表，直到你确认或恢复。"}
          </p>
        </div>
      ) : (
        <div className="people-grid">
          {filteredPeople.map((person) => {
            const stat = peopleStats.get(person.id) ?? {
              latestInteraction: null,
              unfinishedCount: 0,
              projectNames: [],
            };
            return (
              <div
                key={person.id}
                className="person-card"
                role={peopleFilters.status === "active" ? "button" : undefined}
                tabIndex={peopleFilters.status === "active" ? 0 : undefined}
                onKeyDown={(e) => {
                  if (peopleFilters.status === "active" && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    setSelectedPersonId(person.id);
                  }
                }}
              >
                <div className="person-card__header">
                  <h3 className="person-card__name">{person.name}</h3>
                  <div className="person-card__header-right">
                    {peopleFilters.status !== "active" && (
                      <span className="person-card__badge admission-card__status">
                        {peopleFilters.status === "candidate" ? "待确认" : "已删除"}
                      </span>
                    )}
                    {stat.unfinishedCount > 0 && (
                      <span className="person-card__badge">{stat.unfinishedCount} 项待办</span>
                    )}
                    {peopleFilters.status === "active" && <details className="person-card__menu">
                      <summary aria-label="人物操作" title="人物操作"><MoreHorizontal size={17} /></summary>
                      <div className="person-card__menu-popover">
                        <button type="button" onClick={(e) => { e.stopPropagation(); setMergeFrom({ id: person.id, name: person.name }); }}>合并到...</button>
                        <button type="button" className="is-danger" onClick={(e) => { e.stopPropagation(); handleDeletePerson(person.id); }}>删除</button>
                      </div>
                    </details>}
                  </div>
                </div>
                {person.aliases && person.aliases.length > 0 && (
                  <div className="person-card__aliases" title="已合并过的旧名字">
                    别名：{person.aliases.join("、")}
                  </div>
                )}
                <div
                  className={`person-card__body${peopleFilters.status === "active" ? "" : " person-card__body--static"}`}
                  onClick={() => peopleFilters.status === "active" && setSelectedPersonId(person.id)}
                >
                  <div className="person-card__role">
                    {person.relationship
                      || [person.role, person.organization].filter(Boolean).join(" · ")
                      || "角色未知"}
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
                {peopleFilters.status !== "active" && (
                  <div className="admission-card__reason">
                    {admissionReasonLabel(person.admissionReason)}
                  </div>
                )}
                {peopleFilters.status === "candidate" && (
                  <div className="admission-card__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={reviewingPersonId === person.id}
                      onClick={() => void handleReviewPerson(person.id, "promote")}
                    >
                      确认为人物
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={reviewingPersonId === person.id}
                      onClick={() => void handleReviewPerson(person.id, "reject")}
                    >
                      排除
                    </button>
                  </div>
                )}
                {peopleFilters.status === "deleted" && (
                  <div className="admission-card__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={reviewingPersonId === person.id}
                      onClick={() => void handleReviewPerson(person.id, "restore")}
                    >
                      恢复人物
                    </button>
                  </div>
                )}
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
