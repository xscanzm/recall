// src/renderer/components/CorrectionDialog.tsx
// 用户纠错对话框（来自 spec.md "用户纠错"章节）
//
// 7 种纠错类型（来自 spec.md "用户纠错类型"）：
// - content_wrong        内容错了
// - not_important        不重要
// - wrong_project        项目归属错了
// - task_done             这个任务已完成
// - not_a_task           这不是任务
// - do_not_record        不要记这类内容
// - sensitive_delete     这是敏感内容删除
//
// 行为：
// - 保存 edit history（通过 patch 更新对应对象，不覆盖 source ids）
// - 写入 user_feedback
// - 后续 Judge 和 Linker 调用时带入用户反馈摘要
//
// 重要约束（来自 spec.md）：
// - 不使用 emoji
// - soft delete 优先
// - 不覆盖 source ids
// - 中文注释

import { useState, useEffect, useMemo, useRef } from "react";
import { useAppStore, type FeedbackType, type FeedbackTargetType } from "../state/store";
import { NAMING } from "../app/naming";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface CorrectionDialogProps {
  open: boolean;
  targetType: FeedbackTargetType;
  targetId: string;
  onClose: () => void;
  onSubmitted?: () => void;
}

/**
 * 纠错类型选项（来自 spec.md 7 种类型）
 * 不使用 emoji，使用中文标签
 */
const FEEDBACK_OPTIONS: Array<{
  value: FeedbackType;
  label: string;
  description: string;
  needContent: boolean;
  needProject: boolean;
}> = [
  {
    value: "content_wrong",
    label: "内容错了",
    description: "修改内容，后续生成会更准确",
    needContent: true,
    needProject: false,
  },
  {
    value: "not_important",
    label: "不重要",
    description: "降低重要度，减少后续提醒",
    needContent: false,
    needProject: false,
  },
  {
    value: "wrong_project",
    label: "项目归属错了",
    description: "改到正确的项目下",
    needContent: false,
    needProject: true,
  },
  {
    value: "task_done",
    label: "这个任务已完成",
    description: "标记为已完成（仅任务/提醒）",
    needContent: false,
    needProject: false,
  },
  {
    value: "not_a_task",
    label: "这不是任务",
    description: "归档删除这条记录",
    needContent: false,
    needProject: false,
  },
  {
    value: "do_not_record",
    label: "不要记这类内容",
    description: "归档删除并避免后续记录类似内容",
    needContent: false,
    needProject: false,
  },
  {
    value: "sensitive_delete",
    label: "这是敏感内容删除",
    description: "彻底删除（敏感内容才硬删除）",
    needContent: false,
    needProject: false,
  },
];

/**
 * 前台命名映射：目标类型 -> 中文标签
 */
const TARGET_TYPE_LABELS: Record<FeedbackTargetType, string> = {
  fact: NAMING.fact,
  task: NAMING.task,
  scene: NAMING.scene,
  project: NAMING.project,
  person: NAMING.person,
  decision: NAMING.decision,
  reminder: NAMING.proactiveItem,
};

export function CorrectionDialog({
  open,
  targetType,
  targetId,
  onClose,
  onSubmitted,
}: CorrectionDialogProps) {
  const [feedbackType, setFeedbackType] = useState<FeedbackType | null>(null);
  const [content, setContent] = useState("");
  const [projectId, setProjectId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createUserFeedback = useAppStore((s) => s.createUserFeedback);
  const projects = useAppStore((s) => s.todayData.projects);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { enabled: open, onEscape: onClose });

  // open 变化时重置状态
  useEffect(() => {
    if (open) {
      setFeedbackType(null);
      setContent("");
      setProjectId("");
      setNote("");
      setSubmitting(false);
      setError(null);
    }
  }, [open, targetType, targetId]);

  // 根据当前选中的 feedbackType 决定是否需要额外输入
  const currentOption = useMemo(
    () => FEEDBACK_OPTIONS.find((o) => o.value === feedbackType),
    [feedbackType]
  );

  // 校验：是否可以提交
  const canSubmit = useMemo(() => {
    if (!feedbackType) return false;
    if (!currentOption) return false;
    if (currentOption.needContent && !content.trim()) return false;
    if (currentOption.needProject && !projectId) return false;
    return true;
  }, [feedbackType, currentOption, content, projectId]);

  const handleSubmit = async () => {
    if (!feedbackType || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      if (currentOption?.needContent) {
        // 根据 targetType 把内容映射到对应字段
        if (targetType === "fact") patch.content = content.trim();
        else if (targetType === "task") {
          patch.title = content.trim();
        } else if (targetType === "project") {
          patch.name = content.trim();
        } else if (targetType === "decision") {
          patch.title = content.trim();
        } else if (targetType === "person") {
          patch.name = content.trim();
        }
      }
      if (currentOption?.needProject) {
        patch.projectId = projectId;
      }
      await createUserFeedback({
        targetType,
        targetId,
        feedbackType,
        note: note.trim() || undefined,
        patch,
      });
      setSubmitting(false);
      onSubmitted?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const targetLabel = TARGET_TYPE_LABELS[targetType] ?? targetType;

  return (
    <div className="correction-dialog__overlay" onClick={onClose}>
      <div
        className="correction-dialog__modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="correction-dialog__header">
          <h3>纠错</h3>
          <button
            className="correction-dialog__close"
            onClick={onClose}
            aria-label="关闭"
            type="button"
          >
            关闭
          </button>
        </header>

        <div className="correction-dialog__body">
          <p className="correction-dialog__hint">
            目标：{targetLabel}（{targetId.slice(0, 12)}...）
          </p>
          <p className="correction-dialog__sub">
            选择纠错类型。修改内容会保存到 edit history 并写入 user_feedback，后续 Judge 和 Linker 会参考你的反馈。
          </p>

          <div className="correction-dialog__options">
            {FEEDBACK_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  "correction-dialog__option" +
                  (feedbackType === opt.value ? " correction-dialog__option--active" : "")
                }
                onClick={() => setFeedbackType(opt.value)}
              >
                <div className="correction-dialog__option-label">{opt.label}</div>
                <div className="correction-dialog__option-desc">{opt.description}</div>
              </button>
            ))}
          </div>

          {/* 根据 feedbackType 显示不同输入字段 */}
          {currentOption?.needContent && (
            <div className="correction-dialog__field">
              <label className="correction-dialog__field-label">
                修改后的内容
                <span className="correction-dialog__field-required">*</span>
              </label>
              <textarea
                className="correction-dialog__textarea"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  targetType === "fact"
                    ? "输入正确的线索内容"
                    : targetType === "task"
                    ? "输入正确的任务标题"
                    : "输入正确的名称"
                }
                rows={3}
              />
            </div>
          )}

          {currentOption?.needProject && (
            <div className="correction-dialog__field">
              <label className="correction-dialog__field-label">
                归属项目
                <span className="correction-dialog__field-required">*</span>
              </label>
              <select
                className="correction-dialog__select"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">-- 选择项目 --</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="correction-dialog__field">
            <label className="correction-dialog__field-label">备注（可选）</label>
            <textarea
              className="correction-dialog__textarea correction-dialog__textarea--note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="补充说明（选填，会写入 user_feedback）"
              rows={2}
            />
          </div>

          {error && <p className="correction-dialog__error">{error}</p>}
        </div>

        <footer className="correction-dialog__footer">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? "提交中..." : "提交纠错"}
          </button>
        </footer>
      </div>
    </div>
  );
}
