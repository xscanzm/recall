// src/renderer/pages/MemorySearchPage.tsx
// 记忆库搜索页 + 轻量问答（Phase 6 重构，来自 spec.md "记忆库"章节）
//
// 搜索 UI（spec 行 2206-2228）：
// - 顶部大搜索框 placeholder "搜索过去的工作、资料、决策或人"
// - 过滤：时间 / 项目 / 类型 / 人物
// - 类型：工作片段 / 任务 / 决策 / 资料 / 项目 / 报告 / 人物
//
// 搜索结果卡片（spec 行 2229-2239）：
// - 类型标签 / 标题 / 摘要 / 时间 / 项目 / 查看来源
// - 不要像数据库表格
//
// 自然语言问答（spec 行 2241-2247）：
// - 只基于检索到的记忆
// - 列出来源
// - 不确定时说明
//
// 重要约束：
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语
// - 不显示 source ids

import { useState, useMemo } from "react";
import { useAppStore, type SearchResultItem, type AskSourceItem } from "../state/store";
import { CorrectionDialog } from "../components/CorrectionDialog";
import type { FeedbackTargetType } from "../state/store";

/**
 * 搜索结果类型 -> 前台标签（spec 行 2220-2227）
 * spec 明确类型：工作片段 / 任务 / 决策 / 资料 / 项目 / 报告 / 人物
 */
const RESULT_TYPE_LABELS: Record<SearchResultItem["type"], string> = {
  fact: "资料",
  scene: "工作片段",
  task: "任务",
  project: "项目",
  decision: "决策",
  report: "报告",
  person: "人物",
};

/**
 * 搜索结果类型 -> 颜色
 */
const RESULT_TYPE_COLORS: Record<SearchResultItem["type"], string> = {
  fact: "var(--recall-info)",
  scene: "var(--recall-text-muted)",
  task: "var(--recall-accent)",
  project: "var(--recall-accent)",
  decision: "var(--recall-amber)",
  report: "var(--recall-text-muted)",
  person: "var(--recall-info)",
};

/**
 * 问答来源类型 -> 前台标签
 */
const ASK_SOURCE_TYPE_LABELS: Record<AskSourceItem["type"], string> = RESULT_TYPE_LABELS;

/**
 * 把搜索结果类型映射为可纠错的目标类型
 * report 类型不可纠错（返回 null）
 */
function toCorrectionTargetType(
  type: SearchResultItem["type"]
): FeedbackTargetType | null {
  if (type === "fact") return "fact";
  if (type === "scene") return "scene";
  if (type === "task") return "task";
  if (type === "project") return "project";
  if (type === "person") return "person";
  if (type === "decision") return "decision";
  return null; // report 不支持纠错
}

/**
 * 时间过滤选项
 */
type TimeFilter = "all" | "today" | "week" | "month";

const TIME_FILTER_LABELS: Record<TimeFilter, string> = {
  all: "全部时间",
  today: "今天",
  week: "本周",
  month: "本月",
};

/**
 * 判断时间是否符合过滤条件
 */
function matchTimeFilter(createdAt: string, filter: TimeFilter): boolean {
  if (filter === "all") return true;
  const d = new Date(createdAt);
  const now = new Date();
  const oneDay = 24 * 60 * 60 * 1000;
  const diff = now.getTime() - d.getTime();
  if (filter === "today") {
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate()
    );
  }
  if (filter === "week") return diff >= 0 && diff <= 7 * oneDay;
  if (filter === "month") return diff >= 0 && diff <= 30 * oneDay;
  return true;
}

export function MemorySearchPage() {
  const isReady = useAppStore((s) => s.isReady);
  const todayData = useAppStore((s) => s.todayData);
  const setPage = useAppStore((s) => s.setPage);
  const setPendingJump = useAppStore((s) => s.setPendingJump);

  // 搜索状态
  const searchQuery = useAppStore((s) => s.searchQuery);
  const searchResults = useAppStore((s) => s.searchResults);
  const searchLoading = useAppStore((s) => s.searchLoading);
  const searchError = useAppStore((s) => s.searchError);
  const searchSearched = useAppStore((s) => s.searchSearched);
  const searchMemory = useAppStore((s) => s.searchMemory);

  // 问答状态
  const askQuestion = useAppStore((s) => s.askQuestion);
  const askResult = useAppStore((s) => s.askResult);
  const askLoading = useAppStore((s) => s.askLoading);
  const askError = useAppStore((s) => s.askError);
  const askMemory = useAppStore((s) => s.askMemory);

  // 本地输入框状态
  const [queryInput, setQueryInput] = useState("");
  const [askInput, setAskInput] = useState("");

  // 过滤状态
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [personFilter, setPersonFilter] = useState<string>("all");

  // 纠错对话框状态
  const [correctionTarget, setCorrectionTarget] = useState<{
    targetType: FeedbackTargetType;
    targetId: string;
  } | null>(null);

  // 搜索表单提交
  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = queryInput.trim();
    if (!q) return;
    await searchMemory(q);
  };

  // 问答表单提交
  const handleAsk = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = askInput.trim();
    if (!q) return;
    await askMemory(q);
    setAskInput("");
  };

  // 来源跳转：根据 sourceType 跳转到对应页面
  const handleViewSource = (item: SearchResultItem) => {
    if (!item.sourceType || !item.sourceId) {
      if (item.type === "task") setPage("tasks");
      else if (item.type === "project") setPage("projects");
      else if (item.type === "report") setPage("reports");
      else if (item.type === "decision") setPage("projects");
      return;
    }
    setPendingJump(item.sourceId, item.sourceType);
    if (item.sourceType === "observation") {
      setPage("today");
    } else if (item.sourceType === "fact") {
      setPage("memory");
    } else if (item.sourceType === "scene") {
      setPage("today");
    } else if (item.sourceType === "project") {
      setPage("projects");
    } else if (item.sourceType === "report") {
      setPage("reports");
    }
  };

  // 打开纠错对话框
  const handleCorrect = (item: SearchResultItem) => {
    const targetType = toCorrectionTargetType(item.type);
    if (!targetType) return;
    setCorrectionTarget({ targetType, targetId: item.id });
  };

  // 问答来源点击：跳转到对应页面
  const handleSourceClick = (source: AskSourceItem) => {
    if (source.type === "task") setPage("tasks");
    else if (source.type === "project") setPage("projects");
    else if (source.type === "report") setPage("reports");
    else if (source.type === "decision") setPage("projects");
    else setPage("memory");
  };

  // 应用过滤后的结果
  const filteredResults = useMemo(() => {
    return searchResults.filter((r) => {
      // 时间过滤
      if (!matchTimeFilter(r.createdAt, timeFilter)) return false;
      // 项目过滤
      if (projectFilter !== "all" && r.projectId !== projectFilter) return false;
      // 类型过滤
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      // 人物过滤（按结果标题/摘要中是否包含人物名）
      if (personFilter !== "all") {
        const person = todayData.people.find((p) => p.id === personFilter);
        if (person) {
          const name = person.name;
          if (!r.title.includes(name) && !(r.summary ?? "").includes(name)) {
            return false;
          }
        }
      }
      return true;
    });
  }, [searchResults, timeFilter, projectFilter, typeFilter, personFilter, todayData.people]);

  // 类型选项（spec 行 2220-2227）
  const typeOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "全部类型" },
    { value: "scene", label: RESULT_TYPE_LABELS.scene },
    { value: "task", label: RESULT_TYPE_LABELS.task },
    { value: "decision", label: RESULT_TYPE_LABELS.decision },
    { value: "fact", label: RESULT_TYPE_LABELS.fact },
    { value: "project", label: RESULT_TYPE_LABELS.project },
    { value: "report", label: RESULT_TYPE_LABELS.report },
    { value: "person", label: RESULT_TYPE_LABELS.person },
  ];

  if (!isReady) {
    return (
      <div className="memory-search-page">
        <header className="page-header">
          <h2>记忆库</h2>
        </header>
        <p className="state-loading">正在加载...</p>
      </div>
    );
  }

  return (
    <div className="memory-search-page">
      <header className="page-header">
        <h2>记忆库</h2>
        <p className="page-header__sub">
          帮你找回过去的工作、资料、决策或人。也可以用自然语言提问，Recall 会基于检索到的记忆回答。
        </p>
      </header>

      {/* 顶部大搜索框（spec 行 2208-2212） */}
      <form className="memory-search-bar" onSubmit={handleSearch}>
        <input
          type="text"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder="搜索过去的工作、资料、决策或人"
          className="memory-search-bar__input"
        />
        <button type="submit" className="primary" disabled={searchLoading || !queryInput.trim()}>
          {searchLoading ? "搜索中..." : "搜索"}
        </button>
      </form>

      {/* 过滤区（spec 行 2214-2218） */}
      {searchSearched && searchResults.length > 0 && (
        <div className="memory-filters">
          <div className="memory-filters__group">
            <label className="memory-filters__label">时间</label>
            <select
              className="memory-filters__select"
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
            >
              {Object.entries(TIME_FILTER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <div className="memory-filters__group">
            <label className="memory-filters__label">项目</label>
            <select
              className="memory-filters__select"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="all">全部项目</option>
              {todayData.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="memory-filters__group">
            <label className="memory-filters__label">类型</label>
            <select
              className="memory-filters__select"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              {typeOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div className="memory-filters__group">
            <label className="memory-filters__label">人物</label>
            <select
              className="memory-filters__select"
              value={personFilter}
              onChange={(e) => setPersonFilter(e.target.value)}
            >
              <option value="all">全部人物</option>
              {todayData.people.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* 搜索结果区 */}
      {searchError && <p className="memory-search__error">{searchError}</p>}

      {searchSearched && searchResults.length === 0 && !searchError && (
        <div className="empty-state">
          <p>没有找到匹配的记忆。</p>
          <p className="empty-state__hint">试试其他关键词，或等待 Recall 沉淀更多内容。</p>
        </div>
      )}

      {searchSearched && filteredResults.length > 0 && (
        <div className="memory-results">
          <div className="memory-results__summary">
            共 {filteredResults.length} 条结果
            {searchQuery && <span className="memory-results__query">关键词：{searchQuery}</span>}
          </div>
          <div className="memory-results__list">
            {filteredResults.map((r) => (
              <div key={`${r.type}-${r.id}`} className="memory-result-card">
                <div className="memory-result-card__header">
                  <span
                    className="memory-result-card__type"
                    style={{ color: RESULT_TYPE_COLORS[r.type] ?? "var(--recall-text-muted)" }}
                  >
                    {RESULT_TYPE_LABELS[r.type] ?? r.type}
                  </span>
                  {r.projectName && (
                    <span className="memory-result-card__project">{r.projectName}</span>
                  )}
                </div>
                <div className="memory-result-card__title">{r.title}</div>
                {r.summary && (
                  <div className="memory-result-card__summary">{r.summary}</div>
                )}
                <div className="memory-result-card__footer">
                  <span className="memory-result-card__time">
                    {new Date(r.createdAt).toLocaleString("zh-CN")}
                  </span>
                  <div className="memory-result-card__actions">
                    {(r.sourceType || r.sourceId) && (
                      <button
                        type="button"
                        onClick={() => handleViewSource(r)}
                        className="memory-result-card__action"
                      >
                        查看来源
                      </button>
                    )}
                    {toCorrectionTargetType(r.type) && (
                      <button
                        type="button"
                        onClick={() => handleCorrect(r)}
                        className="memory-result-card__action memory-result-card__action--ghost"
                      >
                        纠错
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {searchSearched && filteredResults.length === 0 && searchResults.length > 0 && (
        <div className="empty-state">
          <p>当前过滤条件下没有结果。</p>
          <p className="empty-state__hint">尝试调整过滤条件。</p>
        </div>
      )}

      {!searchSearched && !searchError && (
        <div className="empty-state">
          <p>输入关键词搜索记忆。</p>
          <p className="empty-state__hint">
            结果会以卡片形式展示类型、标题、摘要、时间、项目和来源。
          </p>
        </div>
      )}

      {/* 自然语言问答（spec 行 2241-2247） */}
      <section className="memory-ask">
        <h3 className="memory-ask__title">问回声</h3>
        <p className="memory-ask__hint">
          用自然语言提问，Recall 只基于检索到的记忆回答，会列出来源；不确定时会说明。
        </p>
        <form className="memory-ask__bar" onSubmit={handleAsk}>
          <input
            type="text"
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            placeholder="例如：上周研究那个工具的结论是什么？我上次和某人聊了什么？某个项目为什么当时这么定？"
            className="memory-ask__input"
          />
          <button type="submit" className="primary" disabled={askLoading || !askInput.trim()}>
            {askLoading ? "思考中..." : "提问"}
          </button>
        </form>

        {askError && <p className="memory-search__error">{askError}</p>}

        {askResult && (
          <div className="memory-ask__result">
            {askResult.ok ? (
              <>
                <div className="memory-ask__question">
                  <span className="memory-ask__label">问：</span>
                  {askQuestion}
                </div>
                {askResult.answer && (
                  <div className="memory-ask__answer">
                    <span className="memory-ask__label">答：</span>
                    <div className="memory-ask__answer-text">{askResult.answer}</div>
                  </div>
                )}
                {askResult.sources && askResult.sources.length > 0 ? (
                  <div className="memory-ask__sources">
                    <div className="memory-ask__sources-title">
                      来源（{askResult.sources.length} 条）
                      {typeof askResult.searchCount === "number" && (
                        <span className="memory-ask__search-count">
                          检索范围 {askResult.searchCount} 条
                        </span>
                      )}
                    </div>
                    <ul className="memory-ask__sources-list">
                      {askResult.sources.map((s, idx) => (
                        <li
                          key={`${s.type}-${s.id}-${idx}`}
                          className="memory-ask__source"
                          onClick={() => handleSourceClick(s)}
                        >
                          <span
                            className="memory-ask__source-type"
                            style={{ color: RESULT_TYPE_COLORS[s.type] ?? "var(--recall-text-muted)" }}
                          >
                            {ASK_SOURCE_TYPE_LABELS[s.type] ?? s.type}
                          </span>
                          <div className="memory-ask__source-main">
                            <div className="memory-ask__source-title">{s.title}</div>
                            {s.summary && (
                              <div className="memory-ask__source-summary">{s.summary}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="memory-ask__no-sources">
                    本次回答未检索到明确来源，建议换一种问法或确认相关记忆是否已沉淀。
                  </div>
                )}
              </>
            ) : (
              <div className="memory-ask__error">
                <p>回答失败：{askResult.message ?? askResult.code ?? "未知错误"}</p>
                <p className="memory-ask__error-hint">
                  可能是模型未配置或检索为空。请先在设置页配置语言模型，或换一种问法。
                </p>
              </div>
            )}
          </div>
        )}

        {!askResult && !askError && !askLoading && (
          <p className="memory-ask__empty">还没有提问。可以试试上面的示例问题。</p>
        )}
      </section>

      {/* 纠错对话框 */}
      {correctionTarget && (
        <CorrectionDialog
          open={true}
          targetType={correctionTarget.targetType}
          targetId={correctionTarget.targetId}
          onClose={() => setCorrectionTarget(null)}
          onSubmitted={() => {
            if (searchQuery) {
              void searchMemory(searchQuery);
            }
          }}
        />
      )}
    </div>
  );
}
