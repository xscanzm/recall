// src/renderer/components/MergeDialog.tsx
// 012/013 新增：人物 / 项目合并对话框
//
// 用途：
// - 人物页 / 项目页点击"合并到..."按钮时弹出
// - 列出可合并的目标（同类型的所有非 from 项）
// - 用户选择目标 + 确认后调用 memory:mergeObjects
//
// 行为：
// - to 的名字保留，from 的 name 追加到 to.aliases
// - facts.projectHint/projectId 改写（项目合并）
// - facts.people_hints 改写（人物合并）
// - scenes.entityNames 改写
// - object_merges 审计
//
// 重要约束：
// - 不使用 emoji
// - soft delete from，from 仍可审计追溯

import { useState, useEffect, useMemo, useRef } from "react";
import { useAppStore, type PersonItem, type ProjectItem } from "../state/store";
import { useFocusTrap } from "../hooks/useFocusTrap";

export interface MergeDialogProps {
  open: boolean;
  objectType: "person" | "project";
  fromId: string;
  fromName: string;
  onClose: () => void;
  onMerged?: () => void;
}

/**
 * 合并对话框（人物 / 项目）
 */
export function MergeDialog({
  open,
  objectType,
  fromId,
  fromName,
  onClose,
  onMerged,
}: MergeDialogProps) {
  const people = useAppStore((s) => s.todayData.people);
  const projects = useAppStore((s) => s.todayData.projects);
  const mergeObjects = useAppStore((s) => s.mergeObjects);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { enabled: open, onEscape: onClose });

  const [targetId, setTargetId] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 候选目标列表：同类型 + 排除 from 自身 + 按 lastActiveAt / updatedAt 倒序
  const candidates = useMemo(() => {
    if (objectType === "person") {
      return people
        .filter((p) => p.id !== fromId && !p.deletedAt)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    }
    return projects
      .filter((p) => p.id !== fromId && !p.archivedAt)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }, [objectType, people, projects, fromId]);

  // 选中的目标
  const target: PersonItem | ProjectItem | undefined = useMemo(() => {
    if (!targetId) return undefined;
    if (objectType === "person") {
      return people.find((p) => p.id === targetId);
    }
    return projects.find((p) => p.id === targetId);
  }, [targetId, objectType, people, projects]);

  // open 变化时重置
  useEffect(() => {
    if (open) {
      setTargetId("");
      setReason("");
      setSubmitting(false);
      setError(null);
    }
  }, [open, fromId, objectType]);

  const canSubmit = useMemo(() => {
    if (!targetId || targetId === fromId) return false;
    return true;
  }, [targetId, fromId]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await mergeObjects({
        objectType,
        fromId,
        toId: targetId,
        reason: reason.trim() || undefined,
      });
      setSubmitting(false);
      // 成功提示走应用内确认框（a11y 批量：不再用原生 alert）
      const stats = `改写 ${result.rewrittenFactsCount} 个事实，${result.rewrittenScenesCount} 个场景，添加 ${result.mergedAliases.length} 个别名`;
      requestConfirm({
        title: "合并完成",
        message: `已合并「${fromName}」到「${target?.name ?? targetId}」。${stats}`,
        confirmText: "知道了",
        onConfirm: () => undefined,
      });
      onMerged?.();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const isPerson = objectType === "person";
  const typeLabel = isPerson ? "人物" : "项目";
  const targetName = target ? (target as PersonItem).name : "";

  return (
    <div className="merge-dialog__overlay" onClick={onClose}>
      <div
        className="merge-dialog__modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="merge-dialog__header">
          <h3>合并{typeLabel}</h3>
          <button
            className="merge-dialog__close"
            onClick={onClose}
            aria-label="关闭"
            type="button"
          >
            关闭
          </button>
        </header>

        <div className="merge-dialog__body">
          <p className="merge-dialog__hint">
            源：<strong>{fromName}</strong>（{fromId.slice(0, 12)}...）
          </p>
          <p className="merge-dialog__sub">
            把源{typeLabel}合并到下方选中的目标{typeLabel}：
          </p>
          <ul className="merge-dialog__sub-list">
            <li>目标的名称保留，源的名字会作为别名追加</li>
            <li>
              {isPerson
                ? "历史事实中出现的" + fromName + "会被改写为新名字"
                : "历史事实中的" + fromName + "项目标记会被改写为目标"}
            </li>
            <li>源会被归档（可在审计中追溯）</li>
          </ul>

          <div className="merge-dialog__field">
            <label className="merge-dialog__field-label">
              合并到
              <span className="merge-dialog__field-required">*</span>
            </label>
            {candidates.length === 0 ? (
              <p className="merge-dialog__empty">
                没有可合并的目标{typeLabel}。
              </p>
            ) : (
              <select
                className="merge-dialog__select"
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
              >
                <option value="">-- 选择目标{typeLabel} --</option>
                {candidates.map((c) => {
                  // 通过 objectType 区分：person 走 PersonItem，project 走 ProjectItem
                  const itemName = isPerson
                    ? (c as PersonItem).name
                    : (c as ProjectItem).name;
                  const aliases = c.aliases ?? [];
                  const aliasCount = aliases.length;
                  return (
                    <option key={c.id} value={c.id}>
                      {itemName}
                      {aliasCount > 0 ? `（已合并过 ${aliasCount} 个别名）` : ""}
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          {target && (
            <div className="merge-dialog__preview">
              <p className="merge-dialog__preview-title">合并预览</p>
              <p>
                <strong>{fromName}</strong>（源）→ 合并到 →{" "}
                <strong>{targetName}</strong>（目标）
              </p>
              {target.aliases && target.aliases.length > 0 && (
                <p className="merge-dialog__preview-detail">
                  目标已有别名：{target.aliases.join("、")}
                </p>
              )}
              <p className="merge-dialog__preview-detail">
                合并后目标的别名将包含：<strong>{fromName}</strong>
              </p>
            </div>
          )}

          <div className="merge-dialog__field">
            <label className="merge-dialog__field-label">备注（可选）</label>
            <textarea
              className="merge-dialog__textarea merge-dialog__textarea--note"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="补充说明（选填，会写入合并审计）"
              rows={2}
            />
          </div>

          {error && <p className="merge-dialog__error">{error}</p>}
        </div>

        <footer className="merge-dialog__footer">
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
          >
            {submitting ? "合并中..." : "确认合并"}
          </button>
        </footer>
      </div>
    </div>
  );
}
