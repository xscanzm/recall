// src/renderer/pages/today/TodaySidePanel.tsx
// 右侧结果面板 7 个 Section（spec 行 1554-1611，固定顺序）
//
// 1. 今日主线（MainThreadSection）
// 2. 待收尾（UnfinishedSection）
// 3. 今日成果（HighlightsSection）
// 4. 今日决策（DecisionsSection）
// 5. 我的复盘（PersonalReviewSection）
// 6. 工作日报（WorkReportSection）
// 7. 明天接着做（TomorrowSection）

import { useState } from "react";
import { Check, Clock, Copy, Pencil, RefreshCw, FileText, Edit3 } from "lucide-react";
import type { TodayPageData, PersonalReview, WorkReport } from "../../../shared/types";
import { useAppStore } from "../../state/store";
import { Button } from "../../components/Button";
import { isToday } from "./helpers";

interface TodaySidePanelProps {
  data: TodayPageData;
}

export function TodaySidePanel({ data }: TodaySidePanelProps) {
  const {
    dayMainThread,
    unfinishedThreads,
    highlights,
    decisions,
    personalReview,
    workReport,
    tomorrowStartHere,
    dateKey,
  } = data;
  const historical = !isToday(dateKey);

  return (
    <aside className="today-side-panel" aria-label="今日结果面板">
      <MainThreadSection dayMainThread={dayMainThread} historical={historical} />

      <UnfinishedSection
        threads={unfinishedThreads}
        dateKey={dateKey}
      />

      <HighlightsSection highlights={highlights} historical={historical} />

      <DecisionsSection decisions={decisions} historical={historical} />

      <PersonalReviewSection
        review={personalReview}
        dateKey={dateKey}
      />

      <WorkReportSection
        report={workReport}
        dateKey={dateKey}
      />

      <TomorrowSection items={tomorrowStartHere} />
    </aside>
  );
}

// ============================================================================
// 1. 今日主线
// ============================================================================

function MainThreadSection({ dayMainThread, historical }: { dayMainThread: string; historical: boolean }) {
  return (
    <section className="side-section">
      <h2 className="side-section__title">{historical ? "当天主线" : "今日主线"}</h2>
      <p className="side-section__text">{dayMainThread || `${historical ? "当天" : "今天"}还没有整理出主线。`}</p>
    </section>
  );
}

// ============================================================================
// 2. 待收尾（最多 3 条，超过显示"查看全部待收尾"）
// ============================================================================

function UnfinishedSection({
  threads,
  dateKey,
}: {
  threads: TodayPageData["unfinishedThreads"];
  dateKey: string;
}) {
  const setPage = useAppStore((s) => s.setPage);
  const updateUnfinishedThreadStatus = useAppStore(
    (s) => s.updateUnfinishedThreadStatus
  );

  void dateKey; // 保留以便未来按日期过滤展示

  const openThreads = threads.filter((t) => t.status === "open");
  const visible = openThreads.slice(0, 3);
  const hasMore = openThreads.length > 3;

  return (
    <section className="side-section">
      <h2 className="side-section__title">待收尾</h2>
      {visible.length === 0 ? (
        <p className="side-section__empty">{isToday(dateKey) ? "今天" : "当天"}没有待收尾的事项。</p>
      ) : (
        <ul className="unfinished-list">
          {visible.map((t) => (
            <li key={t.id} className="unfinished-item">
              <div className="unfinished-item__main">
                <p className="unfinished-item__title">{t.title}</p>
                {t.suggestedNextAction && (
                  <p className="unfinished-item__next">建议下一步：{t.suggestedNextAction}</p>
                )}
              </div>
              <div className="unfinished-item__actions">
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => updateUnfinishedThreadStatus(t.id, "done")}
                  aria-label="标记完成"
                  title="标记完成"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => updateUnfinishedThreadStatus(t.id, "snoozed")}
                  aria-label="稍后"
                  title="稍后"
                >
                  <Clock size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <button
          type="button"
          className="side-section__more"
          onClick={() => setPage("tasks")}
        >
          查看全部待收尾
        </button>
      )}
    </section>
  );
}

// ============================================================================
// 3. 今日成果（最多 4 条自用 highlights；不受对外日报 reportable 约束）
// ============================================================================

function HighlightsSection({ highlights, historical }: { highlights: TodayPageData["highlights"]; historical: boolean }) {
  const visible = highlights.slice(0, 4);
  return (
    <section className="side-section">
      <h2 className="side-section__title">{historical ? "当天成果" : "今日成果"}</h2>
      {visible.length === 0 ? (
        <p className="side-section__empty">
          {historical ? "当天" : "今天"}还没有整理出明确成果。
        </p>
      ) : (
        <ul className="highlight-list">
          {visible.map((h) => (
            <li key={h.id} className="highlight-item">
              {h.content}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ============================================================================
// 4. 今日决策（最多 3 条，可点击查看来源）
// ============================================================================

function DecisionsSection({ decisions, historical }: { decisions: TodayPageData["decisions"]; historical: boolean }) {
  const [viewingSourceFor, setViewingSourceFor] = useState<string | null>(null);
  const visible = decisions.slice(0, 3);
  const viewingDecision = viewingSourceFor
    ? decisions.find((d) => d.id === viewingSourceFor) ?? null
    : null;

  return (
    <section className="side-section">
      <h2 className="side-section__title">{historical ? "当天决策" : "今日决策"}</h2>
      {visible.length === 0 ? (
        <p className="side-section__empty">{historical ? "当天" : "今天"}还没有识别到决策。</p>
      ) : (
        <ul className="decision-list">
          {visible.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                className="decision-item"
                title="查看来源"
                onClick={() => setViewingSourceFor(d.id)}
              >
                {d.content}
              </button>
            </li>
          ))}
        </ul>
      )}
      {viewingDecision && (
        <>
          <div
            className="decision-source-modal__backdrop"
            onClick={() => setViewingSourceFor(null)}
          />
          <div
            className="decision-source-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="decision-source-modal__header">
              <span>决策来源</span>
              <button
                type="button"
                onClick={() => setViewingSourceFor(null)}
              >
                关闭
              </button>
            </div>
            <p className="decision-source-modal__content">
              {viewingDecision.content}
            </p>
            <p className="decision-source-modal__hint">
              该决策基于{" "}
              {(viewingDecision as { sourceFactIds?: string[] }).sourceFactIds
                ?.length || 0}{" "}
              条线索生成。
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// ============================================================================
// 5. 我的复盘
// ============================================================================

function PersonalReviewSection({
  review,
  dateKey,
}: {
  review: PersonalReview | undefined;
  dateKey: string;
}) {
  const generatePersonalReview = useAppStore((s) => s.generatePersonalReview);
  const generating = useAppStore((s) => s.personalReviewGenerating);
  const error = useAppStore((s) => s.personalReviewError);
  const [expanded, setExpanded] = useState(false);

  const handleGenerate = () => {
    void generatePersonalReview(dateKey);
  };

  return (
    <section className="side-section">
      <h2 className="side-section__title">我的复盘</h2>
      <p className="side-section__hint">
        给自己看的真实回顾，帮助你知道这一天做了什么、接下来从哪里继续。
      </p>
      {error && <p className="side-section__error">{error}</p>}
      {review ? (
        <div className="review-block">
          <p className="review-block__title">{review.title}</p>
          {expanded && (
            <div className="review-block__detail">
              <p>{review.overview}</p>
              {review.mainThreads && review.mainThreads.length > 0 && (
                <div className="review-block__group">
                  <span className="review-block__group-label">这一天主要在做什么</span>
                  <ul>
                    {review.mainThreads.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.meaningfulProgress.length > 0 && (
                <div className="review-block__group">
                  <span className="review-block__group-label">主要进展</span>
                  <ul>
                    {review.meaningfulProgress.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.unfinished.length > 0 && (
                <div className="review-block__group">
                  <span className="review-block__group-label">未收尾</span>
                  <ul>
                    {review.unfinished.map((u, i) => (
                      <li key={i}>{u.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {review.worthRemembering && review.worthRemembering.length > 0 && (
                <div className="review-block__group">
                  <span className="review-block__group-label">值得记住</span>
                  <ul>
                    {review.worthRemembering.map((w, i) => (
                      <li key={i}>
                        <p>{w.text}</p>
                        {w.reason && <p className="review-block__sub-text">{w.reason}</p>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {review.tomorrowStartHere && review.tomorrowStartHere.length > 0 && (
                <div className="review-block__group">
                  <span className="review-block__group-label">明天从这里继续</span>
                  <ul>
                    {review.tomorrowStartHere.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <div className="side-section__btn-row">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "收起复盘" : "查看复盘"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleGenerate}
              disabled={generating}
            >
              <RefreshCw size={13} style={{ marginRight: 4 }} />
              {generating ? "正在生成..." : "重新生成"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="primary"
          onClick={handleGenerate}
          disabled={generating}
        >
          {generating ? "正在生成我的复盘..." : "生成我的复盘"}
        </Button>
      )}
    </section>
  );
}

// ============================================================================
// 6. 工作日报
// ============================================================================

function WorkReportSection({
  report,
  dateKey,
}: {
  report: WorkReport | undefined;
  dateKey: string;
}) {
  const setWorkReportSelectionMode = useAppStore(
    (s) => s.setWorkReportSelectionMode
  );
  const todayPageData = useAppStore((s) => s.todayPageData);
  const error = useAppStore((s) => s.workReportError);
  const setPage = useAppStore((s) => s.setPage);
  const setReportsTab = useAppStore((s) => s.setReportsTab);
  const [copied, setCopied] = useState(false);

  const reportableCount = todayPageData
    ? todayPageData.timelineBlocks.filter(
        (b) => b.reportable && b.privateRisk !== "high"
      ).length
    : 0;

  const handleCopy = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      console.error("复制失败:", err);
    }
  };

  void dateKey; // 已通过 todayPageData.dateKey 使用，此处保留参数一致性

  return (
    <section className="side-section">
      <h2 className="side-section__title">工作日报</h2>
      <p className="side-section__hint">
        只使用你选择的工作片段生成，适合复制给上司或团队。
      </p>
      {error && <p className="side-section__error">{error}</p>}
      {report ? (
        <div className="report-block">
          <div className="report-block__head">
            <FileText size={14} />
            <span className="report-block__title">{report.title}</span>
          </div>
          <pre className="report-block__text">{report.plainText}</pre>
          {report.omittedForPrivacy > 0 && (
            <p className="report-block__note">
              已为你隐藏 {report.omittedForPrivacy} 个私人/敏感片段。
            </p>
          )}
          <div className="side-section__btn-row">
            <Button size="sm" variant="primary" onClick={handleCopy}>
              <Copy size={13} style={{ marginRight: 4 }} />
              {copied ? "已复制" : "复制"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setPage("reports");
                setReportsTab("work");
              }}
            >
              <Edit3 size={13} style={{ marginRight: 4 }} />
              编辑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setWorkReportSelectionMode(true)}
              disabled={reportableCount === 0}
            >
              <Pencil size={13} style={{ marginRight: 4 }} />
              重新选择片段
            </Button>
          </div>
        </div>
      ) : (
        <Button
          size="sm"
          variant="primary"
          onClick={() => setWorkReportSelectionMode(true)}
          disabled={reportableCount === 0}
        >
          选择片段生成日报
        </Button>
      )}
    </section>
  );
}

// ============================================================================
// 7. 明天接着做（最多 3 条）
// ============================================================================

function TomorrowSection({ items }: { items: string[] }) {
  const visible = items.slice(0, 3);
  return (
    <section className="side-section side-section--last">
      <h2 className="side-section__title">明天接着做</h2>
      {visible.length === 0 ? (
        <p className="side-section__empty">明天从哪里继续，晚上会自动整理。</p>
      ) : (
        <ol className="tomorrow-list">
          {visible.map((item, i) => (
            <li key={i} className="tomorrow-item">
              <span className="tomorrow-item__idx">{i + 1}</span>
              <span className="tomorrow-item__text">{item}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
