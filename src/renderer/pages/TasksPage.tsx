// src/renderer/pages/TasksPage.tsx
// 待收尾页（spec.md Phase 5 / doc 24）
//
// 目标：帮用户找回"今天或近期可能还没处理完的事情"。
// 不是传统任务管理器。
//
// 5 分组：
// 1. 今天要看一眼 — 当天 open
// 2. 近期未收尾 — 近 7 天 open（排除今天）
// 3. 可能已完成，待确认 — priority=low 且超过 7 天的 open
// 4. 已完成 — status=done
// 5. 已忽略 — status=ignored
//
// 每条待收尾卡片含：标题 / 原因 / 建议下一步 / 项目标签 + 最近出现时间 / 操作按钮
// 操作：标记完成 / 稍后 / 忽略 / 改项目 / 查看来源
//
// 重要约束：
// - 每条待收尾都有原因和建议下一步
// - 不把所有 facts 都变成待收尾
// - 不出现"检测到用户未完成任务"等技术化文案
// - 不使用 emoji

import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Clock,
  X,
  FolderKanban,
  Link2,
} from "lucide-react";
import type { UnfinishedThread } from "../../shared/types";
import { useAppStore } from "../state/store";
import { Button } from "../components/Button";
import { Tag } from "../components/Tag";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Loading } from "../components/Loading";

// ============================================================================
// 日期辅助
// ============================================================================

/** 生成本地时区的 dateKey（YYYY-MM-DD） */
function todayDateKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 将 ISO 时间字符串转为本地时区 dateKey（YYYY-MM-DD） */
function isoToDateKey(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 判断 ISO 时间是否属于今天 */
function isToday(iso: string | undefined): boolean {
  return isoToDateKey(iso) === todayDateKey();
}

/** 判断 ISO 时间是否在最近 N 天内（含今天） */
function isWithinDays(iso: string | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return t >= cutoff;
}

/** 友好时间格式：今天显示 HH:MM，其它显示 MM-DD HH:MM */
function formatSeenAt(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  if (isToday(iso)) return `今天 ${hh}:${mm}`;
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${m}-${day} ${hh}:${mm}`;
}

// ============================================================================
// 分组定义
// ============================================================================

interface GroupDef {
  key: string;
  title: string;
  threads: UnfinishedThread[];
}

/**
 * 将待收尾列表按 5 分组归类。
 * 依赖 lastSeenAt 作为日期判定（UnfinishedThread 类型未暴露 dateKey）。
 */
function groupThreads(threads: UnfinishedThread[]): GroupDef[] {
  const today: UnfinishedThread[] = [];
  const recent: UnfinishedThread[] = [];
  const maybeDone: UnfinishedThread[] = [];
  const done: UnfinishedThread[] = [];
  const ignored: UnfinishedThread[] = [];

  for (const t of threads) {
    if (t.status === "done") {
      done.push(t);
    } else if (t.status === "ignored") {
      ignored.push(t);
    } else if (t.status === "open") {
      if (isToday(t.lastSeenAt)) {
        today.push(t);
      } else if (isWithinDays(t.lastSeenAt, 7)) {
        recent.push(t);
      } else if (t.priority === "low") {
        // 超过 7 天且低优先级：可能已完成，待确认
        maybeDone.push(t);
      } else {
        // 超过 7 天但非低优先级：仍归入近期未收尾
        recent.push(t);
      }
    }
    // snoozed：暂时隐藏，不显示在任何分组
  }

  // 每组内按 priority 降序（high > medium > low），再按 lastSeenAt 降序
  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortFn = (a: UnfinishedThread, b: UnfinishedThread): number => {
    const pa = priorityRank[a.priority] ?? 3;
    const pb = priorityRank[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  };
  today.sort(sortFn);
  recent.sort(sortFn);
  maybeDone.sort(sortFn);
  done.sort(sortFn);
  ignored.sort(sortFn);

  return [
    { key: "today", title: "今天要看一眼", threads: today },
    { key: "recent", title: "近期未收尾", threads: recent },
    { key: "maybe-done", title: "可能已完成，待确认", threads: maybeDone },
    { key: "done", title: "已完成", threads: done },
    { key: "ignored", title: "已忽略", threads: ignored },
  ];
}

// ============================================================================
// 来源查看弹窗
// ============================================================================

interface SourceDialogState {
  thread: UnfinishedThread;
}

// ============================================================================
// 主组件
// ============================================================================

export function TasksPage() {
  const isReady = useAppStore((s) => s.isReady);
  const threads = useAppStore((s) => s.unfinishedThreads);
  const loading = useAppStore((s) => s.unfinishedLoading);
  const error = useAppStore((s) => s.unfinishedError);
  const loadUnfinished = useAppStore((s) => s.loadUnfinishedThreads);
  const updateStatus = useAppStore((s) => s.updateUnfinishedStatus);

  const [sourceDialog, setSourceDialog] = useState<SourceDialogState | null>(null);
  // 改项目入口（预留）：当前仅提示，spec 允许后置
  const [projectHintId, setProjectHintId] = useState<string | null>(null);

  useEffect(() => {
    if (isReady) {
      void loadUnfinished();
    }
  }, [isReady, loadUnfinished]);

  const groups = useMemo(() => groupThreads(threads), [threads]);
  const visibleCount = groups.reduce((sum, g) => sum + g.threads.length, 0);

  // ---- 操作处理 ----
  const handleMarkDone = (id: string) => {
    void updateStatus(id, "done");
  };
  const handleSnooze = (id: string) => {
    void updateStatus(id, "snoozed");
  };
  const handleIgnore = (id: string) => {
    void updateStatus(id, "ignored");
  };
  const handleChangeProject = (id: string) => {
    // 预留入口：当前仅提示用户功能尚在规划
    setProjectHintId(id);
    window.setTimeout(() => setProjectHintId(null), 2400);
  };
  const handleViewSource = (thread: UnfinishedThread) => {
    setSourceDialog({ thread });
  };

  // ---- 渲染 ----
  if (!isReady) {
    return (
      <div className="unfinished-page">
        <header className="page-header">
          <h2>待收尾</h2>
        </header>
        <Loading variant="inline" />
      </div>
    );
  }

  return (
    <div className="unfinished-page">
      <header className="page-header">
        <h2>待收尾</h2>
        <p className="page-header__sub">
          这里整理了 Recall 认为可能还需要你继续看一眼的事情。
        </p>
      </header>

      {error && (
        <ErrorState
          title="加载失败"
          description={error}
          primaryAction={{ label: "重试", onClick: () => void loadUnfinished() }}
        />
      )}

      {loading && visibleCount === 0 ? (
        <Loading variant="inline" />
      ) : visibleCount === 0 && !error ? (
        <EmptyState
          title="目前没有需要收尾的事。"
          description="如果今天出现明确待办或未完成事项，Recall 会把它们放在这里。"
        />
      ) : (
        <div className="unfinished-groups">
          {groups.map((group) => {
            if (group.threads.length === 0) return null;
            return (
              <section key={group.key} className="unfinished-group">
                <header className="unfinished-group__header">
                  <h3 className="unfinished-group__title">
                    {group.title}
                    <span className="unfinished-group__count">
                      {group.threads.length}
                    </span>
                  </h3>
                </header>
                <div className="unfinished-group__list">
                  {group.threads.map((thread) => (
                    <UnfinishedCard
                      key={thread.id}
                      thread={thread}
                      showProjectHint={projectHintId === thread.id}
                      onMarkDone={handleMarkDone}
                      onSnooze={handleSnooze}
                      onIgnore={handleIgnore}
                      onChangeProject={handleChangeProject}
                      onViewSource={handleViewSource}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* 查看来源弹窗 */}
      {sourceDialog && (
        <SourceDialog
          thread={sourceDialog.thread}
          onClose={() => setSourceDialog(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// 待收尾卡片
// ============================================================================

interface UnfinishedCardProps {
  thread: UnfinishedThread;
  showProjectHint: boolean;
  onMarkDone: (id: string) => void;
  onSnooze: (id: string) => void;
  onIgnore: (id: string) => void;
  onChangeProject: (id: string) => void;
  onViewSource: (thread: UnfinishedThread) => void;
}

function UnfinishedCard({
  thread,
  showProjectHint,
  onMarkDone,
  onSnooze,
  onIgnore,
  onChangeProject,
  onViewSource,
}: UnfinishedCardProps) {
  const sourceCount =
    thread.sourceFactIds.length + thread.sourceTimelineBlockIds.length;
  const isDone = thread.status === "done";
  const isIgnored = thread.status === "ignored";

  return (
    <article className="unfinished-card">
      <div className="unfinished-card__head">
        <h4 className="unfinished-card__title">{thread.title}</h4>
        {thread.priority === "high" && (
          <Tag type="warning">优先</Tag>
        )}
      </div>

      {thread.reason && (
        <p className="unfinished-card__reason">{thread.reason}</p>
      )}

      {thread.suggestedNextAction && (
        <p className="unfinished-card__action">
          <span className="unfinished-card__action-label">建议下一步：</span>
          {thread.suggestedNextAction}
        </p>
      )}

      <div className="unfinished-card__meta">
        {thread.projectName && (
          <Tag type="project">{thread.projectName}</Tag>
        )}
        {thread.lastSeenAt && (
          <span className="unfinished-card__time">
            最近出现：{formatSeenAt(thread.lastSeenAt)}
          </span>
        )}
      </div>

      <div className="unfinished-card__actions-label">操作：</div>
      <div className="unfinished-card__actions">
        {!isDone && !isIgnored && (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={() => onMarkDone(thread.id)}
              title="标记为完成"
              aria-label="标记为完成"
            >
              <Check size={14} style={{ marginRight: 4 }} />
              标记完成
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSnooze(thread.id)}
              title="稍后再看"
              aria-label="稍后再看"
            >
              <Clock size={14} style={{ marginRight: 4 }} />
              稍后
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onIgnore(thread.id)}
              title="忽略此条"
              aria-label="忽略此条"
            >
              <X size={14} style={{ marginRight: 4 }} />
              忽略
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChangeProject(thread.id)}
          title="改项目"
          aria-label="改项目"
        >
          <FolderKanban size={14} style={{ marginRight: 4 }} />
          改项目
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onViewSource(thread)}
          title="查看来源"
          aria-label="查看来源"
        >
          <Link2 size={14} style={{ marginRight: 4 }} />
          查看来源
        </Button>
        {(isDone || isIgnored) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onMarkDone(thread.id)}
            title="重新标记为完成"
            aria-label="重新标记为完成"
          >
            <Check size={14} style={{ marginRight: 4 }} />
            重新打开
          </Button>
        )}
      </div>

      {showProjectHint && (
        <p className="unfinished-card__hint">
          改项目功能即将开放，当前可先在项目页整理。
        </p>
      )}

      {isDone && (
        <p className="unfinished-card__hint">已标记为完成。</p>
      )}
      {isIgnored && (
        <p className="unfinished-card__hint">已忽略。可重新标记为完成或稍后。</p>
      )}

      {sourceCount > 0 && (
        <p className="unfinished-card__source-count">
          来自 {sourceCount} 个来源记录
        </p>
      )}
    </article>
  );
}

// ============================================================================
// 来源查看弹窗
// ============================================================================

interface SourceDialogProps {
  thread: UnfinishedThread;
  onClose: () => void;
}

function SourceDialog({ thread, onClose }: SourceDialogProps) {
  const hasTimelineBlocks = thread.sourceTimelineBlockIds.length > 0;
  const hasFacts = thread.sourceFactIds.length > 0;

  return (
    <div
      className="unfinished-source-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="查看来源"
    >
      <div className="unfinished-source-dialog__panel">
        <header className="unfinished-source-dialog__header">
          <h3>来源记录</h3>
          <button
            type="button"
            className="unfinished-source-dialog__close"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="unfinished-source-dialog__body">
          <p className="unfinished-source-dialog__title-ref">{thread.title}</p>
          {hasTimelineBlocks && (
            <div className="unfinished-source-dialog__section">
              <p className="unfinished-source-dialog__section-title">
                相关时间轴片段（{thread.sourceTimelineBlockIds.length}）
              </p>
              <ul className="unfinished-source-dialog__list">
                {thread.sourceTimelineBlockIds.map((id) => (
                  <li key={id} className="unfinished-source-dialog__item">
                    {id}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {hasFacts && (
            <div className="unfinished-source-dialog__section">
              <p className="unfinished-source-dialog__section-title">
                相关线索（{thread.sourceFactIds.length}）
              </p>
              <ul className="unfinished-source-dialog__list">
                {thread.sourceFactIds.map((id) => (
                  <li key={id} className="unfinished-source-dialog__item">
                    {id}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!hasTimelineBlocks && !hasFacts && (
            <p className="unfinished-source-dialog__empty">
              这条待收尾没有关联来源记录。
            </p>
          )}
        </div>
        <footer className="unfinished-source-dialog__footer">
          <Button variant="secondary" size="sm" onClick={onClose}>
            关闭
          </Button>
        </footer>
      </div>
    </div>
  );
}
