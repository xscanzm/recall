import { useEffect, useRef, useState } from "react";
import type { EndOfDayReview } from "../../shared/types";
import { getIpc } from "../state/ipc";
import "./EndOfDayReviewPopup.css";

const DISPLAY_MS = 25_000;

function formatDate(date = new Date()): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(date);
}

export function EndOfDayReviewPopup() {
  const [review, setReview] = useState<EndOfDayReview | null>(null);
  const [remaining, setRemaining] = useState(DISPLAY_MS);
  const paused = useRef(false);

  useEffect(() => {
    void getIpc()
      .endOfDayReview.get<EndOfDayReview>()
      .then(setReview)
      .catch((err) => {
        // 收工回顾加载失败：保持弹窗隐藏（与无数据时一致），仅记录错误
        console.error("加载收工回顾失败:", err);
      });
    const timer = window.setInterval(() => {
      if (!paused.current) setRemaining((value) => Math.max(0, value - 250));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (remaining === 0) void getIpc().endOfDayReview.expired();
  }, [remaining]);

  if (!review) return null;

  return (
    <main
      className="end-day-card"
      onMouseEnter={() => { paused.current = true; }}
      onMouseLeave={() => { paused.current = false; }}
    >
      <header className="end-day-card__header">
        <div className="end-day-card__masthead">
          <span className="end-day-card__mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="end-day-card__eyebrow">RECALL / {formatDate()}</span>
        </div>
        <button className="end-day-card__close" aria-label="关闭收工回顾" onClick={() => void getIpc().endOfDayReview.dismiss()}>
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <div className="end-day-card__intro">
        <p className="end-day-card__kicker">DAY'S END NOTE</p>
        <h1>今天，暂告一段落</h1>
        <p>一份简短的工作回望，留给收工前的片刻。</p>
      </div>

      <div className="end-day-card__rule" aria-hidden="true" />

      <section className="end-day-card__section">
        <div className="end-day-card__section-heading">
          <span className="end-day-card__section-label"><span className="end-day-card__check" aria-hidden="true">✓</span>已完成</span>
          <span className="end-day-card__count">{review.completed.length}</span>
        </div>
        {review.completed.length > 0 ? (
          <ul>{review.completed.map((item, index) => <li key={`${item.id}-${index}`}><span>{item.text}</span></li>)}</ul>
        ) : <p className="end-day-card__empty">今天暂时没有整理出明确进展。</p>}
      </section>

      <section className="end-day-card__section end-day-card__section--attention">
        <div className="end-day-card__section-heading">
          <span className="end-day-card__section-label"><span className="end-day-card__diamond" aria-hidden="true" />还留在桌面上</span>
          <span className="end-day-card__count">{review.attention.length}</span>
        </div>
        {review.attention.length > 0 ? (
          <ul>{review.attention.map((item) => <li key={item.id}><span>{item.text}</span></li>)}</ul>
        ) : <p className="end-day-card__empty">桌面上没有留下待收尾事项。</p>}
      </section>

      <footer className="end-day-card__footer">
        <button className="end-day-card__primary" onClick={() => void getIpc().endOfDayReview.viewToday()}>打开今日回顾 <span aria-hidden="true">↗</span></button>
        <button className="end-day-card__secondary" onClick={() => void getIpc().endOfDayReview.snooze()}>稍后提醒</button>
      </footer>
      <div className="end-day-card__progress" style={{ transform: `scaleX(${remaining / DISPLAY_MS})` }} aria-hidden="true" />
    </main>
  );
}
