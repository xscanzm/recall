// src/renderer/pages/MemorySearchPage.tsx
// 记忆库搜索页 + 轻量问答（来自 08 文档和 spec.md "历史查询与轻量问答"章节）
//
// 搜索输入：关键词（AND 语义）
// 结果类型：Fact / Scene / Task / Project / Decision / Report / Person
// 每条结果显示：类型 / 标题摘要 / 时间 / 项目 / 来源跳转
//
// 轻量问答（来自 spec.md "第一版轻量问答"）：
// - 自然语言输入
// - 检索相关 facts/scenes/reports
// - LLM 基于检索结果回答
// - 回答必须列出来源对象
// - 聊天只是查询入口，不作为主界面
//
// 重要约束：
// - 不使用 emoji
// - 中文注释
// - 不暴露 L0/L1/L2/L3 术语
// - 前台使用 线索/工作片段/任务/项目/决策/日报 命名

import { useState, useMemo } from "react";
import { useAppStore, type SearchResultItem, type AskSourceItem } from "../state/store";
import { CorrectionDialog } from "../components/CorrectionDialog";
import type { FeedbackTargetType } from "../state/store";
import { NAMING } from "../app/naming";

/**
 * 搜索结果类型 -> 前台标签（来自 NAMING）
 */
const RESULT_TYPE_LABELS: Record<SearchResultItem["type"], string> = {
  fact: NAMING.fact,
  scene: NAMING.scene,
  task: NAMING.task,
  project: NAMING.project,
  decision: NAMING.decision,
  report: NAMING.dailyReport,
  person: NAMING.person,
};

/**
 * 搜索结果类型 -> 颜色
 */
const RESULT_TYPE_COLORS: Record<SearchResultItem["type"], string> = {
  fact: "#2f8f83",       // green
  scene: "#66706d",      // neutral
  task: "#2f8f83",       // green
  project: "#66706d",    // neutral
  decision: "#d9912b",   // amber
  report: "#66706d",     // neutral
  person: "#66706d",     // neutral
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

export function MemorySearchPage() {
  const isReady = useAppStore((s) => s.isReady);
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
    // 提交后清空输入框，避免重复提交
    setAskInput("");
  };

  // 来源跳转：根据 sourceType 跳转到对应页面
  const handleViewSource = (item: SearchResultItem) => {
    if (!item.sourceType || !item.sourceId) {
      // 没有具体来源时，按结果类型跳转
      if (item.type === "task") setPage("tasks");
      else if (item.type === "project") setPage("projects");
      else if (item.type === "report") setPage("reports");
      else if (item.type === "decision") setPage("projects");
      return;
    }
    // 设置待跳转的源记录 ID 和类型（在切换页面前设置，确保目标页能拿到）
    setPendingJump(item.sourceId, item.sourceType);
    // 根据 sourceType 跳转
    if (item.sourceType === "observation") {
      // 观察数据不在主页面展示，跳转到今日页
      setPage("today");
    } else if (item.sourceType === "fact") {
      // 留在当前页（线索可继续查看）
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

  // 结果分组（按类型分组方便查看）
  const groupedResults = useMemo(() => {
    const groups: Record<string, SearchResultItem[]> = {};
    for (const r of searchResults) {
      if (!groups[r.type]) groups[r.type] = [];
      groups[r.type].push(r);
    }
    return groups;
  }, [searchResults]);

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
          搜索 Recall 沉淀的线索、工作片段、任务、项目、决策和报告。也可以用自然语言提问，Recall 会基于检索到的内容回答。
        </p>
      </header>

      {/* 搜索区 */}
      <form className="search-bar" onSubmit={handleSearch}>
        <input
          type="text"
          value={queryInput}
          onChange={(e) => setQueryInput(e.target.value)}
          placeholder="搜索关键词，例如项目名、人名或主题（多个关键词用空格分隔，需全部匹配）"
          className="search-bar__input"
        />
        <button type="submit" className="primary" disabled={searchLoading || !queryInput.trim()}>
          {searchLoading ? "搜索中..." : "搜索"}
        </button>
      </form>

      {/* 搜索结果区 */}
      {searchError && <p className="search-error">{searchError}</p>}

      {searchSearched && searchResults.length === 0 && !searchError && (
        <div className="empty-state">
          <p>没有找到匹配的记忆。</p>
          <p className="empty-state__hint">试试其他关键词，或等待 Recall 沉淀更多内容。</p>
        </div>
      )}

      {searchResults.length > 0 && (
        <div className="search-results-wrap">
          <div className="search-results-summary">
            共 {searchResults.length} 条结果
            {searchQuery && <span className="search-results-query">关键词：{searchQuery}</span>}
          </div>
          {Object.entries(groupedResults).map(([type, items]) => (
            <div key={type} className="search-results-group">
              <h4 className="search-results-group__title">
                {RESULT_TYPE_LABELS[type as SearchResultItem["type"]] ?? type}
                <span className="search-results-group__count">({items.length})</span>
              </h4>
              <ul className="search-results">
                {items.map((r) => (
                  <li key={`${r.type}-${r.id}`} className="search-result">
                    <div
                      className="search-result__type"
                      style={{ color: RESULT_TYPE_COLORS[r.type] ?? "#66706d" }}
                    >
                      {RESULT_TYPE_LABELS[r.type] ?? r.type}
                    </div>
                    <div className="search-result__main">
                      <div className="search-result__title">{r.title}</div>
                      {r.summary && <div className="search-result__summary">{r.summary}</div>}
                      <div className="search-result__meta">
                        <span>{new Date(r.createdAt).toLocaleString("zh-CN")}</span>
                        {r.projectName && (
                          <span className="search-result__project">{r.projectName}</span>
                        )}
                      </div>
                    </div>
                    <div className="search-result__actions">
                      {(r.sourceType || r.sourceId) && (
                        <button
                          type="button"
                          onClick={() => handleViewSource(r)}
                          title="查看来源"
                          className="search-result__action-btn"
                        >
                          来源
                        </button>
                      )}
                      {toCorrectionTargetType(r.type) && (
                        <button
                          type="button"
                          onClick={() => handleCorrect(r)}
                          title="纠错"
                          className="search-result__action-btn"
                        >
                          纠错
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {!searchSearched && !searchError && (
        <div className="empty-state">
          <p>输入关键词搜索记忆。</p>
          <p className="empty-state__hint">
            结果会显示类型、标题摘要、时间、项目和来源跳转。
          </p>
        </div>
      )}

      {/* 轻量问答区（来自 spec.md "历史查询与轻量问答"） */}
      {/* 重要约束：聊天只是查询入口，不作为主界面 */}
      <section className="ask-section">
        <h3 className="ask-section__title">轻量问答</h3>
        <p className="ask-section__hint">
          用自然语言提问，Recall 会基于检索到的线索、工作片段和报告回答。回答会列出来源对象。
        </p>
        <form className="ask-bar" onSubmit={handleAsk}>
          <input
            type="text"
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            placeholder="例如：我昨天关于 Recall 定了什么？上周还有哪些没完成？某个项目最近进展是什么？"
            className="ask-bar__input"
          />
          <button type="submit" className="primary" disabled={askLoading || !askInput.trim()}>
            {askLoading ? "思考中..." : "提问"}
          </button>
        </form>

        {askError && <p className="search-error">{askError}</p>}

        {askResult && (
          <div className="ask-result">
            {askResult.ok ? (
              <>
                <div className="ask-result__question">
                  <span className="ask-result__label">问：</span>
                  {askQuestion}
                </div>
                {askResult.answer && (
                  <div className="ask-result__answer">
                    <span className="ask-result__label">答：</span>
                    <div className="ask-result__answer-text">{askResult.answer}</div>
                  </div>
                )}
                {askResult.sources && askResult.sources.length > 0 && (
                  <div className="ask-result__sources">
                    <div className="ask-result__sources-title">
                      来源对象（{askResult.sources.length} 条）
                      {typeof askResult.searchCount === "number" && (
                        <span className="ask-result__search-count">
                          检索范围 {askResult.searchCount} 条
                        </span>
                      )}
                    </div>
                    <ul className="ask-sources">
                      {askResult.sources.map((s, idx) => (
                        <li
                          key={`${s.type}-${s.id}-${idx}`}
                          className="ask-source"
                          onClick={() => handleSourceClick(s)}
                        >
                          <span
                            className="ask-source__type"
                            style={{ color: RESULT_TYPE_COLORS[s.type] ?? "#66706d" }}
                          >
                            {ASK_SOURCE_TYPE_LABELS[s.type] ?? s.type}
                          </span>
                          <div className="ask-source__main">
                            <div className="ask-source__title">{s.title}</div>
                            {s.summary && <div className="ask-source__summary">{s.summary}</div>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <div className="ask-result__error">
                <p>回答失败：{askResult.message ?? askResult.code ?? "未知错误"}</p>
                <p className="ask-result__error-hint">
                  可能是模型未配置或检索为空。请先在设置页配置语言模型，或换一种问法。
                </p>
              </div>
            )}
          </div>
        )}

        {!askResult && !askError && !askLoading && (
          <p className="ask-empty">还没有提问。可以试试上面的示例问题。</p>
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
            // 纠错后重新执行一次最近搜索，确保 UI 同步
            if (searchQuery) {
              void searchMemory(searchQuery);
            }
          }}
        />
      )}

      <style>{`
        .memory-search-page {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .search-bar {
          display: flex;
          gap: 8px;
        }
        .search-bar__input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          font-family: inherit;
          font-size: 14px;
        }
        .search-bar__input:focus {
          outline: none;
          border-color: var(--accent-green);
        }
        .search-error {
          color: var(--danger);
          font-size: 13px;
          margin: 0;
        }
        .search-results-wrap {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .search-results-summary {
          font-size: 12px;
          color: var(--text-secondary);
          display: flex;
          gap: 12px;
          align-items: center;
        }
        .search-results-query {
          font-style: italic;
        }
        .search-results-group {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .search-results-group__title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary);
          margin: 8px 0 4px 0;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .search-results-group__count {
          font-weight: 400;
          opacity: 0.7;
        }
        .search-results {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .search-result {
          display: flex;
          gap: 12px;
          padding: 10px 14px;
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
        }
        .search-result:hover {
          background-color: #f0eee7;
        }
        .search-result__type {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--border);
          background-color: var(--bg);
          height: fit-content;
          font-weight: 500;
          white-space: nowrap;
        }
        .search-result__main {
          flex: 1;
          min-width: 0;
        }
        .search-result__title {
          font-weight: 500;
          margin-bottom: 4px;
          font-size: 13px;
          line-height: 1.5;
        }
        .search-result__summary {
          font-size: 12px;
          color: var(--text-secondary);
          margin-bottom: 4px;
          line-height: 1.6;
        }
        .search-result__meta {
          display: flex;
          gap: 12px;
          font-size: 11px;
          color: var(--text-secondary);
          flex-wrap: wrap;
        }
        .search-result__project {
          color: var(--accent-green);
        }
        .search-result__actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
          align-items: flex-start;
        }
        .search-result__action-btn {
          font-size: 11px;
          padding: 4px 8px;
          border: 1px solid var(--border);
          background-color: var(--surface);
          cursor: pointer;
        }
        .search-result__action-btn:hover {
          background-color: #f0eee7;
        }
        .empty-state {
          padding: 24px;
          text-align: center;
          color: var(--text-secondary);
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
        }
        .empty-state p {
          margin: 0 0 6px 0;
          font-size: 13px;
        }
        .empty-state__hint {
          font-size: 12px !important;
          opacity: 0.8;
        }
        /* 轻量问答区 */
        .ask-section {
          margin-top: 16px;
          padding: 16px;
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
        }
        .ask-section__title {
          font-size: 14px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .ask-section__hint {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0 0 10px 0;
          line-height: 1.6;
        }
        .ask-bar {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .ask-bar__input {
          flex: 1;
          padding: 8px 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          font-family: inherit;
          font-size: 13px;
        }
        .ask-bar__input:focus {
          outline: none;
          border-color: var(--accent-green);
        }
        .ask-result {
          border-top: 1px dashed var(--border);
          padding-top: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .ask-result__question,
        .ask-result__answer {
          font-size: 13px;
          line-height: 1.6;
          display: flex;
          gap: 6px;
        }
        .ask-result__label {
          font-weight: 600;
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .ask-result__answer-text {
          flex: 1;
          white-space: pre-wrap;
          color: var(--text-primary);
        }
        .ask-result__sources {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .ask-result__sources-title {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary);
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .ask-result__search-count {
          font-weight: 400;
          opacity: 0.7;
          font-style: italic;
        }
        .ask-sources {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ask-source {
          display: flex;
          gap: 10px;
          padding: 8px 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-button);
          cursor: pointer;
          background-color: var(--bg);
        }
        .ask-source:hover {
          background-color: #f0eee7;
        }
        .ask-source__type {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--border);
          background-color: var(--surface);
          height: fit-content;
          font-weight: 500;
          white-space: nowrap;
        }
        .ask-source__main {
          flex: 1;
          min-width: 0;
        }
        .ask-source__title {
          font-size: 13px;
          font-weight: 500;
          margin-bottom: 2px;
        }
        .ask-source__summary {
          font-size: 12px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .ask-result__error {
          color: var(--danger);
          font-size: 13px;
        }
        .ask-result__error p {
          margin: 0 0 4px 0;
        }
        .ask-result__error-hint {
          font-size: 12px !important;
          color: var(--text-secondary);
          opacity: 0.8;
        }
        .ask-empty {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 8px 0 0 0;
          text-align: center;
          padding: 12px;
          border: 1px dashed var(--border);
          border-radius: var(--radius-button);
        }
      `}</style>
    </div>
  );
}
