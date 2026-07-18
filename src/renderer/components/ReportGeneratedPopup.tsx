import { useEffect, useRef, useState } from "react";
import type { ReportGeneratedEvent } from "../../shared/types";
import { getIpc } from "../state/ipc";
import "./EndOfDayReviewPopup.css";

const DISPLAY_MS = 25_000;

function reportTypeLabel(type: string): string {
  switch (type) {
    case "personal_daily_review":
      return "我的复盘";
    case "work_daily_report":
      return "工作日报";
    case "daily":
      return "日报";
    case "weekly":
      return "周报";
    case "monthly":
      return "月报";
    default:
      return "报告";
  }
}

function formatDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

export function ReportGeneratedPopup() {
  const [report, setReport] = useState<ReportGeneratedEvent | null>(null);
  const [remaining, setRemaining] = useState(DISPLAY_MS);
  const paused = useRef(false);

  useEffect(() => {
    let active = true;
    void getIpc().reports.getNotification().then((value) => {
      if (!active) return;
      if (!value) {
        void getIpc().reports.dismissNotification();
        return;
      }
      setReport(value);
    }).catch(() => {
      void getIpc().reports.dismissNotification();
    });
    const timer = window.setInterval(() => {
      if (!paused.current) setRemaining((value) => Math.max(0, value - 250));
    }, 250);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (remaining === 0) void getIpc().reports.dismissNotification();
  }, [remaining]);

  if (!report) return null;

  const label = reportTypeLabel(report.type);

  return (
    <main
      className="end-day-card report-notice-card"
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
    >
      <header className="end-day-card__header">
        <div className="end-day-card__masthead">
          <span className="end-day-card__mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="end-day-card__eyebrow">RECALL / NEW REPORT</span>
        </div>
        <button
          className="end-day-card__close"
          aria-label="关闭报告通知"
          onClick={() => void getIpc().reports.dismissNotification()}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="end-day-card__intro">
        <p className="end-day-card__kicker">REPORT READY</p>
        <h1>{label}已生成</h1>
        <p>正文已经完成，打开报告页查看完整内容与信息图。</p>
      </div>

      <div className="end-day-card__rule" aria-hidden="true" />

      <section className="end-day-card__section">
        <div className="end-day-card__section-heading">
          <span className="end-day-card__section-label"><span className="end-day-card__check" aria-hidden="true">✓</span>报告标题</span>
          <span className="end-day-card__count">新</span>
        </div>
        <p className="report-notice__value">{report.title}</p>
      </section>

      <section className="end-day-card__section end-day-card__section--attention">
        <div className="end-day-card__section-heading">
          <span className="end-day-card__section-label"><span className="end-day-card__diamond" aria-hidden="true" />生成日期</span>
          <span className="end-day-card__count">{label}</span>
        </div>
        <p className="report-notice__value report-notice__value--muted">{formatDateKey(report.dateKey)}</p>
      </section>

      <footer className="end-day-card__footer">
        <button className="end-day-card__primary" onClick={() => void getIpc().reports.openNotification()}>
          打开报告 <span aria-hidden="true">↗</span>
        </button>
        <button className="end-day-card__secondary" onClick={() => void getIpc().reports.dismissNotification()}>
          稍后查看
        </button>
      </footer>
      <div className="end-day-card__progress" style={{ transform: `scaleX(${remaining / DISPLAY_MS})` }} aria-hidden="true" />
    </main>
  );
}
