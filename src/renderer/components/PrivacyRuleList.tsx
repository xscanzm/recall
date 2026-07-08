// src/renderer/components/PrivacyRuleList.tsx
// 隐私规则列表（来自 08 文档）
//
// 显示：用户配置的隐私黑名单（app name / window title keyword / domain keyword）
// 完整 CRUD：添加、编辑、删除、启用/禁用
// 规则类型：
// - app_name：应用名（精确匹配）
// - window_title_keyword：窗口标题关键词（包含匹配）
// - domain_keyword：域名关键词（包含匹配）
// 动作：
// - exclude：完全排除，不采集、不调用模型
// - ask_before_capture：采集前询问（MVP 暂按 exclude 处理）
// - blur_sensitive：采集但模糊敏感内容（MVP 暂按 exclude 处理）

import { useEffect, useState } from "react";
import type { PrivacyRuleItem } from "../state/store";

export type PrivacyRuleType = PrivacyRuleItem["type"];
export type PrivacyRuleAction = PrivacyRuleItem["action"];

export interface PrivacyRuleListProps {
  /**
   * 当前规则列表（由父组件从 store 传入）
   */
  rules: PrivacyRuleItem[];
  /**
   * 是否正在加载
   */
  loading?: boolean;
  /**
   * 错误信息
   */
  error?: string | null;
  /**
   * 添加规则回调
   */
  onAdd: (input: {
    type: PrivacyRuleType;
    pattern: string;
    action: PrivacyRuleAction;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 更新规则回调（pattern / action / enabled）
   */
  onUpdate: (
    id: string,
    patch: Partial<Pick<PrivacyRuleItem, "pattern" | "action" | "enabled">>
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 删除规则回调
   */
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 空列表提示
   */
  emptyHint?: string;
}

const TYPE_LABELS: Record<PrivacyRuleType, string> = {
  app_name: "应用名",
  window_title_keyword: "窗口标题关键词",
  domain_keyword: "域名关键词",
};

const TYPE_DESCRIPTIONS: Record<PrivacyRuleType, string> = {
  app_name: "精确匹配应用名（如 1Password、银行）",
  window_title_keyword: "窗口标题包含关键词时触发（如 password、login）",
  domain_keyword: "URL/域名包含关键词时触发（如 bank.com）",
};

const ACTION_LABELS: Record<PrivacyRuleAction, string> = {
  exclude: "完全排除",
  ask_before_capture: "采集前询问",
  blur_sensitive: "模糊敏感内容",
};

/**
 * 表单字段
 */
interface FormFields {
  type: PrivacyRuleType;
  pattern: string;
  action: PrivacyRuleAction;
}

const DEFAULT_FIELDS: FormFields = {
  type: "app_name",
  pattern: "",
  action: "exclude",
};

export function PrivacyRuleList(props: PrivacyRuleListProps) {
  const { rules, loading, error, onAdd, onUpdate, onDelete, emptyHint } = props;

  // 表单状态
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fields, setFields] = useState<FormFields>(DEFAULT_FIELDS);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // 重置表单
  useEffect(() => {
    setFormError(null);
  }, [showForm, editingId]);

  /**
   * 开始新增
   */
  const handleStartCreate = () => {
    setEditingId(null);
    setFields(DEFAULT_FIELDS);
    setShowForm(true);
  };

  /**
   * 开始编辑
   */
  const handleStartEdit = (rule: PrivacyRuleItem) => {
    setEditingId(rule.id);
    setFields({
      type: rule.type,
      pattern: rule.pattern,
      action: rule.action,
    });
    setShowForm(true);
  };

  /**
   * 取消表单
   */
  const handleCancel = () => {
    setEditingId(null);
    setFields(DEFAULT_FIELDS);
    setShowForm(false);
    setFormError(null);
  };

  /**
   * 提交表单（创建或更新）
   * 注意：type 字段在编辑模式下不可改（避免规则语义错乱）
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const pattern = fields.pattern.trim();
    if (!pattern) {
      setFormError("请填写规则内容");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const result = editingId
        ? await onUpdate(editingId, {
            pattern,
            action: fields.action,
          })
        : await onAdd({
            type: fields.type,
            pattern,
            action: fields.action,
          });
      if (result.ok) {
        setFields(DEFAULT_FIELDS);
        setEditingId(null);
        setShowForm(false);
      } else {
        setFormError(result.error ?? "保存失败");
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 切换规则启停状态
   */
  const handleToggle = async (rule: PrivacyRuleItem) => {
    setToggling(rule.id);
    try {
      await onUpdate(rule.id, { enabled: !rule.enabled });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "切换失败");
    } finally {
      setToggling(null);
    }
  };

  /**
   * 删除规则
   */
  const handleDelete = async (rule: PrivacyRuleItem) => {
    const confirmed = window.confirm(
      `确认删除规则「${TYPE_LABELS[rule.type]}：${rule.pattern}」？`
    );
    if (!confirmed) return;
    setDeleting(rule.id);
    try {
      const result = await onDelete(rule.id);
      if (!result.ok) {
        window.alert(result.error ?? "删除失败");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="privacy-rule-list">
      <div className="privacy-rule-list__header">
        <p className="privacy-rule-list__intro">
          黑名单规则用于阻止 Recall 采集特定应用、窗口标题或域名。
          匹配时不会截图、不会调用模型、不会保存任何数据。
        </p>
      </div>

      <div className="privacy-rule-list__list-wrap">
        {loading ? (
          <p className="privacy-rule-list__empty">加载中...</p>
        ) : rules.length === 0 ? (
          <p className="privacy-rule-list__empty">
            {emptyHint ?? "暂无隐私规则。点击下方按钮新增。"}
          </p>
        ) : (
          <ul className="privacy-rule-list__list">
            {rules.map((rule) => (
              <li key={rule.id} className="privacy-rule-list__item">
                <div className="privacy-rule-list__item-main">
                  <span
                    className={`privacy-rule-list__type privacy-rule-list__type--${rule.type}`}
                  >
                    {TYPE_LABELS[rule.type]}
                  </span>
                  <span className="privacy-rule-list__pattern">{rule.pattern}</span>
                  <span className="privacy-rule-list__action">
                    {ACTION_LABELS[rule.action]}
                  </span>
                  <span
                    className={`privacy-rule-list__status ${
                      rule.enabled ? "is-enabled" : "is-disabled"
                    }`}
                  >
                    {rule.enabled ? "已启用" : "已禁用"}
                  </span>
                </div>
                <div className="privacy-rule-list__item-actions">
                  <label className="privacy-rule-list__toggle">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => handleToggle(rule)}
                      disabled={toggling === rule.id}
                    />
                    <span>{toggling === rule.id ? "切换中..." : "启用"}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleStartEdit(rule)}
                    disabled={deleting === rule.id || toggling === rule.id}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="privacy-rule-list__delete-btn"
                    onClick={() => handleDelete(rule)}
                    disabled={deleting === rule.id || toggling === rule.id}
                  >
                    {deleting === rule.id ? "删除中..." : "删除"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!showForm ? (
        <div className="privacy-rule-list__actions">
          <button
            type="button"
            className="primary privacy-rule-list__add-btn"
            onClick={handleStartCreate}
          >
            新增规则
          </button>
        </div>
      ) : (
        <form className="privacy-rule-form" onSubmit={handleSubmit}>
          <h4 className="privacy-rule-form__subtitle">
            {editingId ? "编辑规则" : "新增规则"}
          </h4>

          <div className="privacy-rule-form__field">
            <label>规则类型</label>
            <select
              value={fields.type}
              onChange={(e) =>
                setFields({ ...fields, type: e.target.value as PrivacyRuleType })
              }
              disabled={!!editingId}
            >
              <option value="app_name">{TYPE_LABELS.app_name}</option>
              <option value="window_title_keyword">{TYPE_LABELS.window_title_keyword}</option>
              <option value="domain_keyword">{TYPE_LABELS.domain_keyword}</option>
            </select>
            <p className="privacy-rule-form__hint">
              {TYPE_DESCRIPTIONS[fields.type]}
              {editingId && " 编辑模式下不可更改规则类型。"}
            </p>
          </div>

          <div className="privacy-rule-form__field">
            <label>规则内容</label>
            <input
              type="text"
              value={fields.pattern}
              onChange={(e) => setFields({ ...fields, pattern: e.target.value })}
              placeholder={
                fields.type === "app_name"
                  ? "例如：1Password / 银行 / 支付"
                  : fields.type === "window_title_keyword"
                  ? "例如：password / login / bank"
                  : "例如：bank.com / pay.example.com"
              }
              required
            />
          </div>

          <div className="privacy-rule-form__field">
            <label>处理方式</label>
            <select
              value={fields.action}
              onChange={(e) =>
                setFields({ ...fields, action: e.target.value as PrivacyRuleAction })
              }
            >
              <option value="exclude">{ACTION_LABELS.exclude}</option>
              <option value="ask_before_capture">{ACTION_LABELS.ask_before_capture}</option>
              <option value="blur_sensitive">{ACTION_LABELS.blur_sensitive}</option>
            </select>
            <p className="privacy-rule-form__hint">
              MVP 阶段三种动作均按"完全排除"处理，未来版本会区分询问和模糊。
            </p>
          </div>

          <div className="privacy-rule-form__actions">
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? "保存中..." : editingId ? "更新规则" : "保存规则"}
            </button>
            <button type="button" onClick={handleCancel} disabled={submitting}>
              取消
            </button>
          </div>

          {formError && <p className="privacy-rule-form__error">{formError}</p>}
        </form>
      )}

      {error && <p className="privacy-rule-list__error">{error}</p>}

      <style>{`
        .privacy-rule-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .privacy-rule-list__intro {
          margin: 0;
          font-size: 12px;
          color: var(--recall-text-muted);
          line-height: 1.6;
        }
        .privacy-rule-list__list-wrap {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 12px;
        }
        .privacy-rule-list__empty {
          margin: 0;
          color: var(--recall-text-muted);
          font-size: 13px;
          text-align: center;
          padding: 16px 0;
        }
        .privacy-rule-list__list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .privacy-rule-list__item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-md);
          border: 1px solid var(--recall-border);
          flex-wrap: wrap;
          gap: 8px;
        }
        .privacy-rule-list__item-main {
          display: flex;
          gap: 10px;
          align-items: center;
          flex: 1;
          min-width: 0;
          flex-wrap: wrap;
        }
        .privacy-rule-list__type {
          font-size: 11px;
          color: var(--recall-text-muted);
          background-color: var(--recall-surface);
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--recall-border);
          white-space: nowrap;
        }
        .privacy-rule-list__type--app_name {
          color: var(--recall-amber);
          border-color: var(--recall-amber);
        }
        .privacy-rule-list__pattern {
          font-weight: 500;
          font-size: 13px;
          word-break: break-all;
        }
        .privacy-rule-list__action {
          font-size: 11px;
          color: var(--recall-amber);
          white-space: nowrap;
        }
        .privacy-rule-list__status {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--recall-border);
          white-space: nowrap;
        }
        .privacy-rule-list__status.is-enabled {
          color: var(--recall-accent);
          border-color: var(--recall-accent);
        }
        .privacy-rule-list__status.is-disabled {
          color: var(--recall-text-muted);
        }
        .privacy-rule-list__item-actions {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .privacy-rule-list__toggle {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: var(--recall-text-muted);
          cursor: pointer;
        }
        .privacy-rule-list__item-actions button {
          padding: 4px 10px;
          font-size: 12px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
        }
        .privacy-rule-list__item-actions button:hover:not(:disabled) {
          background-color: var(--recall-bg);
        }
        .privacy-rule-list__delete-btn {
          color: var(--recall-danger) !important;
          border-color: var(--recall-danger) !important;
        }
        .privacy-rule-list__actions {
          display: flex;
          gap: 8px;
        }
        .privacy-rule-list__add-btn {
          padding: 6px 14px;
          font-size: 13px;
        }
        .privacy-rule-list__error {
          margin: 0;
          font-size: 12px;
          color: var(--recall-danger);
        }
        .privacy-rule-form {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .privacy-rule-form__subtitle {
          font-size: 13px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .privacy-rule-form__field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .privacy-rule-form__field label {
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .privacy-rule-form__field input,
        .privacy-rule-form__field select {
          padding: 6px 10px;
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          font-family: inherit;
          font-size: 13px;
          background-color: var(--recall-surface);
        }
        .privacy-rule-form__field select:disabled {
          background-color: var(--recall-bg);
          cursor: not-allowed;
        }
        .privacy-rule-form__hint {
          margin: 0;
          font-size: 11px;
          color: var(--recall-text-muted);
          line-height: 1.5;
        }
        .privacy-rule-form__actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .privacy-rule-form__actions button {
          padding: 6px 14px;
          font-size: 12px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
        }
        .privacy-rule-form__actions button.primary {
          background-color: var(--recall-accent);
          color: white;
          border-color: var(--recall-accent);
        }
        .privacy-rule-form__actions button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .privacy-rule-form__error {
          margin: 0;
          font-size: 12px;
          color: var(--recall-danger);
        }
      `}</style>
    </div>
  );
}
