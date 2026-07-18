// src/renderer/components/ReportEditor.tsx
// 报告编辑器（来自 08 文档 "报告页" 章节）
//
// 布局：左侧正文 + 右侧来源和待确认
// 操作：编辑、删除条目、复制、重新生成、标记某条不准确
// 重要约束（来自 spec.md）：
// - 报告不直接引用截图
// - 重要条目必须保留 evidenceFactIds 或 evidenceSceneIds
// - 用户编辑后通过 reports:update IPC 保存到 content_json
// - 重新生成通过 reports:generate IPC 触发
//
// 报告 JSON 字段（日报 DailyReportOutput）：
// - headline / overview
// - projectUpdates[]：projectId/projectName/summary/evidenceFactIds/evidenceSceneIds
// - completed[]：text/confidence/evidenceFactIds
// - openTasks[]：text/status/confidence/evidenceFactIds
// - decisions[]：text/confidence/evidenceFactIds
// - risks[]：text/confidence/evidenceFactIds
// - tomorrowSuggestions[]：string
// - needsReview[]：text/reason/sourceFactIds
//
// 周报 WeeklyReportOutput 字段类似，但用 weekStart/weekEnd + nextWeekSuggestions，无 openTasks/tomorrowSuggestions/needsReview。
// 月报 MonthlyReportOutput 使用 monthStart/monthEnd + nextMonthSuggestions。

import { useEffect, useState } from "react";
import { useAppStore } from "../state/store";
import { NAMING } from "../app/naming";

// ============================================================================
// 类型定义（与 main/models/schemas.ts 保持结构一致，进程边界隔离）
// ============================================================================

export interface ReportProjectUpdate {
  projectId?: string;
  projectName: string;
  summary: string;
  evidenceFactIds: string[];
  evidenceSceneIds: string[];
  progress?: string; // 仅周报
}

export interface ReportFactEntry {
  text: string;
  confidence: number;
  evidenceFactIds: string[];
}

export interface ReportOpenTaskEntry extends ReportFactEntry {
  status: "open" | "in_progress" | "blocked" | "needs_confirmation";
}

export interface ReportNeedsReviewEntry {
  text: string;
  reason: string;
  sourceFactIds: string[];
}

export interface DailyReportContent {
  date?: string;
  headline: string;
  overview: string;
  projectUpdates: ReportProjectUpdate[];
  completed: ReportFactEntry[];
  openTasks: ReportOpenTaskEntry[];
  decisions: ReportFactEntry[];
  risks: ReportFactEntry[];
  tomorrowSuggestions: string[];
  needsReview: ReportNeedsReviewEntry[];
}

export interface WeeklyReportContent {
  weekStart: string;
  weekEnd: string;
  headline: string;
  overview: string;
  projectUpdates: ReportProjectUpdate[];
  completed: ReportFactEntry[];
  decisions: ReportFactEntry[];
  risks: ReportFactEntry[];
  nextWeekSuggestions: string[];
}

export interface MonthlyReportContent {
  monthStart: string;
  monthEnd: string;
  headline: string;
  overview: string;
  projectUpdates: ReportProjectUpdate[];
  completed: ReportFactEntry[];
  decisions: ReportFactEntry[];
  risks: ReportFactEntry[];
  nextMonthSuggestions: string[];
}

export type ReportContent =
  | DailyReportContent
  | WeeklyReportContent
  | MonthlyReportContent;

function isMonthlyContent(c: ReportContent): c is MonthlyReportContent {
  return (c as MonthlyReportContent).monthStart !== undefined;
}

function isWeeklyContent(c: ReportContent): c is WeeklyReportContent {
  return !isMonthlyContent(c) &&
    (c as WeeklyReportContent).weekStart !== undefined &&
    (c as DailyReportContent).date === undefined;
}

// ============================================================================
// ReportEditor Props
// ============================================================================

export interface ReportEditorProps {
  /** 报告 id */
  reportId: string;
  /** 报告类型 */
  type: "daily" | "weekly";
  /** 日期 key（YYYY-MM-DD） */
  dateKey: string;
  /** 报告标题（来自 reports.title） */
  title: string;
  /** content_json 字符串 */
  contentJson: string;
  /** 来源事实 ids（聚合自 content_json，用于右侧来源展示） */
  sourceFactIds?: string[];
  /** 来源场景 ids */
  sourceSceneIds?: string[];
  /** 12.5/22.11：报告来源被 soft delete 后标记为 stale（1=失效） */
  isStale?: number;
  /** 失效原因 */
  staleReason?: string | null;
  /** 失效时间 */
  staleAt?: string | null;
  /** 复制回调（由父组件提供，复制最终文本） */
  onCopy?: (text: string) => void;
  /** 重新生成回调 */
  onRegenerate?: () => void;
  /** 编辑保存回调（contentJson 由本组件构造好后传出） */
  onSave?: (contentJson: string) => Promise<void> | void;
  /** 删除单条目回调（用于"标记不准确"等操作） */
  onDeleteEntry?: (section: string, index: number) => Promise<void> | void;
}

// ============================================================================
// ReportEditor 主组件
// ============================================================================

export function ReportEditor(props: ReportEditorProps) {
  const { reportId, type, dateKey, title, contentJson, sourceFactIds = [], sourceSceneIds = [] } = props;
  const [content, setContent] = useState<ReportContent | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editedJson, setEditedJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  // 12.5/22.11：报告 stale 标志（来源被 soft delete）
  const isReportStale = props.isStale === 1;

  // 来源跳转相关 store action
  const setPage = useAppStore((s) => s.setPage);
  const searchMemory = useAppStore((s) => s.searchMemory);

  // 跳转到记忆库并搜索指定 factId（来自 Checkpoint 10.12）
  const handleJumpToFact = (factId: string) => {
    setPage("memory");
    void searchMemory(factId);
  };

  // 跳转到记忆库并搜索指定 sceneId
  const handleJumpToScene = (sceneId: string) => {
    setPage("memory");
    void searchMemory(sceneId);
  };

  // 解析 content_json
  useEffect(() => {
    try {
      const parsed = JSON.parse(contentJson) as ReportContent;
      setContent(parsed);
      setEditedJson(contentJson);
      setParseError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setParseError(`报告内容解析失败：${message}`);
      setContent(null);
    }
  }, [contentJson]);

  // 复制为纯文本（适合粘贴到工作汇报）
  const handleCopy = () => {
    if (!content) return;
    const text = formatReportAsText(content, title, dateKey);
    props.onCopy?.(text);
  };

  // 进入编辑模式
  const handleEnterEdit = () => {
    setEditMode(true);
    setEditedJson(contentJson);
    setSaveError(null);
  };

  // 取消编辑
  const handleCancelEdit = () => {
    setEditMode(false);
    setEditedJson(contentJson);
    setSaveError(null);
  };

  // 保存编辑
  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // 校验 JSON 合法性
      JSON.parse(editedJson);
      await props.onSave?.(editedJson);
      setEditMode(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  // 删除某条目
  const handleDeleteEntry = async (section: string, index: number) => {
    if (!props.onDeleteEntry) return;
    try {
      await props.onDeleteEntry(section, index);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
    }
  };

  if (parseError) {
    return (
      <div className="report-editor">
        <div className="report-editor__error">
          <p>{parseError}</p>
        </div>
      </div>
    );
  }

  if (!content) {
    return (
      <div className="report-editor">
        <p className="state-loading">正在加载报告内容...</p>
      </div>
    );
  }

  const isWeekly = isWeeklyContent(content);
  const factCount = sourceFactIds.length;
  const sceneCount = sourceSceneIds.length;
  const totalEvidence = factCount + sceneCount;

  return (
    <div className="report-editor">
      <header className="report-editor__header">
        <div className="report-editor__title-group">
          <span className="report-editor__type-badge">{isWeekly ? "周报" : "日报"}</span>
          <h2 className="report-editor__title">{content.headline || title}</h2>
          <span className="report-editor__date">{dateKey}</span>
        </div>
        <div className="report-editor__actions">
          <button onClick={handleCopy} disabled={!content}>复制</button>
          {!editMode ? (
            <button onClick={handleEnterEdit}>编辑</button>
          ) : (
            <>
              <button className="primary" onClick={handleSave} disabled={saving}>
                {saving ? "保存中..." : "保存"}
              </button>
              <button onClick={handleCancelEdit} disabled={saving}>取消</button>
            </>
          )}
          {props.onRegenerate && (
            <button onClick={props.onRegenerate} disabled={editMode}>重新生成</button>
          )}
        </div>
      </header>

      {saveError && (
        <div className="report-editor__error">
          <p>保存失败：{saveError}</p>
        </div>
      )}

      {/* 12.5/22.11：stale 报告横幅 - 部分来源已被删除，建议重新生成 */}
      {isReportStale && !editMode && (
        <div className="report-editor__stale-banner">
          <div className="report-editor__stale-banner-text">
            <span className="report-editor__stale-banner-title">该报告的部分来源已被删除</span>
            <span className="report-editor__stale-banner-hint">
              建议重新生成以避免引用失效数据
              {props.staleReason ? `（原因：${props.staleReason}）` : ""}
            </span>
          </div>
          {props.onRegenerate && (
            <button
              type="button"
              className="report-editor__stale-banner-btn"
              onClick={props.onRegenerate}
              disabled={editMode}
            >
              重新生成
            </button>
          )}
        </div>
      )}

      {!editMode ? (
        <div className="report-editor__body">
          {/* 左侧：报告正文 */}
          <div className="report-editor__content">
            <section className="report-section">
              <h4 className="report-section__title">概览</h4>
              <p className="report-section__text">{content.overview}</p>
            </section>

            {content.projectUpdates.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">项目进展</h4>
                <div className="report-section__list">
                  {content.projectUpdates.map((p, idx) => (
                    <div key={`proj-${idx}`} className="report-entry">
                      <div className="report-entry__header">
                        <span className="report-entry__title">{p.projectName}</span>
                        {p.evidenceFactIds.length + p.evidenceSceneIds.length > 0 && (
                          <span className="report-entry__evidence-count">
                            来源 {p.evidenceFactIds.length + p.evidenceSceneIds.length} 条
                          </span>
                        )}
                      </div>
                      <p className="report-entry__text">{p.summary}</p>
                      {p.progress && (
                        <p className="report-entry__meta">进展：{p.progress}</p>
                      )}
                      <EvidenceList factIds={p.evidenceFactIds} sceneIds={p.evidenceSceneIds} />
                      <DeleteEntryButton
                        section="projectUpdates"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {content.completed.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">已完成</h4>
                <div className="report-section__list">
                  {content.completed.map((c, idx) => (
                    <div key={`done-${idx}`} className="report-entry">
                      <div className="report-entry__header">
                        <span className="report-entry__text">{c.text}</span>
                      </div>
                      <EvidenceList factIds={c.evidenceFactIds} />
                      <DeleteEntryButton
                        section="completed"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!isWeekly && (content as DailyReportContent).openTasks.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">进行中任务</h4>
                <div className="report-section__list">
                  {(content as DailyReportContent).openTasks.map((t, idx) => (
                    <div key={`task-${idx}`} className="report-entry">
                      <div className="report-entry__header">
                        <span className="report-entry__text">{t.text}</span>
                        <span className="report-entry__status">{taskStatusLabel(t.status)}</span>
                      </div>
                      <EvidenceList factIds={t.evidenceFactIds} />
                      <DeleteEntryButton
                        section="openTasks"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {content.decisions.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">关键决策</h4>
                <div className="report-section__list">
                  {content.decisions.map((d, idx) => (
                    <div key={`dec-${idx}`} className="report-entry">
                      <div className="report-entry__header">
                        <span className="report-entry__text">{d.text}</span>
                      </div>
                      <EvidenceList factIds={d.evidenceFactIds} />
                      <DeleteEntryButton
                        section="decisions"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {content.risks.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">风险与阻塞</h4>
                <div className="report-section__list">
                  {content.risks.map((r, idx) => (
                    <div key={`risk-${idx}`} className="report-entry">
                      <div className="report-entry__header">
                        <span className="report-entry__text">{r.text}</span>
                      </div>
                      <EvidenceList factIds={r.evidenceFactIds} />
                      <DeleteEntryButton
                        section="risks"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {!isWeekly && (content as DailyReportContent).tomorrowSuggestions.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">明日建议</h4>
                <ul className="report-section__bullets">
                  {(content as DailyReportContent).tomorrowSuggestions.map((s, idx) => (
                    <li key={`tom-${idx}`}>{s}</li>
                  ))}
                </ul>
              </section>
            )}

            {isWeekly && (content as WeeklyReportContent).nextWeekSuggestions.length > 0 && (
              <section className="report-section">
                <h4 className="report-section__title">下周建议</h4>
                <ul className="report-section__bullets">
                  {(content as WeeklyReportContent).nextWeekSuggestions.map((s, idx) => (
                    <li key={`next-${idx}`}>{s}</li>
                  ))}
                </ul>
              </section>
            )}

            {!isWeekly && (content as DailyReportContent).needsReview.length > 0 && (
              <section className="report-section report-section--warning">
                <h4 className="report-section__title">待确认</h4>
                <p className="report-section__hint">
                  以下内容已从正式条目中分离。请确认是否准确。
                </p>
                <div className="report-section__list">
                  {(content as DailyReportContent).needsReview.map((n, idx) => (
                    <div key={`review-${idx}`} className="report-entry report-entry--warning">
                      <div className="report-entry__header">
                        <span className="report-entry__text">{n.text}</span>
                      </div>
                      <p className="report-entry__meta">原因：{n.reason}</p>
                      <EvidenceList factIds={n.sourceFactIds} />
                      <DeleteEntryButton
                        section="needsReview"
                        index={idx}
                        onDelete={handleDeleteEntry}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* 右侧：来源与待确认 */}
          <aside className="report-editor__side">
            <h5 className="report-side__title">来源与待确认</h5>
            <div className="report-side__stats">
              <div className="report-side__stat">
                <span className="report-side__stat-label">事实</span>
                <span className="report-side__stat-value">{factCount}</span>
              </div>
              <div className="report-side__stat">
                <span className="report-side__stat-label">场景</span>
                <span className="report-side__stat-value">{sceneCount}</span>
              </div>
              <div className="report-side__stat">
                <span className="report-side__stat-label">证据总计</span>
                <span className="report-side__stat-value">{totalEvidence}</span>
              </div>
            </div>

            <button
              type="button"
              className="report-side__view-source-btn"
              title="点击查看来源详情"
            >
              查看来源
            </button>

            {!isWeekly && (content as DailyReportContent).needsReview.length > 0 && (
              <div className="report-side__group report-side__group--warning">
                <h6 className="report-side__group-title">待确认条目</h6>
                <p className="report-side__group-hint">
                  {(content as DailyReportContent).needsReview.length} 条内容需要您确认。
                </p>
              </div>
            )}

            {totalEvidence === 0 && (
              <p className="report-side__empty">
                本报告未关联来源。重要条目通常会显示来源事实或场景。
              </p>
            )}
          </aside>
        </div>
      ) : (
        <div className="report-editor__edit">
          <p className="report-editor__edit-hint">
            直接编辑 JSON 内容。保存后会写入 reports.content_json。修改不影响已关联的来源 ids。
          </p>
          <textarea
            className="report-editor__textarea"
            value={editedJson}
            onChange={(e) => setEditedJson(e.target.value)}
            spellCheck={false}
            disabled={saving}
          />
        </div>
      )}

      <style>{`
        .report-editor {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .report-editor__header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          flex-wrap: wrap;
        }
        .report-editor__title-group {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
          min-width: 0;
        }
        .report-editor__type-badge {
          display: inline-block;
          align-self: flex-start;
          padding: 2px 8px;
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-pill);
          font-size: 11px;
          color: var(--recall-text-muted);
          margin-bottom: 2px;
        }
        .report-editor__title {
          font-size: 18px;
          font-weight: 600;
          color: var(--recall-text);
          margin: 0;
        }
        .report-editor__date {
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .report-editor__actions {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .report-editor__body {
          display: grid;
          grid-template-columns: 2fr 1fr;
          gap: 16px;
        }
        @media (max-width: 960px) {
          .report-editor__body {
            grid-template-columns: 1fr;
          }
        }
        .report-editor__content {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 16px;
          min-height: 320px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .report-editor__side {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 16px;
          align-self: start;
        }
        .report-editor__error {
          background-color: #fbeeeb;
          border: 1px solid var(--recall-danger);
          border-radius: var(--radius-md);
          padding: 12px 16px;
          color: var(--recall-danger);
          font-size: 13px;
        }
        .report-editor__stale-banner {
          background-color: rgba(217, 145, 43, 0.08);
          border: 1px solid var(--recall-amber);
          border-radius: var(--radius-md);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }
        .report-editor__stale-banner-text {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
          min-width: 0;
        }
        .report-editor__stale-banner-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--recall-amber);
        }
        .report-editor__stale-banner-hint {
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .report-editor__stale-banner-btn {
          padding: 6px 14px;
          background-color: var(--recall-amber);
          border: 1px solid var(--recall-amber);
          border-radius: var(--radius-pill);
          color: #fff;
          font-size: 12px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .report-editor__stale-banner-btn:hover {
          background-color: #c4821f;
        }
        .report-editor__stale-banner-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .report-editor__edit {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .report-editor__edit-hint {
          font-size: 12px;
          color: var(--recall-text-muted);
          margin: 0;
        }
        .report-editor__textarea {
          width: 100%;
          min-height: 400px;
          font-family: ui-monospace, "Cascadia Code", "Consolas", monospace;
          font-size: 12px;
          padding: 12px;
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          background-color: var(--recall-surface);
          color: var(--recall-text);
          resize: vertical;
        }

        .report-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .report-section--warning {
          background-color: #fff8e8;
          border: 1px solid var(--recall-amber);
          border-radius: var(--radius-md);
          padding: 12px;
        }
        .report-section__title {
          font-size: 13px;
          font-weight: 600;
          color: var(--recall-text);
          margin: 0;
        }
        .report-section__text {
          margin: 0;
          font-size: 13px;
          color: var(--recall-text-muted);
          line-height: 1.6;
          white-space: pre-wrap;
        }
        .report-section__hint {
          font-size: 12px;
          color: var(--recall-text-muted);
          margin: 0;
        }
        .report-section__list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .report-section__bullets {
          margin: 0;
          padding-left: 20px;
          font-size: 13px;
          color: var(--recall-text-muted);
          line-height: 1.6;
        }

        .report-entry {
          padding: 8px 0;
          border-bottom: 1px solid var(--recall-border);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .report-entry:last-child {
          border-bottom: none;
        }
        .report-entry--warning {
          background-color: rgba(217, 145, 43, 0.05);
          padding: 8px;
          border-radius: var(--radius-md);
          border: 1px solid rgba(217, 145, 43, 0.2);
        }
        .report-entry__header {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .report-entry__title {
          font-size: 14px;
          font-weight: 500;
          color: var(--recall-text);
        }
        .report-entry__text {
          font-size: 13px;
          color: var(--recall-text);
          flex: 1;
        }
        .report-entry__meta {
          font-size: 12px;
          color: var(--recall-text-muted);
          margin: 0;
        }
        .report-entry__evidence-count {
          font-size: 11px;
          color: var(--recall-text-muted);
          padding: 1px 6px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-pill);
        }
        .report-entry__status {
          font-size: 11px;
          padding: 1px 6px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-pill);
          color: var(--recall-text-muted);
        }
        .report-entry__evidence {
          font-size: 11px;
          color: var(--recall-text-muted);
          margin: 0;
        }
        .report-entry__delete {
          align-self: flex-start;
          font-size: 11px;
          padding: 2px 8px;
          background-color: transparent;
          border: 1px solid var(--recall-border);
          color: var(--recall-text-muted);
          border-radius: var(--radius-pill);
          cursor: pointer;
        }
        .report-entry__delete:hover {
          color: var(--recall-danger);
          border-color: var(--recall-danger);
        }

        .report-side__title {
          margin: 0 0 12px 0;
          font-size: 13px;
          color: var(--recall-text);
        }
        .report-side__stats {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .report-side__stat {
          flex: 1;
          padding: 8px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-md);
          text-align: center;
        }
        .report-side__stat-label {
          display: block;
          font-size: 10px;
          color: var(--recall-text-muted);
          margin-bottom: 2px;
        }
        .report-side__stat-value {
          display: block;
          font-size: 16px;
          font-weight: 600;
          color: var(--recall-text);
        }
        .report-side__group {
          margin-bottom: 12px;
        }
        .report-side__group--warning {
          padding: 8px;
          background-color: rgba(217, 145, 43, 0.1);
          border-radius: var(--radius-md);
        }
        .report-side__group-title {
          margin: 0 0 4px 0;
          font-size: 12px;
          color: var(--recall-text);
        }
        .report-side__group-hint {
          margin: 0;
          font-size: 11px;
          color: var(--recall-text-muted);
        }
        .report-side__empty {
          font-size: 12px;
          color: var(--recall-text-muted);
          margin: 0;
        }
      `}</style>
    </div>
  );
}

// ============================================================================
// 子组件
// ============================================================================

function EvidenceList({ factIds, sceneIds }: { factIds: string[]; sceneIds?: string[] }) {
  if (factIds.length === 0 && (!sceneIds || sceneIds.length === 0)) return null;
  const parts: string[] = [];
  if (factIds.length > 0) parts.push(`事实 ${factIds.length}`);
  if (sceneIds && sceneIds.length > 0) parts.push(`场景 ${sceneIds.length}`);
  return <p className="report-entry__evidence">来源：{parts.join("，")}</p>;
}

function DeleteEntryButton({
  section,
  index,
  onDelete,
}: {
  section: string;
  index: number;
  onDelete: (section: string, index: number) => Promise<void> | void;
}) {
  return (
    <button
      className="report-entry__delete"
      onClick={() => void onDelete(section, index)}
      title="标记不准确或删除此条目"
    >
      标记不准确
    </button>
  );
}

// ============================================================================
// 辅助函数
// ============================================================================

function taskStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    open: "未开始",
    in_progress: "进行中",
    blocked: "阻塞",
    needs_confirmation: "待确认",
  };
  return labels[status] ?? status;
}

/**
 * 将报告格式化为可复制的纯文本（适合粘贴到工作汇报）
 */
export function formatReportAsText(
  content: ReportContent,
  title: string,
  dateKey: string,
  reportType?: "daily" | "weekly" | "monthly"
): string {
  const lines: string[] = [];
  const isMonthly = reportType === "monthly" || isMonthlyContent(content);
  const isWeekly = !isMonthly && (reportType === "weekly" || isWeeklyContent(content));

  lines.push(`# ${content.headline || title}`);
  if (isMonthly) {
    const m = content as MonthlyReportContent;
    const legacy = content as unknown as WeeklyReportContent;
    const monthStart = m.monthStart || legacy.weekStart || dateKey;
    const monthEnd = m.monthEnd || legacy.weekEnd || dateKey;
    lines.push(`月份：${monthStart} ~ ${monthEnd}`);
  } else {
    lines.push(`日期：${dateKey}`);
    if (isWeekly) {
      const w = content as WeeklyReportContent;
      lines.push(`周期：${w.weekStart} ~ ${w.weekEnd}`);
    }
  }
  lines.push("");
  lines.push("## 概览");
  lines.push(content.overview);
  lines.push("");

  if (content.projectUpdates.length > 0) {
    lines.push("## 项目进展");
    content.projectUpdates.forEach((p) => {
      lines.push(`### ${p.projectName}`);
      lines.push(p.summary);
      if (p.progress) lines.push(`进展：${p.progress}`);
      lines.push("");
    });
  }

  if (content.completed.length > 0) {
    lines.push("## 已完成");
    content.completed.forEach((c) => {
      lines.push(`- ${c.text}`);
    });
    lines.push("");
  }

  if (!isWeekly && !isMonthly) {
    const d = content as DailyReportContent;
    if (d.openTasks.length > 0) {
      lines.push("## 进行中任务");
      d.openTasks.forEach((t) => {
        lines.push(`- [${taskStatusLabel(t.status)}] ${t.text}`);
      });
      lines.push("");
    }
  }

  if (content.decisions.length > 0) {
    lines.push("## 关键决策");
    content.decisions.forEach((d) => {
      lines.push(`- ${d.text}`);
    });
    lines.push("");
  }

  if (content.risks.length > 0) {
    lines.push("## 风险与阻塞");
    content.risks.forEach((r) => {
      lines.push(`- ${r.text}`);
    });
    lines.push("");
  }

  if (isMonthly) {
    const m = content as MonthlyReportContent;
    const legacy = content as unknown as WeeklyReportContent;
    const suggestions = m.nextMonthSuggestions ?? legacy.nextWeekSuggestions ?? [];
    if (suggestions.length > 0) {
      lines.push("## 下月重点");
      suggestions.forEach((s) => lines.push(`- ${s}`));
      lines.push("");
    }
  } else if (isWeekly) {
    const w = content as WeeklyReportContent;
    if (w.nextWeekSuggestions.length > 0) {
      lines.push("## 下周建议");
      w.nextWeekSuggestions.forEach((s) => lines.push(`- ${s}`));
      lines.push("");
    }
  } else {
    const d = content as DailyReportContent;
    if (d.tomorrowSuggestions.length > 0) {
      lines.push("## 明日建议");
      d.tomorrowSuggestions.forEach((s) => lines.push(`- ${s}`));
      lines.push("");
    }
    if (d.needsReview.length > 0) {
      lines.push("## 待确认");
      d.needsReview.forEach((n) => {
        lines.push(`- ${n.text}（原因：${n.reason}）`);
      });
      lines.push("");
    }
  }

  return lines.join("\n");
}
