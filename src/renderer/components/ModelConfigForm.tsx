// src/renderer/components/ModelConfigForm.tsx
// 模型配置表单（来自 08 文档）
//
// 用于配置视觉模型和语言模型（分开配置 endpoint / model / api key）
// 完整 CRUD：创建/编辑/删除 + 测试连接
//
// 安全约束：
// - API Key 不进 renderer 状态管理（避免被持久化）
// - API Key 不进日志
// - API Key 输入框 type=password
// - 测试失败时不显示完整 key
// - 提交后 API Key 通过 IPC 直接送入 main 进程的 SecretService
// - 编辑现有配置时不显示已存的 API Key（重新输入则覆盖，留空则保留原 key）
// - 删除模型配置时同时删除 SecretService 中对应 key（由后端处理）

import { useEffect, useState } from "react";
import type { ModelConfigItem } from "../state/store";

export type ModelKind = "vision" | "language" | "multimodal";

export interface ModelConfigFormProps {
  /**
   * 模型类型：视觉 / 语言
   */
  kind: ModelKind;
  /**
   * 当前 kind 下的全部配置（由父组件从 store 传入）
   */
  configs: ModelConfigItem[];
  /**
   * 是否正在加载
   */
  loading?: boolean;
  /**
   * 错误信息
   */
  error?: string | null;
  /**
   * 保存配置回调（创建或更新）
   * 返回 { ok, warning?, error? }
   */
  onSave: (input: {
    id?: string;
    kind: ModelKind;
    providerName: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    enabled?: boolean;
    // Phase 7：可选字段，留空时使用模型默认值
    temperature?: number;
    maxTokens?: number;
  }) => Promise<{ ok: boolean; warning?: string; error?: string }>;
  /**
   * 删除配置回调
   * 返回 { ok, error? }
   */
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  /**
   * 测试连接回调
   * 返回 { ok, code?, message? }
   */
  onTest: (input: {
    kind: ModelKind;
    endpoint: string;
    model: string;
    apiKey: string;
  }) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /**
   * 是否为引导模式（Onboarding 使用）
   * - true：隐藏已有配置列表，只显示表单
   * - false：显示完整 CRUD 界面
   */
  wizardMode?: boolean;
  /**
   * 引导模式下保存成功后的回调
   */
  onSaved?: () => void;
}

/**
 * 表单字段类型
 */
interface FormFields {
  providerName: string;
  endpoint: string;
  model: string;
  apiKey: string;
  // Phase 7：可选字段，留空（undefined）时使用模型默认值
  temperature?: number;
  maxTokens?: number;
}

const EMPTY_FIELDS: FormFields = {
  providerName: "",
  endpoint: "",
  model: "",
  apiKey: "",
  temperature: undefined,
  maxTokens: undefined,
};

export function ModelConfigForm(props: ModelConfigFormProps) {
  const { kind, configs, loading, error, onSave, onDelete, onTest, wizardMode, onSaved } = props;

  // 编辑中的配置 id（null 表示新建模式）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS);
  const [showForm, setShowForm] = useState<boolean>(wizardMode ?? false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState<boolean | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  // 引导模式下默认显示表单
  useEffect(() => {
    if (wizardMode) {
      setShowForm(true);
    }
  }, [wizardMode]);

  // 切换 kind 时重置表单
  useEffect(() => {
    setEditingId(null);
    setFields(EMPTY_FIELDS);
    setShowForm(wizardMode ?? false);
    setFormError(null);
    setWarning(null);
    setTestResult(null);
    setTestOk(null);
  }, [kind, wizardMode]);

  const kindLabel =
    kind === "vision" ? "视觉模型" : kind === "language" ? "语言模型" : "多模态模型";
  const kindDescription =
    kind === "vision"
      ? "用于分析屏幕截图，识别窗口内容、实体和可能意图。"
      : kind === "language"
      ? "用于提取线索、构建场景、生成报告和回答用户问题。"
      : "同时支持视觉和语言任务，可替代分开配置的视觉模型与语言模型。";

  /**
   * 开始新建配置
   */
  const handleStartCreate = () => {
    setEditingId(null);
    setFields(EMPTY_FIELDS);
    setFormError(null);
    setWarning(null);
    setTestResult(null);
    setTestOk(null);
    setShowForm(true);
  };

  /**
   * 开始编辑现有配置
   * 注意：不加载已存的 API Key（API Key 不返回 renderer）
   * 留空 API Key 表示保留原 key
   * Phase 7：从 optionsJson 解析 temperature/maxTokens 填入表单
   */
  const handleStartEdit = (config: ModelConfigItem) => {
    // 从 optionsJson 解析 temperature / max_tokens
    let temperature: number | undefined;
    let maxTokens: number | undefined;
    try {
      const opts = JSON.parse(config.optionsJson || "{}");
      if (opts && typeof opts === "object" && !Array.isArray(opts)) {
        if (typeof opts.temperature === "number") temperature = opts.temperature;
        if (typeof opts.max_tokens === "number") maxTokens = opts.max_tokens;
      }
    } catch {
      // optionsJson 损坏时忽略，使用 undefined
    }
    setEditingId(config.id);
    setFields({
      providerName: config.providerName,
      endpoint: config.endpoint,
      model: config.model,
      apiKey: "", // 不显示已存 key，留空保留原 key
      temperature,
      maxTokens,
    });
    setFormError(null);
    setWarning(null);
    setTestResult(null);
    setTestOk(null);
    setShowForm(true);
  };

  /**
   * 取消编辑
   */
  const handleCancel = () => {
    setEditingId(null);
    setFields(EMPTY_FIELDS);
    setShowForm(wizardMode ?? false);
    setFormError(null);
    setWarning(null);
    setTestResult(null);
    setTestOk(null);
  };

  /**
   * 测试连接
   * - 新建模式：必须输入 apiKey
   * - 编辑模式：如果 apiKey 留空，提示需输入用于测试
   * 安全约束：失败时不显示完整 API Key（由 main 端 sanitize）
   */
  const handleTest = async () => {
    if (!fields.endpoint || !fields.model) {
      setTestOk(false);
      setTestResult("请填写 endpoint 和 model");
      return;
    }
    if (!fields.apiKey) {
      setTestOk(false);
      setTestResult(
        editingId
          ? "请输入 API Key 用于测试（测试不会保存 key）"
          : "请填写 API Key"
      );
      return;
    }
    setTesting(true);
    setTestResult(null);
    setTestOk(null);
    try {
      const result = await onTest({
        kind,
        endpoint: fields.endpoint,
        model: fields.model,
        apiKey: fields.apiKey,
      });
      setTestOk(result.ok);
      // 安全：测试失败时不显示完整 key（main 端已 sanitize）
      setTestResult(result.ok ? "连接成功" : result.message ?? "连接失败");
    } catch (err) {
      setTestOk(false);
      setTestResult(err instanceof Error ? err.message : "测试失败");
    } finally {
      setTesting(false);
    }
  };

  /**
   * 保存配置（创建或更新）
   * - apiKey 留空（编辑模式）：保留原 key
   * - apiKey 有值：覆盖原 key
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fields.providerName || !fields.endpoint || !fields.model) {
      setFormError("请填写 Provider 名称、Endpoint URL 和 Model 名称");
      return;
    }
    // 新建模式必须输入 apiKey
    if (!editingId && !fields.apiKey) {
      setFormError("新建配置时必须填写 API Key");
      return;
    }
    setSaving(true);
    setFormError(null);
    setWarning(null);
    try {
      const result = await onSave({
        id: editingId ?? undefined,
        kind,
        providerName: fields.providerName,
        endpoint: fields.endpoint,
        model: fields.model,
        apiKey: fields.apiKey || undefined, // 留空则不传，保留原 key
        temperature: fields.temperature, // undefined 时后端不写入 options_json
        maxTokens: fields.maxTokens,     // undefined 时后端不写入 options_json
      });
      if (result.ok) {
        // 提交后立即清空 apiKey 输入框
        setFields(EMPTY_FIELDS);
        setEditingId(null);
        setShowForm(wizardMode ?? false);
        if (result.warning) {
          setWarning(result.warning);
        }
        if (wizardMode && onSaved) {
          onSaved();
        }
      } else {
        setFormError(result.error ?? "保存失败");
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  /**
   * 删除配置
   * 后端会同时删除 SecretService 中的 API Key
   */
  const handleDelete = async (config: ModelConfigItem) => {
    const confirmed = window.confirm(
      `确认删除 ${kindLabel}配置「${config.providerName} / ${config.model}」？\n\n对应的 API Key 会从系统安全存储中一并删除。`
    );
    if (!confirmed) return;
    setDeleting(config.id);
    try {
      const result = await onDelete(config.id);
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
    <div className="model-config">
      <div className="model-config__header">
        <h3 className="model-config__title">{kindLabel}</h3>
        <p className="model-config__desc">{kindDescription}</p>
      </div>

      {!wizardMode && (
        <div className="model-config__list">
          {loading ? (
            <p className="model-config__hint">加载中...</p>
          ) : configs.length === 0 ? (
            <p className="model-config__hint">尚未配置 {kindLabel}。点击下方按钮新增。</p>
          ) : (
            <ul className="model-config__items">
              {configs.map((config) => (
                <li key={config.id} className="model-config__item">
                  <div className="model-config__item-main">
                    <span className="model-config__item-name">
                      {config.providerName}
                    </span>
                    <span className="model-config__item-model">
                      {config.model}
                    </span>
                    <span
                      className={`model-config__item-status ${
                        config.enabled ? "is-enabled" : "is-disabled"
                      }`}
                    >
                      {config.enabled ? "已启用" : "已禁用"}
                    </span>
                  </div>
                  <div className="model-config__item-actions">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(config)}
                      disabled={deleting === config.id}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="model-config__delete-btn"
                      onClick={() => handleDelete(config)}
                      disabled={deleting === config.id}
                    >
                      {deleting === config.id ? "删除中..." : "删除"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!showForm && !wizardMode && (
        <div className="model-config__actions">
          <button
            type="button"
            className="primary model-config__add-btn"
            onClick={handleStartCreate}
          >
            新增 {kindLabel} 配置
          </button>
        </div>
      )}

      {showForm && (
        <form className="model-form" onSubmit={handleSubmit}>
          <h4 className="model-form__subtitle">
            {editingId ? `编辑 ${kindLabel}配置` : `新增 ${kindLabel}配置`}
          </h4>

          <div className="model-form__field">
            <label>Provider 名称</label>
            <input
              type="text"
              value={fields.providerName}
              onChange={(e) => setFields({ ...fields, providerName: e.target.value })}
              placeholder="例如 OpenAI / Azure / 通义千问"
              required
            />
          </div>

          <div className="model-form__field">
            <label>Endpoint URL</label>
            <input
              type="url"
              value={fields.endpoint}
              onChange={(e) => setFields({ ...fields, endpoint: e.target.value })}
              placeholder="https://api.openai.com/v1"
              required
            />
          </div>

          <div className="model-form__field">
            <label>Model 名称</label>
            <input
              type="text"
              value={fields.model}
              onChange={(e) => setFields({ ...fields, model: e.target.value })}
              placeholder="gpt-4o / qwen-vl-max"
              required
            />
          </div>

          <div className="model-form__field">
            <label>API Key</label>
            <input
              type="password"
              value={fields.apiKey}
              onChange={(e) => setFields({ ...fields, apiKey: e.target.value })}
              placeholder={
                editingId
                  ? "留空则保留原 key；输入新值则覆盖"
                  : "不显示、不存储于 SQLite、不进日志"
              }
              autoComplete="off"
              required={!editingId}
            />
            <p className="model-form__hint">
              API Key 通过系统安全存储（Electron safeStorage）保存，不会进入数据库或日志。
              {editingId && " 编辑现有配置时不显示已存的 key。"}
            </p>
          </div>

          <div className="model-form__field">
            <label>温度（可选）</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={fields.temperature ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  setFields({ ...fields, temperature: undefined });
                  return;
                }
                const n = Number(v);
                setFields({ ...fields, temperature: Number.isNaN(n) ? undefined : n });
              }}
              placeholder="留空使用模型默认值"
            />
            <p className="model-form__hint">0 更确定，1 更多样，2 更随机</p>
          </div>

          <div className="model-form__field">
            <label>最大输出长度（可选）</label>
            <input
              type="number"
              min="1"
              value={fields.maxTokens ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") {
                  setFields({ ...fields, maxTokens: undefined });
                  return;
                }
                const n = Number(v);
                setFields({ ...fields, maxTokens: Number.isNaN(n) ? undefined : n });
              }}
              placeholder="留空使用模型默认值"
            />
            <p className="model-form__hint">单位：token</p>
          </div>

          <div className="model-form__actions">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || saving}
            >
              {testing ? "测试中..." : "测试连接"}
            </button>
            <button type="submit" className="primary" disabled={saving || testing}>
              {saving ? "保存中..." : editingId ? "更新配置" : "保存配置"}
            </button>
            {!wizardMode && (
              <button type="button" onClick={handleCancel} disabled={saving || testing}>
                取消
              </button>
            )}
          </div>

          {formError && <p className="model-form__error">{formError}</p>}
          {warning && <p className="model-form__warning">{warning}</p>}

          {testResult && (
            <p
              className="model-form__result"
              style={{ color: testOk ? "var(--recall-accent)" : "var(--recall-danger)" }}
            >
              {testResult}
            </p>
          )}
        </form>
      )}

      {!wizardMode && error && <p className="model-config__error">{error}</p>}

      <style>{`
        .model-config {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .model-config__header {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .model-config__title {
          font-size: 15px;
          font-weight: 600;
          margin: 0;
        }
        .model-config__desc {
          margin: 0;
          font-size: 12px;
          color: var(--recall-text-muted);
          line-height: 1.6;
        }
        .model-config__list {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 12px;
        }
        .model-config__hint {
          margin: 0;
          padding: 8px 0;
          font-size: 13px;
          color: var(--recall-text-muted);
          text-align: center;
        }
        .model-config__items {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .model-config__item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-md);
          border: 1px solid var(--recall-border);
        }
        .model-config__item-main {
          display: flex;
          gap: 12px;
          align-items: center;
          flex: 1;
          min-width: 0;
        }
        .model-config__item-name {
          font-weight: 500;
          font-size: 13px;
        }
        .model-config__item-model {
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .model-config__item-status {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: var(--radius-pill);
          border: 1px solid var(--recall-border);
        }
        .model-config__item-status.is-enabled {
          color: var(--recall-accent);
          border-color: var(--recall-accent);
        }
        .model-config__item-status.is-disabled {
          color: var(--recall-text-muted);
        }
        .model-config__item-actions {
          display: flex;
          gap: 6px;
        }
        .model-config__item-actions button {
          padding: 4px 10px;
          font-size: 12px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
        }
        .model-config__item-actions button:hover:not(:disabled) {
          background-color: var(--recall-bg);
        }
        .model-config__delete-btn {
          color: var(--recall-danger) !important;
          border-color: var(--recall-danger) !important;
        }
        .model-config__actions {
          display: flex;
          gap: 8px;
        }
        .model-config__add-btn {
          padding: 6px 14px;
          font-size: 13px;
        }
        .model-config__error {
          margin: 0;
          font-size: 12px;
          color: var(--recall-danger);
        }
        .model-form {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .model-form__subtitle {
          font-size: 13px;
          font-weight: 600;
          margin: 0 0 4px 0;
        }
        .model-form__field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .model-form__field label {
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .model-form__field input {
          padding: 6px 10px;
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          font-family: inherit;
          font-size: 13px;
        }
        .model-form__hint {
          margin: 0;
          font-size: 11px;
          color: var(--recall-text-muted);
          line-height: 1.5;
        }
        .model-form__actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .model-form__actions button {
          padding: 6px 14px;
          font-size: 12px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
        }
        .model-form__actions button.primary {
          background-color: var(--recall-accent);
          color: white;
          border-color: var(--recall-accent);
        }
        .model-form__actions button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .model-form__error {
          margin: 0;
          font-size: 12px;
          color: var(--recall-danger);
        }
        .model-form__warning {
          margin: 0;
          font-size: 12px;
          color: var(--recall-amber);
        }
        .model-form__result {
          font-size: 12px;
          margin: 0;
        }
      `}</style>
    </div>
  );
}
