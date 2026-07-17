import { useEffect, useState } from "react";
import {
  REPORT_REQUIREMENT_MAX_LENGTH,
  type ReportRequirement,
  type ReportRequirements,
  type ReportRequirementType,
} from "../../shared/reportRequirements";
import "./ReportRequirementsPanel.css";

const TYPE_OPTIONS: Array<{ type: ReportRequirementType; label: string }> = [
  { type: "personal", label: "我的复盘" },
  { type: "work", label: "工作日报" },
  { type: "weekly", label: "周报" },
  { type: "monthly", label: "月报" },
];

const FOCUS_PLACEHOLDERS: Record<ReportRequirementType, string> = {
  personal: "例如：重点回顾决策变化、反复卡住的问题和真正有进展的部分。",
  work: "例如：重点统计客户沟通、完成的交付物、阻塞问题和下一步计划。",
  weekly: "例如：按项目统计本周成果、需求变化、风险和仍未解决的问题。",
  monthly: "例如：重点总结关键里程碑、持续性问题、重要决策和投入方向。",
};

interface ReportRequirementsPanelProps {
  initialType: ReportRequirementType;
  requirements: ReportRequirements;
  onSave: (requirements: ReportRequirements) => Promise<void>;
  onClose: () => void;
}

export function ReportRequirementsPanel({
  initialType,
  requirements,
  onSave,
  onClose,
}: ReportRequirementsPanelProps) {
  const [activeType, setActiveType] = useState(initialType);
  const [draft, setDraft] = useState<ReportRequirements>(() =>
    cloneRequirements(requirements)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, saving]);

  const activeRequirement = draft[activeType];

  const updateField = (field: keyof ReportRequirement, value: string) => {
    setDraft((current) => ({
      ...current,
      [activeType]: {
        ...current[activeType],
        [field]: value,
      },
    }));
    setError(null);
  };

  const clearCurrent = () => {
    setDraft((current) => ({
      ...current,
      [activeType]: { focus: "", presentation: "", reminders: "" },
    }));
    setError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="report-requirements-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="report-requirements-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-requirements-title"
      >
        <header className="report-requirements-panel__header">
          <div>
            <h2 id="report-requirements-title">维护报告要求</h2>
            <p>长期用于以后手动或自动生成的报告，不会修改历史报告。</p>
          </div>
          <button
            type="button"
            className="report-requirements-panel__close"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭报告要求"
          >
            ×
          </button>
        </header>

        <nav className="report-requirements-panel__tabs" aria-label="报告类型">
          {TYPE_OPTIONS.map((option) => (
            <button
              key={option.type}
              type="button"
              className={activeType === option.type ? "is-active" : ""}
              onClick={() => setActiveType(option.type)}
            >
              {option.label}
            </button>
          ))}
        </nav>

        <div className="report-requirements-panel__body">
          <div className="report-requirements-panel__type-heading">
            {TYPE_OPTIONS.find((option) => option.type === activeType)?.label} · 报告要求
          </div>

          <RequirementField
            label="重点关注"
            description="希望这类报告长期重点统计、比较或总结什么。"
            value={activeRequirement.focus}
            placeholder={FOCUS_PLACEHOLDERS[activeType]}
            onChange={(value) => updateField("focus", value)}
          />
          <RequirementField
            label="呈现要求"
            description="对篇幅、结构、语气、数据表达方式的要求。"
            value={activeRequirement.presentation}
            placeholder="例如：先写结论，控制在 500 字以内，风险单独列出，尽量使用明确数据。"
            onChange={(value) => updateField("presentation", value)}
          />
          <RequirementField
            label="注意提醒"
            description="每次生成这类报告时都需要长期遵守的提醒。"
            value={activeRequirement.reminders}
            placeholder="例如：不要把探索中的事项写成已完成；数据不足时明确说明。"
            onChange={(value) => updateField("reminders", value)}
          />

          <p className="report-requirements-panel__guardrail">
            报告要求只影响关注重点和呈现方式，不能覆盖事实依据、来源、隐私和报告结构规则。
          </p>

          {error && <div className="report-requirements-panel__error">{error}</div>}
        </div>

        <footer className="report-requirements-panel__footer">
          <button type="button" className="tb-btn" onClick={clearCurrent} disabled={saving}>
            清空当前报告要求
          </button>
          <div className="report-requirements-panel__footer-actions">
            <button type="button" className="tb-btn" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="tb-btn tb-btn--primary"
              onClick={() => void handleSave()}
              disabled={saving}
            >
              {saving ? "保存中..." : "保存要求"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function RequirementField(props: {
  label: string;
  description: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="report-requirements-field">
      <span className="report-requirements-field__label">{props.label}</span>
      <span className="report-requirements-field__description">{props.description}</span>
      <textarea
        value={props.value}
        placeholder={props.placeholder}
        maxLength={REPORT_REQUIREMENT_MAX_LENGTH}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <span className="report-requirements-field__count">
        {props.value.length}/{REPORT_REQUIREMENT_MAX_LENGTH}
      </span>
    </label>
  );
}

function cloneRequirements(requirements: ReportRequirements): ReportRequirements {
  return {
    personal: { ...requirements.personal },
    work: { ...requirements.work },
    weekly: { ...requirements.weekly },
    monthly: { ...requirements.monthly },
  };
}
