import * as React from "react";
import { useCallback, useState } from "react";
import { MemoryDetailPage } from "./MemoryDetailPage";
import { useAppStore, type SearchFilters, type SearchResultItem } from "../state/store";

const RESULT_TYPE_LABELS: Record<SearchResultItem["type"], string> = {
  fact: "内容",
  scene: "工作片段",
  task: "任务",
  project: "项目",
  decision: "决策",
  report: "报告",
  person: "人物",
  record: "记录",
};

const RESULT_TYPE_COLORS: Record<SearchResultItem["type"], string> = {
  fact: "var(--recall-info)",
  scene: "var(--recall-text-muted)",
  task: "var(--recall-accent)",
  project: "var(--recall-accent)",
  decision: "var(--recall-amber)",
  report: "var(--recall-text-muted)",
  person: "var(--recall-info)",
  record: "var(--recall-green)",
};

type TimeFilter = "all" | "today" | "week" | "month";

const TIME_FILTER_LABELS: Record<TimeFilter, string> = {
  all: "全部时间",
  today: "今天",
  week: "最近 7 天",
  month: "最近 30 天",
};

function timeRange(filter: TimeFilter): Pick<SearchFilters, "timeFrom" | "timeTo"> {
  if (filter === "all") return {};
  const now = new Date();
  const start = new Date(now);
  if (filter === "today") start.setHours(0, 0, 0, 0);
  if (filter === "week") start.setDate(start.getDate() - 7);
  if (filter === "month") start.setDate(start.getDate() - 30);
  return { timeFrom: start.toISOString(), timeTo: new Date(now.getTime() + 1).toISOString() };
}

/** memo 化的搜索结果卡片：props 不变时跳过重渲染 */
const SearchResultCard = React.memo(function SearchResultCard({
  result,
  onOpenDetail,
}: {
  result: SearchResultItem;
  onOpenDetail: (ref: { id: string; type: SearchResultItem["type"] }) => void;
}) {
  const handleOpen = () => onOpenDetail({ id: result.id, type: result.type });
  return (
    <article
      className="memory-result-card"
      role="button"
      tabIndex={0}
      onClick={handleOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleOpen();
        }
      }}
    >
      <div className="memory-result-card__header">
        <span className="memory-result-card__type" style={{ color: RESULT_TYPE_COLORS[result.type] }}>{RESULT_TYPE_LABELS[result.type]}</span>
        {result.projectName && <span className="memory-result-card__project">{result.projectName}</span>}
      </div>
      <h3 className="memory-result-card__title">{result.title}</h3>
      {result.summary && <p className="memory-result-card__summary">{result.summary}</p>}
      <div className="memory-result-card__matches">{result.matchReasons.slice(0, 3).map((reason) => <span key={reason}>命中{reason}</span>)}{result.sourceCount > 0 && <span>{result.sourceCount} 条来源</span>}</div>
      <div className="memory-result-card__footer"><time>{new Date(result.createdAt).toLocaleString("zh-CN")}</time><span className="memory-result-card__open">查看详情</span></div>
    </article>
  );
});

function buildFilters(time: TimeFilter, project: string, type: string, person: string): SearchFilters {
  return {
    timePreset: time,
    ...timeRange(time),
    projectId: project === "all" ? undefined : project,
    type: type === "all" ? undefined : type as SearchResultItem["type"],
    personId: person === "all" ? undefined : person,
  };
}

export function MemorySearchPage() {
  const isReady = useAppStore((state) => state.isReady);
  const todayData = useAppStore((state) => state.todayData);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const searchFilters = useAppStore((state) => state.searchFilters);
  const searchResults = useAppStore((state) => state.searchResults);
  const searchTotal = useAppStore((state) => state.searchTotal);
  const searchQuality = useAppStore((state) => state.searchQuality);
  const searchQueryTerms = useAppStore((state) => state.searchQueryTerms);
  const searchExpandedTerms = useAppStore((state) => state.searchExpandedTerms);
  const searchLoading = useAppStore((state) => state.searchLoading);
  const searchError = useAppStore((state) => state.searchError);
  const searchSearched = useAppStore((state) => state.searchSearched);
  const searchMemory = useAppStore((state) => state.searchMemory);
  const expandSearch = useAppStore((state) => state.expandSearch);
  const searchExpandLoading = useAppStore((state) => state.searchExpandLoading);
  const searchExpandError = useAppStore((state) => state.searchExpandError);
  const followupQuestion = useAppStore((state) => state.followupQuestion);
  const aiMode = useAppStore((state) => state.aiMode);
  const aiResult = useAppStore((state) => state.aiResult);
  const aiLoading = useAppStore((state) => state.aiLoading);
  const aiError = useAppStore((state) => state.aiError);
  const setFollowupQuestion = useAppStore((state) => state.setFollowupQuestion);
  const analyzeMemory = useAppStore((state) => state.analyzeMemory);

  const [queryInput, setQueryInput] = useState(searchQuery);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(() => searchFilters.timePreset ?? "all");
  const [projectFilter, setProjectFilter] = useState(() => searchFilters.projectId ?? "all");
  const [typeFilter, setTypeFilter] = useState(() => searchFilters.type ?? "all");
  const [personFilter, setPersonFilter] = useState(() => searchFilters.personId ?? "all");
  const [selectedDetail, setSelectedDetail] = useState<{ id: string; type: SearchResultItem["type"] } | null>(null);
  const [followupOpen, setFollowupOpen] = useState(false);

  // 稳定回调：配合 memo 化的 SearchResultCard 跳过重渲染
  const handleOpenResult = useCallback((ref: { id: string; type: SearchResultItem["type"] }) => {
    setSelectedDetail(ref);
  }, []);

  const currentFilters = buildFilters(timeFilter, projectFilter, typeFilter, personFilter);

  const runSearch = async (query: string, filters = currentFilters) => {
    const value = query.trim();
    if (!value) return;
    await searchMemory(value, 50, 0, filters);
  };

  const handleSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    await runSearch(queryInput);
  };

  const updateFilter = (next: { time?: TimeFilter; project?: string; type?: string; person?: string }) => {
    const nextTime = next.time ?? timeFilter;
    const nextProject = next.project ?? projectFilter;
    const nextType = next.type ?? typeFilter;
    const nextPerson = next.person ?? personFilter;
    if (next.time) setTimeFilter(next.time);
    if (next.project) setProjectFilter(next.project);
    if (next.type) setTypeFilter(next.type);
    if (next.person) setPersonFilter(next.person);
    if (searchSearched && searchQuery) void runSearch(searchQuery, buildFilters(nextTime, nextProject, nextType, nextPerson));
  };

  const currentCandidates = () => searchResults.slice(0, 10).map((item) => ({ id: item.id, type: item.type }));

  const handleSummary = async () => {
    const candidates = currentCandidates();
    if (candidates.length === 0) return;
    await analyzeMemory("summary", candidates);
  };

  const handleAnswer = async (event: React.FormEvent) => {
    event.preventDefault();
    const candidates = searchResults.slice(0, 10).map((item) => ({ id: item.id, type: item.type }));
    if (candidates.length === 0 || !followupQuestion.trim()) return;
    await analyzeMemory("answer", candidates, followupQuestion);
  };

  if (selectedDetail) {
    return <MemoryDetailPage detailRef={selectedDetail} onBack={() => setSelectedDetail(null)} onOpenRelation={(relation) => setSelectedDetail(relation)} />;
  }

  if (!isReady) {
    return <div className="memory-search-page"><header className="page-header"><h2>记忆库</h2></header><p className="state-loading">正在加载...</p></div>;
  }

  return (
    <div className="memory-search-page">
      <header className="page-header memory-search-page__hero">
        <div>
          <h2>记忆库</h2>
          <p className="page-header__sub">找回过去的工作、资料、决策或人。先检索，再按需用 AI 总结或回答。</p>
        </div>
        <div className="memory-search-page__principle"><strong>本地先找</strong><span>AI 只在你明确需要时回答</span></div>
      </header>

      <form className="memory-search-bar" onSubmit={handleSearch}>
        <input type="search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="搜索关键词，或直接描述你想找的记忆" className="memory-search-bar__input" aria-label="搜索记忆" />
        <button type="submit" className="primary" disabled={searchLoading || !queryInput.trim()}>{searchLoading ? "正在检索..." : "搜索"}</button>
      </form>

      {searchSearched && (
        <div className="memory-filters" aria-label="搜索过滤条件">
          <label className="memory-filters__group"><span className="memory-filters__label">时间</span><select className="memory-filters__select" value={timeFilter} onChange={(event) => updateFilter({ time: event.target.value as TimeFilter })}>{Object.entries(TIME_FILTER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="memory-filters__group"><span className="memory-filters__label">项目</span><select className="memory-filters__select" value={projectFilter} onChange={(event) => updateFilter({ project: event.target.value })}><option value="all">全部项目</option>{todayData.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label className="memory-filters__group"><span className="memory-filters__label">类型</span><select className="memory-filters__select" value={typeFilter} onChange={(event) => updateFilter({ type: event.target.value })}><option value="all">全部类型</option>{Object.entries(RESULT_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="memory-filters__group"><span className="memory-filters__label">人物</span><select className="memory-filters__select" value={personFilter} onChange={(event) => updateFilter({ person: event.target.value })}><option value="all">全部人物</option>{todayData.people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
        </div>
      )}

      {(searchError || searchExpandError || aiError) && <div className="memory-search__error">{searchError || searchExpandError || aiError}</div>}

      {searchSearched && (
        <section className="memory-results">
          <div className="memory-results__toolbar">
            <div>
              <div className="memory-results__summary">找到 {searchTotal} 条相关记忆</div>
              <div className="memory-results__query">“{searchQuery}”{searchQueryTerms.length > 0 && <span> · 本地匹配 {searchQueryTerms.slice(0, 6).join("、")}</span>}</div>
            </div>
            <div className="memory-results__actions">
              {(searchQuality === "weak" || searchQuality === "none") && <button type="button" className="memory-results__expand" onClick={() => void expandSearch(searchQuery, currentFilters)} disabled={searchExpandLoading || !searchQuery}>{searchExpandLoading ? "正在扩展..." : "扩展搜索"}</button>}
              <button type="button" className="primary memory-results__ask" onClick={() => void handleSummary()} disabled={aiLoading || searchResults.length === 0}>{aiLoading && aiMode === "summary" ? "AI总结中..." : "AI总结"}</button>
              <button type="button" className="memory-results__answer" onClick={() => setFollowupOpen((open) => !open)} disabled={aiLoading || searchResults.length === 0}>{followupOpen ? "收起追问" : "AI回答"}</button>
            </div>
          </div>

          {followupOpen && <form className="memory-followup" onSubmit={handleAnswer}>
            <input type="text" value={followupQuestion} onChange={(event) => setFollowupQuestion(event.target.value)} placeholder="针对这些结果继续提问，例如：为什么当时这样决定？" aria-label="针对检索结果提问" />
            <button type="submit" className="primary" disabled={aiLoading || !followupQuestion.trim()}>{aiLoading && aiMode === "answer" ? "AI回答中..." : "提交问题"}</button>
          </form>}

          {searchExpandedTerms.length > 0 && <div className="memory-expanded-query"><span>已按这些词扩展：</span>{searchExpandedTerms.map((term) => <strong key={term}>{term}</strong>)}<button type="button" onClick={() => void runSearch(searchQuery)}>恢复原搜索</button></div>}

          {aiResult?.ok && (
            <article className="memory-answer-card">
              <div className="memory-answer-card__eyebrow">{aiResult.mode === "summary" ? "AI总结" : "AI回答"} · 基于 {aiResult.candidateCount ?? 0} 条候选记忆</div>
              {aiResult.mode === "answer" && <h3>{followupQuestion}</h3>}
              <p className="memory-answer-card__answer">{aiResult.answer}</p>
              {aiResult.caveat && <p className="memory-answer-card__caveat">需要留意：{aiResult.caveat}</p>}
              {aiResult.sources && aiResult.sources.length > 0 && <div className="memory-answer-card__sources"><span>引用</span>{aiResult.sources.map((source, index) => <button type="button" key={`${source.type}-${source.id}`} onClick={() => setSelectedDetail({ id: source.id, type: source.type })}><small>{index + 1}</small>{source.title}</button>)}</div>}
            </article>
          )}
          {aiResult && !aiResult.ok && <div className="memory-answer-card memory-answer-card--error"><strong>{aiMode === "summary" ? "AI总结暂时不可用" : "AI回答暂时不可用"}</strong><p>{aiResult.message ?? "请稍后重试。"}</p></div>}

          {searchResults.length > 0 ? (
            <div className="memory-results__list">
              {searchResults.map((result) => (
                <SearchResultCard
                  key={`${result.type}-${result.id}`}
                  result={result}
                  onOpenDetail={handleOpenResult}
                />
              ))}
            </div>
          ) : (
            <div className="empty-state memory-search-empty"><p>没有找到匹配的记忆。</p><p className="empty-state__hint">可以调整时间或类型，也可以明确点击“扩展搜索”让模型只改写检索词。</p></div>
          )}
        </section>
      )}

      {!searchSearched && !searchError && (
        <div className="memory-search-starters">
          <p>可以这样开始</p>
          <div>{["上周研究过的工具", "某个项目当时为什么这样决定", "最近和谁讨论过发布计划"].map((example) => <button type="button" key={example} onClick={() => { setQueryInput(example); void runSearch(example); }}>{example}</button>)}</div>
        </div>
      )}
    </div>
  );
}
