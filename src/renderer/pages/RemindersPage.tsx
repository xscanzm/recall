// src/renderer/pages/RemindersPage.tsx
// 提醒页（来自 08 文档 "提醒页" 章节）
//
// 功能：
// - 显示应用内提醒列表
// - 按类型分组（待确认 amber、任务提醒 green、风险 danger、项目进展 neutral）
// - 提醒可操作（确认/忽略/稍后/标记完成/编辑/不再提醒类似）
// - 标记完成后任务状态更新
// - 编辑内容写入 user_feedback
// - 012 新增：合并建议区（来自 Linker 的 merge_suggestion）
//
// 来自 08 文档：
// - 提醒卡片字段：类型图标、标题、原因、来源数量、置信度标签、操作按钮
// - 提醒类型颜色：待确认 amber / 任务提醒 green / 风险 danger / 项目进展 neutral
// - 操作：确认、忽略、稍后、标记完成、编辑、不再提醒类似内容

import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";
import { ReminderCard, type ReminderType } from "../components/ReminderCard";

/**
 * 过滤器选项
 */
type FilterKey = "all" | "pending" | "needs_confirmation" | "task_reminder" | "risk_warning";

const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待处理" },
  { key: "needs_confirmation", label: "待确认" },
  { key: "task_reminder", label: "任务提醒" },
  { key: "risk_warning", label: "风险" },
];

/**
 * 合并建议 payload 形状（来自 LinkerWorker.processMergeSuggestions）
 */
interface MergeSuggestionPayload {
  objectType: "project" | "person";
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  reason?: string;
  confidence?: number;
}

/**
 * 合并建议（proactive_item）类型
 */
interface MergeSuggestionItem {
  id: string;
  type: string;
  title: string;
  body: string;
  reason: string;
  priority: number;
  surface: string;
  requiresUserConfirmation: boolean;
  status: string;
  sourceFactIds: string[];
  sourceSceneIds: string[];
  payloadJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 安全解析 payloadJson
 */
function parseMergePayload(json: string | null | undefined): MergeSuggestionPayload | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.fromId === "string" &&
      typeof parsed.toId === "string" &&
      typeof parsed.fromName === "string" &&
      typeof parsed.toName === "string" &&
      (parsed.objectType === "project" || parsed.objectType === "person")
    ) {
      return parsed as MergeSuggestionPayload;
    }
    return null;
  } catch {
    return null;
  }
}

const OBJECT_TYPE_LABEL: Record<"project" | "person", string> = {
  project: "项目",
  person: "人物",
};

export function RemindersPage() {
  const isReady = useAppStore((s) => s.isReady);
  const reminders = useAppStore((s) => s.reminders);
  const remindersLoading = useAppStore((s) => s.remindersLoading);
  const remindersError = useAppStore((s) => s.remindersError);
  const loadReminders = useAppStore((s) => s.loadReminders);
  const updateReminderStatus = useAppStore((s) => s.updateReminderStatus);
  // 012/013 新增：合并建议
  const mergeSuggestions = useAppStore((s) => s.mergeSuggestions) as MergeSuggestionItem[];
  const mergeSuggestionsLoading = useAppStore((s) => s.mergeSuggestionsLoading);
  const loadMergeSuggestions = useAppStore((s) => s.loadMergeSuggestions);
  const rejectMergeSuggestion = useAppStore((s) => s.rejectMergeSuggestion);
  const mergeObjects = useAppStore((s) => s.mergeObjects);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // 合并建议处理状态：用于禁用按钮 + 显示 loading
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // 加载提醒列表
  useEffect(() => {
    if (isReady) {
      void loadReminders();
      void loadMergeSuggestions();
    }
  }, [isReady, loadReminders, loadMergeSuggestions]);

  // 按过滤器筛选
  const filteredReminders = useMemo(() => {
    switch (filter) {
      case "all":
        return reminders;
      case "pending":
        return reminders.filter((r) => r.status === "new" || r.status === "snoozed");
      case "needs_confirmation":
        return reminders.filter(
          (r) => r.type === "needs_confirmation" || r.requiresUserConfirmation
        );
      case "task_reminder":
        return reminders.filter(
          (r) => r.type === "task_reminder" || r.type === "unfinished_work"
        );
      case "risk_warning":
        return reminders.filter((r) => r.type === "risk_warning");
      default:
        return reminders;
    }
  }, [reminders, filter]);

  // 有效的合并建议（payload 解析成功）
  const validMergeSuggestions = useMemo(() => {
    if (!Array.isArray(mergeSuggestions)) return [];
    return mergeSuggestions.filter((s) => s.status === "new" && parseMergePayload(s.payloadJson));
  }, [mergeSuggestions]);

  // 操作处理（来自 08 文档）
  const handleConfirm = async (id: string) => {
    try {
      await updateReminderStatus(id, "confirmed");
    } catch (err) {
      console.error("确认提醒失败:", err);
    }
  };

  const handleIgnore = async (id: string) => {
    try {
      await updateReminderStatus(id, "ignored");
    } catch (err) {
      console.error("忽略提醒失败:", err);
    }
  };

  const handleSnooze = async (id: string) => {
    try {
      await updateReminderStatus(id, "snoozed");
    } catch (err) {
      console.error("稍后提醒失败:", err);
    }
  };

  /**
   * 标记完成（来自 spec：标记完成后任务状态更新）
   * 调用 reminders:updateStatus 将状态改为 done
   * 后续 main 进程在 M4+ 会同步更新关联 task 状态
   */
  const handleMarkComplete = async (id: string) => {
    try {
      await updateReminderStatus(id, "done");
    } catch (err) {
      console.error("标记完成失败:", err);
    }
  };

  /**
   * 编辑（来自 spec：编辑内容写入 user_feedback）
   * M5 阶段简化实现：弹出一个内联编辑框，输入备注后保存
   * 完整的 user_feedback 写入在 main 进程实现（M4+ 已有 memory:updateFact 等）
   */
  const handleEdit = (id: string) => {
    setEditingId(id);
    setEditNote("");
    setEditError(null);
  };

  const handleEditSubmit = async () => {
    if (!editingId) return;
    try {
      await updateReminderStatus(editingId, "confirmed");
      if (editNote.trim()) {
        try {
          await getIpc().memory.createUserFeedback({
            targetType: "reminder",
            targetId: editingId,
            feedbackType: "content_wrong",
            note: editNote.trim(),
          });
        } catch (err) {
          console.error("保存编辑备注失败:", err);
          setEditError("备注保存失败，请重试");
          return;
        }
      }
    } catch (err) {
      console.error("编辑提醒失败:", err);
    }
    setEditingId(null);
    setEditNote("");
    setEditError(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditNote("");
    setEditError(null);
  };

  /**
   * 不再提醒类似内容
   * 将状态改为 do_not_remind_again
   * 后续 main 进程会基于此反馈调整 Judge 输出
   */
  const handleMuteSimilar = async (id: string) => {
    try {
      await updateReminderStatus(id, "do_not_remind_again");
    } catch (err) {
      console.error("不再提醒类似失败:", err);
    }
  };

  // ============================================================================
  // 合并建议操作
  // ============================================================================

  /**
   * 确认合并（用户点"确认合并"按钮）
   * - 解析 payloadJson，调用 mergeObjects IPC
   * - 完成后由 store.mergeObjects 内部刷新 mergeSuggestions / todayData
   */
  const handleConfirmMerge = async (item: MergeSuggestionItem) => {
    const payload = parseMergePayload(item.payloadJson);
    if (!payload) {
      setMergeError("合并建议数据格式错误");
      return;
    }
    setMergingId(item.id);
    setMergeError(null);
    try {
      const result = await mergeObjects({
        objectType: payload.objectType,
        fromId: payload.fromId,
        toId: payload.toId,
        reason: payload.reason ?? item.reason ?? undefined,
      });
      console.log("[merge] confirmed", {
        objectType: payload.objectType,
        fromName: payload.fromName,
        toName: payload.toName,
        rewrittenFactsCount: result.rewrittenFactsCount,
        rewrittenScenesCount: result.rewrittenScenesCount,
        mergedAliases: result.mergedAliases,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMergeError(message);
      console.error("合并失败:", err);
    } finally {
      setMergingId(null);
    }
  };

  /**
   * 拒绝合并建议（仅把 proactive_item 状态改为 ignored，不修改数据）
   */
  const handleRejectMerge = async (item: MergeSuggestionItem) => {
    setMergingId(item.id);
    setMergeError(null);
    try {
      await rejectMergeSuggestion(item.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMergeError(message);
      console.error("拒绝合并建议失败:", err);
    } finally {
      setMergingId(null);
    }
  };

  if (!isReady) {
    return (
      <div className="reminders-page">
        <header className="page-header">
          <h2>提醒</h2>
        </header>
        <p className="state-loading">正在加载...</p>
      </div>
    );
  }

  return (
    <div className="reminders-page">
      <header className="page-header">
        <h2>提醒</h2>
        <p className="page-header__sub">
          应用内提醒默认开启。桌面通知需要在设置中手动开启。
        </p>
      </header>

      {remindersError && (
        <div className="reminders-page__error">
          <span>加载提醒失败：{remindersError}</span>
          <button onClick={() => void loadReminders()}>重试</button>
        </div>
      )}

      {/* 012 新增：合并建议区（来自 Linker 的 merge_suggestion） */}
      {validMergeSuggestions.length > 0 && (
        <section className="reminders-page__merge-suggestions">
          <div className="reminders-page__merge-header">
            <h3 className="reminders-page__merge-title">
              合并建议
              <span className="reminders-page__merge-count">
                {validMergeSuggestions.length}
              </span>
            </h3>
            <p className="reminders-page__merge-sub">
              Recall 检测到可能是同一项目/同一人物的不同叫法，确认后会把关联记忆合并到右侧目标。
            </p>
          </div>

          {mergeError && (
            <div className="reminders-page__merge-error">
              <span>合并操作失败：{mergeError}</span>
              <button onClick={() => setMergeError(null)}>关闭</button>
            </div>
          )}

          <div className="reminders-page__merge-list">
            {validMergeSuggestions.map((item) => {
              const payload = parseMergePayload(item.payloadJson)!;
              const isProcessing = mergingId === item.id;
              return (
                <div key={item.id} className="merge-suggestion-card">
                  <div className="merge-suggestion-card__header">
                    <span
                      className={
                        "merge-suggestion-card__type " +
                        (payload.objectType === "person"
                          ? "merge-suggestion-card__type--person"
                          : "merge-suggestion-card__type--project")
                      }
                    >
                      {OBJECT_TYPE_LABEL[payload.objectType]}
                    </span>
                    {typeof payload.confidence === "number" && (
                      <span className="merge-suggestion-card__confidence">
                        置信度 {(payload.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>

                  <div className="merge-suggestion-card__body">
                    <div className="merge-suggestion-card__arrow">
                      <span className="merge-suggestion-card__from">
                        {payload.fromName}
                      </span>
                      <span className="merge-suggestion-card__arrow-icon">→</span>
                      <span className="merge-suggestion-card__to">
                        {payload.toName}
                      </span>
                    </div>

                    {item.body && (
                      <p className="merge-suggestion-card__reason">{item.body}</p>
                    )}
                    {!item.body && item.reason && (
                      <p className="merge-suggestion-card__reason">{item.reason}</p>
                    )}
                    {!item.body && !item.reason && payload.reason && (
                      <p className="merge-suggestion-card__reason">{payload.reason}</p>
                    )}
                  </div>

                  <div className="merge-suggestion-card__actions">
                    <button
                      className="primary"
                      disabled={isProcessing}
                      onClick={() => void handleConfirmMerge(item)}
                    >
                      {isProcessing ? "处理中..." : "确认合并"}
                    </button>
                    <button
                      disabled={isProcessing}
                      onClick={() => void handleRejectMerge(item)}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {mergeSuggestionsLoading && validMergeSuggestions.length === 0 && (
        <p className="state-loading">正在加载合并建议...</p>
      )}

      <div className="reminders-page__filters">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            className={
              "reminders-filter" + (filter === opt.key ? " reminders-filter--active" : "")
            }
            onClick={() => setFilter(opt.key)}
          >
            {opt.label}
          </button>
        ))}
        <span className="reminders-page__count">
          共 {filteredReminders.length} 条
        </span>
      </div>

      {remindersLoading && reminders.length === 0 ? (
        <p className="state-loading">正在加载提醒...</p>
      ) : filteredReminders.length === 0 ? (
        <div className="reminders-empty">
          <p>当前没有提醒。</p>
          <p className="empty-state__hint">
            Recall 在判断出可能需要关注的事项时，会在这里显示。
          </p>
        </div>
      ) : (
        <div className="reminders-list">
          {filteredReminders.map((r) => (
            <div key={r.id}>
              <ReminderCard
                id={r.id}
                type={r.type as ReminderType}
                title={r.title}
                reason={r.reason}
                sourceCount={r.sourceFactIds.length + r.sourceSceneIds.length}
                confidence={r.priority}
                status={r.status}
                createdAt={r.createdAt}
                requiresUserConfirmation={r.requiresUserConfirmation}
                onConfirm={handleConfirm}
                onIgnore={handleIgnore}
                onSnooze={handleSnooze}
                onMarkComplete={handleMarkComplete}
                onEdit={handleEdit}
                onMuteSimilar={handleMuteSimilar}
              />
              {editingId === r.id && (
                <div className="reminder-edit">
                  <p className="reminder-edit__hint">
                    编辑备注将写入 user_feedback，后续 Judge 和 Linker 会参考你的反馈。
                  </p>
                  <textarea
                    className="reminder-edit__textarea"
                    value={editNote}
                    onChange={(e) => setEditNote(e.target.value)}
                    placeholder="例如：内容不准确 / 项目归属错了 / 这不是任务"
                    rows={3}
                  />
                  {editError && (
                    <p className="reminder-edit__error">{editError}</p>
                  )}
                  <div className="reminder-edit__actions">
                    <button className="primary" onClick={handleEditSubmit}>
                      保存
                    </button>
                    <button onClick={handleEditCancel}>取消</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 类型说明（来自 08 文档"提醒类型颜色"） */}
      {reminders.length > 0 && (
        <div className="reminders-legend">
          <span className="reminders-legend__title">类型说明：</span>
          <span className="reminders-legend__item">
            <span
              className="reminders-legend__dot"
              style={{ backgroundColor: "var(--recall-amber)" }}
            />
            待确认
          </span>
          <span className="reminders-legend__item">
            <span
              className="reminders-legend__dot"
              style={{ backgroundColor: "var(--recall-accent)" }}
            />
            任务提醒
          </span>
          <span className="reminders-legend__item">
            <span
              className="reminders-legend__dot"
              style={{ backgroundColor: "var(--recall-danger)" }}
            />
            风险
          </span>
          <span className="reminders-legend__item">
            <span
              className="reminders-legend__dot"
              style={{ backgroundColor: "var(--recall-text-muted)" }}
            />
            项目进展
          </span>
        </div>
      )}

      <style>{`
        .reminders-page__error {
          background-color: #fbeeeb;
          border: 1px solid var(--recall-danger);
          border-radius: var(--radius-md);
          padding: 12px 16px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: var(--recall-danger);
          font-size: 13px;
        }
        .reminders-page__count {
          margin-left: 8px;
          color: var(--recall-text-muted);
          font-size: 12px;
          align-self: center;
        }
        .reminder-edit {
          margin-top: 8px;
          padding: 12px;
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
        }
        .reminder-edit__hint {
          font-size: 12px;
          color: var(--recall-text-muted);
          margin: 0 0 8px 0;
        }
        .reminder-edit__textarea {
          width: 100%;
          padding: 8px;
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          font-family: inherit;
          font-size: 13px;
          resize: vertical;
          min-height: 60px;
        }
        .reminder-edit__textarea:focus {
          outline: none;
          border-color: var(--recall-accent);
        }
        .reminder-edit__error {
          margin: 8px 0 0 0;
          font-size: 12px;
          color: var(--recall-danger);
        }
        .reminder-edit__actions {
          display: flex;
          gap: 6px;
          margin-top: 8px;
        }
        .reminders-legend {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          font-size: 12px;
          color: var(--recall-text-muted);
          padding: 12px 16px;
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          align-items: center;
        }
        .reminders-legend__title {
          font-weight: 500;
        }
        .reminders-legend__item {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .reminders-legend__dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }

        /* 012 新增：合并建议区样式 */
        .reminders-page__merge-suggestions {
          margin-bottom: 24px;
          padding: 16px;
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-amber);
          border-radius: var(--radius-md);
        }
        .reminders-page__merge-header {
          margin-bottom: 12px;
        }
        .reminders-page__merge-title {
          margin: 0 0 4px 0;
          font-size: 16px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .reminders-page__merge-count {
          display: inline-block;
          min-width: 20px;
          padding: 2px 8px;
          background-color: var(--recall-amber);
          color: #fff;
          font-size: 12px;
          font-weight: 500;
          border-radius: 999px;
          text-align: center;
        }
        .reminders-page__merge-sub {
          margin: 0;
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .reminders-page__merge-error {
          background-color: #fbeeeb;
          border: 1px solid var(--recall-danger);
          border-radius: var(--radius-md);
          padding: 8px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          color: var(--recall-danger);
          font-size: 13px;
          margin-bottom: 12px;
        }
        .reminders-page__merge-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .merge-suggestion-card {
          padding: 12px 14px;
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .merge-suggestion-card__header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 8px;
        }
        .merge-suggestion-card__type {
          display: inline-block;
          padding: 2px 8px;
          font-size: 11px;
          font-weight: 500;
          border-radius: 4px;
        }
        .merge-suggestion-card__type--person {
          background-color: #e8f1ff;
          color: #1f6feb;
        }
        .merge-suggestion-card__type--project {
          background-color: #e7f8ee;
          color: #1a7f37;
        }
        .merge-suggestion-card__confidence {
          font-size: 11px;
          color: var(--recall-text-muted);
        }
        .merge-suggestion-card__body {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .merge-suggestion-card__arrow {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 14px;
          font-weight: 500;
        }
        .merge-suggestion-card__from {
          color: var(--recall-text-muted);
          text-decoration: line-through;
        }
        .merge-suggestion-card__arrow-icon {
          color: var(--recall-amber);
          font-weight: 600;
        }
        .merge-suggestion-card__to {
          color: var(--recall-text);
          font-weight: 600;
        }
        .merge-suggestion-card__reason {
          margin: 0;
          font-size: 12px;
          color: var(--recall-text-muted);
          line-height: 1.5;
        }
        .merge-suggestion-card__actions {
          display: flex;
          gap: 6px;
        }
        .merge-suggestion-card__actions button {
          padding: 6px 12px;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
