// src/renderer/pages/today/TimelineHeader.tsx
// 今日页中间主区域顶部 Header（spec 行 1363-1404）
//
// 内容：
// - 标题"今日" + 一句今日主线 summary
// - 右侧：状态 pill + 暂停/恢复按钮 + 忘掉最近

import { Eraser } from "lucide-react";
import { useAppStore } from "../../state/store";

interface TimelineHeaderProps {
  dayMainThread: string;
  dateLabel: string;
  historical: boolean;
}

export function TimelineHeader({ dayMainThread, dateLabel, historical }: TimelineHeaderProps) {
  const forgetRecent = useAppStore((s) => s.forgetRecent);
  const refreshTodayPageData = useAppStore((s) => s.refreshTodayPageData);

  const handleForgetRecent = () => {
    useAppStore.getState().requestConfirm({
      title: "忘掉最近",
      message: "忘掉最近 30 分钟的观察记录？此操作不可撤销。",
      confirmText: "确认",
      onConfirm: async () => {
        try {
          await forgetRecent("30m");
          await refreshTodayPageData();
        } catch (err) {
          console.error("忘掉最近失败:", err);
        }
      },
    });
  };

  return (
    <header className="timeline-header">
      <div className="timeline-header__titles">
        <h1 className="timeline-header__title">
          {historical ? "历史" : "今日"}
          <span className="timeline-header__date">{dateLabel}</span>
        </h1>
        <p className="timeline-header__sub">{dayMainThread}</p>
      </div>
      <div className="timeline-header__actions">
        {!historical && <button
          type="button"
          className="timeline-header__forget-btn"
          onClick={handleForgetRecent}
          aria-label="忘掉最近"
          title="忘掉最近 30 分钟"
        >
          <Eraser size={15} aria-hidden="true" />
          <span>忘掉最近</span>
        </button>}
      </div>
    </header>
  );
}
