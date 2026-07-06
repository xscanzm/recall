// src/renderer/pages/TodayPage.tsx
// 今日页（来自 08 文档 "今日页" 章节）
//
// 重要约束：今日页是主界面，**不要做成聊天页**。
//
// 模块布局（按 08 文档）：
// 1. 今日概览（顶部，统计今日数量）
// 2. 当前工作主线（最近 scene 摘要）
// 3. 应用内提醒（右侧栏 - 在今日页内嵌显示）
// 4. 待确认（proactive_items status=new 且 requiresUserConfirmation 或 type=needs_confirmation）
// 5. 今日任务（type=task 的 facts 或 status=open 的 tasks）
// 6. 今日决策（type=decision 的 facts 或 decisions）
// 7. 日报草稿入口（按钮，跳转到报告页）
//
// 今日概览文案示例（来自 08 文档）：
// "今天 Recall 识别到 5 段工作场景、18 条事实、6 个待办和 3 个决策。
//  主要集中在 Recall 产品定义和 AI pipeline 设计。"
//
// 空状态（来自 08 文档，1:1 实现）：
// - 首次未开始观察："回声还没有开始观察。配置模型并开启后，它会把今天的工作上下文整理成任务、进展和日报。"
// - 暂停状态："已暂停。暂停期间不会采集窗口，也不会调用模型。"
// - 模型错误："模型连接失败。请检查 endpoint、model 和 API Key。"

import { useEffect, useMemo } from "react";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";
import { EmptyState } from "../components/EmptyState";
import { LoadingSpinner, SkeletonList } from "../components/LoadingSpinner";
import { LoadMorePager } from "../components/LoadMorePager";
import {
  FACT_TYPE_LABELS,
  TASK_STATUS_LABELS,
  confidenceLabel,
} from "../app/naming";

export function TodayPage() {
  const appStatus = useAppStore((s) => s.appStatus);
  const isReady = useAppStore((s) => s.isReady);
  const todayData = useAppStore((s) => s.todayData);
  const todayLoading = useAppStore((s) => s.todayLoading);
  const todayError = useAppStore((s) => s.todayError);
  const loadToday = useAppStore((s) => s.loadToday);
  const loadReminders = useAppStore((s) => s.loadReminders);
  const reminders = useAppStore((s) => s.reminders);
  const setPage = useAppStore((s) => s.setPage);
  const pendingJumpId = useAppStore((s) => s.pendingJumpId);
  const pendingJumpType = useAppStore((s) => s.pendingJumpType);
  const clearPendingJump = useAppStore((s) => s.clearPendingJump);

  // 已开始观察时加载今日数据和提醒
  useEffect(() => {
    if (isReady && appStatus.observing && !appStatus.paused) {
      void loadToday();
      void loadReminders();
    }
  }, [isReady, appStatus.observing, appStatus.paused, loadToday, loadReminders]);

  // 跨页面跳转：当从搜索页跳转到今日页时，滚动到对应元素并高亮
  useEffect(() => {
    if (
      pendingJumpId &&
      (pendingJumpType === "observation" || pendingJumpType === "scene")
    ) {
      const el = document.getElementById(`item-${pendingJumpId}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("highlight-jump");
        setTimeout(() => el.classList.remove("highlight-jump"), 2000);
      }
      clearPendingJump();
    }
  }, [pendingJumpId, pendingJumpType, clearPendingJump]);

  // 是否首次未开始观察（observing=false 且 paused=false）
  const isFreshStart = !appStatus.observing && !appStatus.paused;

  const handleStart = async () => {
    try {
      await getIpc().app.startObserving();
    } catch (err) {
      console.error("启动观察失败:", err);
    }
  };

  const handleGoToSettings = () => {
    setPage("settings");
  };

  const handleGoToReminders = () => {
    setPage("reminders");
  };

  const handleGoToReports = () => {
    setPage("reports");
  };

  if (!isReady) {
    return (
      <div className="today-page today-page--loading">
        <LoadingSpinner size="lg" label="正在加载 Recall..." />
      </div>
    );
  }

  // 状态：模型错误
  if (appStatus.lastError || appStatus.pipelineState === "error") {
    return (
      <div className="today-page">
        <header className="page-header">
          <h2>今日</h2>
          <p className="page-header__sub">Recall 遇到了模型连接问题。</p>
        </header>
        <EmptyState
          variant="modelError"
          actions={
            <button onClick={handleGoToSettings}>前往设置检查模型配置</button>
          }
        />
      </div>
    );
  }

  // 状态：首次未开始观察
  if (isFreshStart) {
    return (
      <div className="today-page today-page--empty">
        <div className="empty-hero">
          <div className="empty-hero__logo">
            <span className="empty-hero__logo-zh">回声</span>
            <span className="empty-hero__logo-en">Recall</span>
          </div>
          <h1 className="empty-hero__title">
            回声还没有开始观察。
          </h1>
          <p className="empty-hero__subtitle">
            配置模型并开启后，它会把今天的工作上下文整理成任务、进展和日报。
          </p>
          <ul className="empty-hero__list">
            <li>截图仅作为模型输入，本地短期保留，可配置。</li>
            <li>视觉模型和语言模型分开配置，使用你自己的 API Key。</li>
            <li>API Key 通过系统安全存储保存，不会进入数据库或日志。</li>
            <li>桌面通知默认关闭，应用内提醒默认开启。</li>
          </ul>
          <div className="empty-hero__actions">
            <button className="primary" onClick={handleStart}>
              开始观察
            </button>
            <button onClick={handleGoToSettings}>先配置模型</button>
          </div>
          <p className="empty-hero__note">
            开始观察后，Recall 将安静地在后台工作。你可以随时暂停或忘掉最近一段时间的记忆。
          </p>
        </div>
      </div>
    );
  }

  // 状态：已暂停
  if (appStatus.paused) {
    return (
      <div className="today-page today-page--paused">
        <header className="page-header">
          <h2>今日</h2>
          <p className="page-header__sub">Recall 当前已暂停。</p>
        </header>
        <EmptyState
          variant="paused"
          actions={
            <button className="primary" onClick={handleStart}>
              恢复观察
            </button>
          }
          hint="恢复后不会补采暂停期间的内容。"
        />
      </div>
    );
  }

  // 状态：观察中，显示今日页完整内容
  return (
    <div className="today-page">
      <header className="today-page__hero">
        <h2>今日</h2>
        <p className="today-page__hero-sub">
          {appStatus.observing
            ? "Recall 正在观察你的工作上下文。"
            : "等待开始观察。"}
        </p>
      </header>

      {todayError && (
        <div className="today-page__error">
          <p>加载今日数据失败：{todayError}</p>
          <button onClick={() => void loadToday()}>重试</button>
        </div>
      )}

      {todayLoading && todayData.observations.length === 0 ? (
        <div className="today-page__skeleton">
          <SkeletonList rows={4} />
          <SkeletonList rows={3} />
          <SkeletonList rows={2} />
        </div>
      ) : (
        <TodayContent
          todayData={todayData}
          reminders={reminders}
          onGoToReminders={handleGoToReminders}
          onGoToReports={handleGoToReports}
        />
      )}

      <style>{`
        .today-page--empty {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .empty-hero {
          max-width: 560px;
          text-align: center;
          background-color: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-card);
          padding: 40px 32px;
          box-shadow: var(--shadow-sm);
        }
        .empty-hero__logo {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 2px;
          margin-bottom: 24px;
        }
        .empty-hero__logo-zh {
          font-size: 28px;
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: 1px;
        }
        .empty-hero__logo-en {
          font-size: 12px;
          color: var(--text-secondary);
          letter-spacing: 2px;
          text-transform: uppercase;
        }
        .empty-hero__title {
          font-size: 16px;
          font-weight: 500;
          color: var(--text-primary);
          margin: 0 0 12px 0;
          line-height: 1.6;
        }
        .empty-hero__subtitle {
          font-size: 13px;
          color: var(--text-secondary);
          margin: 0 0 20px 0;
        }
        .empty-hero__list {
          list-style: none;
          padding: 0;
          margin: 0 0 24px 0;
          text-align: left;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .empty-hero__list li {
          font-size: 12px;
          color: var(--text-secondary);
          padding-left: 16px;
          position: relative;
        }
        .empty-hero__list li::before {
          content: "";
          position: absolute;
          left: 4px;
          top: 9px;
          width: 4px;
          height: 4px;
          background-color: var(--accent-green);
          border-radius: 50%;
        }
        .empty-hero__actions {
          display: flex;
          gap: 8px;
          justify-content: center;
          margin-bottom: 16px;
        }
        .empty-hero__note {
          font-size: 11px;
          color: var(--text-secondary);
          margin: 0;
        }
        .today-page__error {
          background-color: #fbeeeb;
          border: 1px solid var(--danger);
          border-radius: var(--radius-card);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: var(--danger);
          font-size: 13px;
        }
        /* 跨页面跳转高亮动画 */
        .highlight-jump {
          animation: jump-highlight 2s ease-out;
        }
        @keyframes jump-highlight {
          0% { background-color: var(--accent-amber); }
          100% { background-color: transparent; }
        }
      `}</style>
    </div>
  );
}

// ============================================================================
// 今日页内容（7 个模块）
// ============================================================================

interface TodayContentProps {
  todayData: ReturnType<typeof useAppStore.getState>["todayData"];
  reminders: ReturnType<typeof useAppStore.getState>["reminders"];
  onGoToReminders: () => void;
  onGoToReports: () => void;
}

function TodayContent({
  todayData,
  reminders,
  onGoToReminders,
  onGoToReports,
}: TodayContentProps) {
  const { observations, facts, scenes, tasks, decisions, projects } = todayData;

  // 今日任务：type=task 的 facts 或 status=open/in_progress 的 tasks
  const todayTasks = useMemo(() => {
    const taskFacts = facts.filter((f) => f.type === "task");
    const openTasks = tasks.filter(
      (t) => t.status === "open" || t.status === "in_progress" || t.status === "needs_confirmation"
    );
    return { taskFacts, openTasks };
  }, [facts, tasks]);

  // 今日决策：type=decision 的 facts 或 decisions 表
  const todayDecisions = useMemo(() => {
    const decisionFacts = facts.filter((f) => f.type === "decision");
    return { decisionFacts, decisions };
  }, [facts, decisions]);

  // 待确认：requiresUserConfirmation 或 type=needs_confirmation 的 reminders
  const pendingConfirmations = useMemo(() => {
    return reminders.filter(
      (r) =>
        r.status === "new" &&
        (r.requiresUserConfirmation ||
          r.type === "needs_confirmation" ||
          r.type === "decision_review")
    );
  }, [reminders]);

  // 应用内提醒（new 状态的 reminders）
  const inAppReminders = useMemo(() => {
    return reminders.filter((r) => r.status === "new").slice(0, 5);
  }, [reminders]);

  // 当前工作主线：最近 scene 摘要（最多 2 个）
  const recentScenes = useMemo(() => {
    return [...scenes].sort((a, b) => b.startAt.localeCompare(a.startAt)).slice(0, 2);
  }, [scenes]);

  // 主要项目名（用于今日概览文案）
  const focusProjectNames = useMemo(() => {
    const names = new Set<string>();
    projects.slice(0, 3).forEach((p) => names.add(p.name));
    facts.forEach((f) => {
      if (f.projectHint && names.size < 3) names.add(f.projectHint);
    });
    return Array.from(names).slice(0, 3);
  }, [projects, facts]);

  // 如果没有任何数据，显示空状态
  const hasAnyData =
    observations.length > 0 ||
    facts.length > 0 ||
    scenes.length > 0 ||
    tasks.length > 0 ||
    decisions.length > 0;

  if (!hasAnyData) {
    return (
      <EmptyState
        variant="noReport"
        hint="Recall 正在观察，稍后会在这里显示今日概览。"
      />
    );
  }

  return (
    <>
      {/* 模块 1：今日概览 */}
      <TodayOverview
        sceneCount={scenes.length}
        factCount={facts.length}
        taskCount={todayTasks.taskFacts.length + todayTasks.openTasks.length}
        decisionCount={todayDecisions.decisionFacts.length + todayDecisions.decisions.length}
        focusProjects={focusProjectNames}
      />

      {/* 模块 2：当前工作主线 */}
      <section className="today-section">
        <h3 className="today-section__title">当前工作主线</h3>
        {recentScenes.length === 0 ? (
          <p className="state-loading">还没有识别到工作片段。</p>
        ) : (
          <div className="today-section__list">
            {recentScenes.map((scene) => (
              <div key={scene.id} id={`item-${scene.id}`} className="today-scene-block">
                <h4 className="today-scene-block__title">{scene.title}</h4>
                <p className="today-scene-block__summary">{scene.summary}</p>
                <div className="today-scene-block__time">
                  {formatTime(scene.startAt)} - {formatTime(scene.endAt)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 模块 3：应用内提醒（今日页内嵌的右侧栏模拟） */}
      <section className="today-section">
        <h3 className="today-section__title">
          应用内提醒
          {inAppReminders.length > 0 && (
            <span
              className="today-section__title-link"
              onClick={onGoToReminders}
              role="button"
              tabIndex={0}
            >
              查看全部
            </span>
          )}
        </h3>
        {inAppReminders.length === 0 ? (
          <p className="state-loading">当前没有应用内提醒。</p>
        ) : (
          <div className="today-section__list">
            {inAppReminders.map((r) => (
              <div key={r.id} className="today-confirmation-row">
                <div className="today-task-row__title">{r.title}</div>
                <div className="today-confirmation-row__meta">
                  <span>{r.reason}</span>
                  {r.requiresUserConfirmation && <span>需确认</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 模块 4：待确认 */}
      <section className="today-section">
        <h3 className="today-section__title">待确认</h3>
        {pendingConfirmations.length === 0 ? (
          <p className="state-loading">没有待确认的内容。</p>
        ) : (
          <div className="today-section__list">
            {pendingConfirmations.map((r) => (
              <div key={r.id} className="today-confirmation-row">
                <div className="today-task-row__title">{r.title}</div>
                <div className="today-confirmation-row__meta">
                  <span>置信度：{confidenceLabel(r.priority)}</span>
                  <span>来源 {r.sourceFactIds.length} 条</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 模块 5：今日任务（分页，每页 20 条，来自 06 文档"性能原则"） */}
      <section className="today-section">
        <h3 className="today-section__title">今日任务</h3>
        {todayTasks.taskFacts.length === 0 && todayTasks.openTasks.length === 0 ? (
          <p className="state-loading">今天还没有识别到任务。</p>
        ) : (
          <LoadMorePager
            items={[...todayTasks.openTasks, ...todayTasks.taskFacts]}
            pageSize={20}
            emptyLabel="今天还没有识别到任务。"
            renderItem={(item, idx) => {
              // openTasks 在前，taskFacts 在后
              const isTask = idx < todayTasks.openTasks.length;
              if (isTask) {
                const task = item as typeof todayTasks.openTasks[number];
                return (
                  <div key={task.id} className="today-task-row">
                    <div className="today-task-row__title">{task.title}</div>
                    <div className="today-task-row__meta">
                      <span>{TASK_STATUS_LABELS[task.status] ?? task.status}</span>
                      {task.dueHint && <span>截止：{task.dueHint}</span>}
                      <span>置信度：{confidenceLabel(task.confidence)}</span>
                    </div>
                  </div>
                );
              }
              const fact = item as typeof todayTasks.taskFacts[number];
              return (
                <div key={fact.id} className="today-task-row">
                  <div className="today-task-row__title">{fact.content}</div>
                  <div className="today-task-row__meta">
                    <span>{FACT_TYPE_LABELS[fact.type] ?? "任务"}</span>
                    {fact.status && <span>{TASK_STATUS_LABELS[fact.status] ?? fact.status}</span>}
                    <span>置信度：{confidenceLabel(fact.confidence)}</span>
                  </div>
                </div>
              );
            }}
          />
        )}
      </section>

      {/* 模块 6：今日决策（分页，每页 20 条） */}
      <section className="today-section">
        <h3 className="today-section__title">今日决策</h3>
        {todayDecisions.decisionFacts.length === 0 &&
        todayDecisions.decisions.length === 0 ? (
          <p className="state-loading">今天还没有识别到决策。</p>
        ) : (
          <LoadMorePager
            items={[...todayDecisions.decisions, ...todayDecisions.decisionFacts]}
            pageSize={20}
            emptyLabel="今天还没有识别到决策。"
            renderItem={(item, idx) => {
              const isDecision = idx < todayDecisions.decisions.length;
              if (isDecision) {
                const d = item as typeof todayDecisions.decisions[number];
                return (
                  <div key={d.id} className="today-decision-row">
                    <div className="today-decision-row__title">{d.title}</div>
                    <div className="today-decision-row__meta">
                      <span>置信度：{confidenceLabel(d.confidence)}</span>
                      {d.decidedAt && <span>{formatDate(d.decidedAt)}</span>}
                    </div>
                  </div>
                );
              }
              const fact = item as typeof todayDecisions.decisionFacts[number];
              return (
                <div key={fact.id} className="today-decision-row">
                  <div className="today-decision-row__title">{fact.content}</div>
                  <div className="today-decision-row__meta">
                    <span>置信度：{confidenceLabel(fact.confidence)}</span>
                  </div>
                </div>
              );
            }}
          />
        )}
      </section>

      {/* 模块 7：日报草稿入口 */}
      <section className="today-section">
        <h3 className="today-section__title">日报草稿</h3>
        <div className="today-report-entry">
          <div>
            <p className="today-report-entry__hint">
              {hasAnyData
                ? "Recall 已整理今日工作上下文，可以生成日报草稿。"
                : "今天还没有足够记忆生成日报。"}
            </p>
            <p className="today-report-entry__sub">
              日报基于结构化记忆生成，不直接引用截图。
            </p>
          </div>
          <button className="primary" onClick={onGoToReports}>
            生成日报
          </button>
        </div>
      </section>
    </>
  );
}

// ============================================================================
// 今日概览模块
// ============================================================================

interface TodayOverviewProps {
  sceneCount: number;
  factCount: number;
  taskCount: number;
  decisionCount: number;
  focusProjects: string[];
}

/**
 * 今日概览（来自 08 文档示例文案）
 *
 * 文案示例：
 * "今天 Recall 识别到 5 段工作场景、18 条事实、6 个待办和 3 个决策。
 *  主要集中在 Recall 产品定义和 AI pipeline 设计。"
 */
function TodayOverview({
  sceneCount,
  factCount,
  taskCount,
  decisionCount,
  focusProjects,
}: TodayOverviewProps) {
  const hasData =
    sceneCount > 0 || factCount > 0 || taskCount > 0 || decisionCount > 0;

  return (
    <section className="today-overview">
      {hasData ? (
        <>
          <p className="today-overview__headline">
            今天 Recall 识别到 <strong>{sceneCount}</strong> 段工作场景、
            <strong>{factCount}</strong> 条线索、<strong>{taskCount}</strong> 个待办和
            <strong>{decisionCount}</strong> 个决策。
          </p>
          {focusProjects.length > 0 && (
            <p className="today-overview__focus">
              主要集中在 {focusProjects.join("、")}。
            </p>
          )}
          <div className="today-overview__stats">
            <div className="today-overview__stat">
              <span className="today-overview__stat-num">{sceneCount}</span>
              <span className="today-overview__stat-label">工作场景</span>
            </div>
            <div className="today-overview__stat">
              <span className="today-overview__stat-num">{factCount}</span>
              <span className="today-overview__stat-label">线索</span>
            </div>
            <div className="today-overview__stat">
              <span className="today-overview__stat-num">{taskCount}</span>
              <span className="today-overview__stat-label">待办</span>
            </div>
            <div className="today-overview__stat">
              <span className="today-overview__stat-num">{decisionCount}</span>
              <span className="today-overview__stat-label">决策</span>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="today-overview__headline">
            今天 Recall 还没有识别到工作场景。
          </p>
          <p className="today-overview__focus">
            继续工作一会儿，或检查模型配置是否正确。
          </p>
        </>
      )}
    </section>
  );
}

// ============================================================================
// 辅助函数
// ============================================================================

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  } catch {
    return "";
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("zh-CN");
  } catch {
    return "";
  }
}
