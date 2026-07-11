// src/renderer/components/Onboarding.tsx
// 首次启动引导（来自 08 文档）
//
// 引导流程：
// 1. 欢迎页：介绍 Recall 是什么、做什么、不做什么
// 2. 模型配置向导：配置多模态模型
// 3. 隐私设置确认：展示默认隐私规则、截图保留策略、通知设置
// 4. 完成页：开始使用 Recall
//
// 失败处理：
// - 模型配置失败：允许重试或跳过（可在设置中后续配置）
// - 用户可随时跳过引导，进入主界面
// - 跳过引导也会标记 onboardingCompleted=true
//
// 重要约束：
// - 不使用营销话术
// - 不使用 emoji
// - API Key 输入框 type=password
// - 测试失败时不显示完整 key
// - 中文注释

import { useEffect, useState } from "react";
import { ModelConfigForm } from "./ModelConfigForm";
import { useAppStore } from "../state/store";
import { getIpc } from "../state/ipc";

type OnboardingStep =
  | "welcome"
  | "multimodal"
  | "privacy"
  | "complete";

export interface OnboardingProps {
  /**
   * 引导完成回调（包括跳过的情况）
   * 父组件应在此回调中将 onboardingCompleted 置为 true
   */
  onComplete: () => void;
}

export function Onboarding(props: OnboardingProps) {
  const { onComplete } = props;

  const [step, setStep] = useState<OnboardingStep>("welcome");
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [languageConfigured, setLanguageConfigured] = useState(false);
  const [multimodalConfigured, setMultimodalConfigured] = useState(false);

  // store 状态和动作
  const modelConfigs = useAppStore((s) => s.modelConfigs);
  const modelConfigsLoading = useAppStore((s) => s.modelConfigsLoading);
  const modelConfigsError = useAppStore((s) => s.modelConfigsError);
  const loadModelConfigs = useAppStore((s) => s.loadModelConfigs);
  const saveModelConfig = useAppStore((s) => s.saveModelConfig);
  const deleteModelConfig = useAppStore((s) => s.deleteModelConfig);
  const testModelConnection = useAppStore((s) => s.testModelConnection);

  const privacyRules = useAppStore((s) => s.privacyRules);
  const loadPrivacyRules = useAppStore((s) => s.loadPrivacyRules);

  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  // 初始化加载
  useEffect(() => {
    void loadModelConfigs();
    void loadPrivacyRules();
    void loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 监听 modelConfigs 变化，判断哪些类型已配置
  useEffect(() => {
    setVisionConfigured(modelConfigs.some((c) => c.kind === "vision"));
    setLanguageConfigured(modelConfigs.some((c) => c.kind === "language"));
    setMultimodalConfigured(modelConfigs.some((c) => c.kind === "multimodal"));
  }, [modelConfigs]);

  // 按模型类型分组
  const multimodalConfigs = modelConfigs.filter((c) => c.kind === "multimodal");

  /**
   * 跳过引导，直接进入主界面
   * 跳过也会标记 onboardingCompleted=true
   */
  const handleSkip = async () => {
    const result = await updateSettings({ onboardingCompleted: true });
    if (result.ok) {
      onComplete();
    } else {
      // 即使设置失败也进入主界面，避免用户被卡住
      onComplete();
    }
  };

  /**
   * 完成引导
   */
  const handleComplete = async (startObserving: boolean) => {
    const observation = settings?.observation;
    const result = await updateSettings({
      onboardingCompleted: true,
      ...(observation
        ? { observation: { ...observation, enabled: startObserving } }
        : {}),
    });
    if (result.ok) {
      if (startObserving) {
        await getIpc().app.startObserving();
      }
      onComplete();
    } else {
      // 即使设置失败也进入主界面
      onComplete();
    }
  };

  /**
   * 引导模式下保存模型配置成功后的回调
   */
  const handleModelSaved = () => {
    if (step === "multimodal") {
      setStep("privacy");
    }
  };

  /**
   * 跳过当前步骤
   */
  const handleSkipStep = () => {
    if (step === "multimodal") {
      setStep("privacy");
    }
  };

  /**
   * 步骤进度指示
   */
  const renderProgress = () => {
    const steps: Array<{ key: OnboardingStep; label: string }> = [
      { key: "welcome", label: "欢迎" },
      { key: "multimodal", label: "多模态模型" },
      { key: "privacy", label: "隐私确认" },
      { key: "complete", label: "完成" },
    ];
    const currentIndex = steps.findIndex((s) => s.key === step);

    return (
      <div className="onboarding__progress">
        {steps.map((s, idx) => (
          <div
            key={s.key}
            className={`onboarding__progress-item ${
              idx === currentIndex
                ? "is-current"
                : idx < currentIndex
                ? "is-done"
                : ""
            }`}
          >
            <span className="onboarding__progress-index">{idx + 1}</span>
            <span className="onboarding__progress-label">{s.label}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="onboarding">
      <div className="onboarding__container">
        {renderProgress()}

        <div className="onboarding__content">
          {step === "welcome" && (
            <WelcomeStep
              onNext={() => setStep("multimodal")}
              onSkip={handleSkip}
            />
          )}

          {step === "multimodal" && (
            <ModelStep
              kind="multimodal"
              alreadyConfigured={multimodalConfigured}
              configs={multimodalConfigs}
              loading={modelConfigsLoading}
              error={modelConfigsError}
              onSave={saveModelConfig}
              onDelete={deleteModelConfig}
              onTest={testModelConnection}
              onSaved={handleModelSaved}
              onNext={handleSkipStep}
              onSkip={handleSkipStep}
            />
          )}

          {step === "privacy" && (
            <PrivacyStep
              settings={settings}
              privacyRules={privacyRules}
              onNext={() => setStep("complete")}
              onSkip={handleSkip}
            />
          )}

          {step === "complete" && (
            <CompleteStep
              visionConfigured={visionConfigured}
              languageConfigured={languageConfigured}
              multimodalConfigured={multimodalConfigured}
              onComplete={handleComplete}
            />
          )}
        </div>

        <div className="onboarding__footer">
          <button type="button" className="onboarding__skip-btn" onClick={handleSkip}>
            跳过引导
          </button>
        </div>
      </div>

      <style>{`
        .onboarding {
          min-height: 100vh;
          background-color: var(--recall-bg);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .onboarding__container {
          background-color: var(--recall-surface);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          box-shadow: 0 4px 24px rgba(30, 36, 35, 0.06);
          width: 100%;
          max-width: 720px;
          padding: 32px;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .onboarding__progress {
          display: flex;
          gap: 4px;
          align-items: center;
        }
        .onboarding__progress-item {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: var(--radius-pill);
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .onboarding__progress-item.is-current {
          background-color: var(--recall-accent);
          color: white;
        }
        .onboarding__progress-item.is-done {
          color: var(--recall-accent);
        }
        .onboarding__progress-index {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 1px solid currentColor;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
        }
        .onboarding__progress-item.is-current .onboarding__progress-index {
          background-color: white;
          color: var(--recall-accent);
        }
        .onboarding__content {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .onboarding__footer {
          display: flex;
          justify-content: flex-end;
          padding-top: 12px;
          border-top: 1px solid var(--recall-border);
        }
        .onboarding__skip-btn {
          padding: 6px 14px;
          font-size: 12px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
          color: var(--recall-text-muted);
        }
        .onboarding__skip-btn:hover {
          background-color: var(--recall-bg);
        }
        .onboarding__title {
          font-size: 22px;
          font-weight: 600;
          margin: 0;
        }
        .onboarding__subtitle {
          font-size: 13px;
          color: var(--recall-text-muted);
          line-height: 1.6;
          margin: 0;
        }
        .onboarding__intro {
          font-size: 13px;
          line-height: 1.7;
          margin: 0;
        }
        .onboarding__intro strong {
          color: var(--recall-text);
        }
        .onboarding__list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .onboarding__list-item {
          display: flex;
          gap: 12px;
          padding: 12px;
          background-color: var(--recall-bg);
          border-radius: var(--radius-md);
          border: 1px solid var(--recall-border);
        }
        .onboarding__list-icon {
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          border-radius: 50%;
          background-color: var(--recall-accent);
          color: white;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          font-weight: 600;
        }
        .onboarding__list-text {
          font-size: 13px;
          line-height: 1.6;
        }
        .onboarding__list-text strong {
          display: block;
          margin-bottom: 2px;
        }
        .onboarding__actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          margin-top: 8px;
        }
        .onboarding__actions button {
          padding: 8px 18px;
          font-size: 13px;
          border: 1px solid var(--recall-border);
          background-color: var(--recall-surface);
          border-radius: var(--radius-md);
          cursor: pointer;
          font-family: inherit;
        }
        .onboarding__actions button.primary {
          background-color: var(--recall-accent);
          color: white;
          border-color: var(--recall-accent);
        }
        .onboarding__actions button.secondary {
          color: var(--recall-text-muted);
        }
        .onboarding__hint {
          font-size: 12px;
          color: var(--recall-text-muted);
          line-height: 1.5;
          margin: 0;
          font-style: italic;
        }
        .onboarding__status-banner {
          padding: 10px 12px;
          border-radius: var(--radius-md);
          font-size: 12px;
          line-height: 1.5;
        }
        .onboarding__status-banner.is-success {
          background-color: rgba(76, 175, 80, 0.08);
          color: var(--recall-accent);
          border: 1px solid var(--recall-accent);
        }
        .onboarding__status-banner.is-info {
          background-color: var(--recall-bg);
          color: var(--recall-text-muted);
          border: 1px solid var(--recall-border);
        }
        .onboarding__privacy-summary {
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 12px;
          font-size: 12px;
          line-height: 1.7;
        }
        .onboarding__privacy-summary p {
          margin: 0 0 6px 0;
        }
        .onboarding__privacy-summary p:last-child {
          margin-bottom: 0;
        }
        .onboarding__privacy-summary ul {
          margin: 0 0 6px 0;
          padding-left: 18px;
        }
        .onboarding__complete-summary {
          background-color: var(--recall-bg);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          padding: 12px;
          font-size: 12px;
          line-height: 1.7;
        }
        .onboarding__complete-summary p {
          margin: 0 0 6px 0;
        }
        .onboarding__complete-summary p:last-child {
          margin-bottom: 0;
        }
      `}</style>
    </div>
  );
}

// ============================================================================
// 子组件：欢迎步骤
// ============================================================================

interface WelcomeStepProps {
  onNext: () => void;
  onSkip: () => void;
}

function WelcomeStep(props: WelcomeStepProps) {
  return (
    <div className="onboarding__welcome">
      <h2 className="onboarding__title">欢迎使用 Recall</h2>
      <p className="onboarding__subtitle">
        Recall 是一个本机运行的桌面上下文记忆系统。以下是它做什么、不做什么。
      </p>

      <div className="onboarding__list">
        <div className="onboarding__list-item">
          <span className="onboarding__list-icon">1</span>
          <div className="onboarding__list-text">
            <strong>只观察活动窗口</strong>
            Recall 只在当前活动窗口切换、标题变化、内容差异或长时间稳定时触发采集。不采集全屏。
          </div>
        </div>
        <div className="onboarding__list-item">
          <span className="onboarding__list-icon">2</span>
          <div className="onboarding__list-text">
            <strong>所有数据保存在本机</strong>
            截图、结构化记忆、用户反馈都保存在你的电脑。MVP 不建设云端，不上传任何数据。
          </div>
        </div>
        <div className="onboarding__list-item">
          <span className="onboarding__list-icon">3</span>
          <div className="onboarding__list-text">
            <strong>模型调用由你掌控</strong>
            你配置自己的视觉模型和语言模型 endpoint。API Key 保存在系统安全存储，不进入数据库或日志。
          </div>
        </div>
        <div className="onboarding__list-item">
          <span className="onboarding__list-icon">4</span>
          <div className="onboarding__list-text">
            <strong>可随时暂停和删除</strong>
            顶部状态栏可一键暂停。可忘掉最近 15/30/60 分钟、今天，或清空所有数据。
          </div>
        </div>
      </div>

      <p className="onboarding__hint">
        引导将依次配置视觉模型、语言模型，并确认隐私默认设置。每一步都可跳过，后续可在设置中调整。如果你使用支持视觉+语言的多模态模型（如 gpt-4o），可在设置中只配置一个多模态模型即可。
      </p>

      <div className="onboarding__actions">
        <button type="button" className="secondary" onClick={props.onSkip}>
          跳过引导
        </button>
        <button type="button" className="primary" onClick={props.onNext}>
          开始引导
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 子组件：模型配置步骤（视觉 / 语言共用）
// ============================================================================

interface ModelStepProps {
  kind: "vision" | "language" | "multimodal";
  alreadyConfigured: boolean;
  configs: import("../state/store").ModelConfigItem[];
  loading: boolean;
  error: string | null;
  onSave: (input: {
    id?: string;
    kind: "vision" | "language" | "multimodal";
    providerName: string;
    endpoint: string;
    model: string;
    apiKey?: string;
    enabled?: boolean;
  }) => Promise<{ ok: boolean; warning?: string; error?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onTest: (input: {
    kind: "vision" | "language" | "multimodal";
    endpoint: string;
    model: string;
    apiKey: string;
  }) => Promise<{ ok: boolean; code?: string; message?: string }>;
  onSaved: () => void;
  onNext: () => void;
  onSkip: () => void;
}

function ModelStep(props: ModelStepProps) {
  const { kind, alreadyConfigured, onSave, onDelete, onTest, onSaved, onNext, onSkip } = props;
  const kindLabel =
    kind === "vision" ? "视觉模型" : kind === "language" ? "语言模型" : "多模态模型";

  return (
    <div className="onboarding__model-step">
      <h2 className="onboarding__title">配置 {kindLabel}</h2>
      <p className="onboarding__subtitle">
        {kind === "vision"
          ? "视觉模型用于分析屏幕截图，识别窗口内容、实体和可能意图。需要支持 vision 的模型（如 gpt-4o / qwen-vl-max）。"
          : kind === "language"
          ? "语言模型用于提取线索、构建场景、生成报告和回答用户问题。任何 OpenAI-compatible 模型均可。"
          : "早测版本使用一个多模态模型完成截图理解、记忆整理和报告生成。请配置支持图片输入的 OpenAI-compatible 模型。"}
      </p>

      {alreadyConfigured && (
        <div className="onboarding__status-banner is-success">
          已配置 {kindLabel}。你可以继续配置下一步，或保留当前配置直接进入下一步。
        </div>
      )}

      <ModelConfigForm
        kind={kind}
        configs={props.configs}
        loading={props.loading}
        error={props.error}
        onSave={onSave}
        onDelete={onDelete}
        onTest={onTest}
        wizardMode
        onSaved={onSaved}
      />

      <p className="onboarding__hint">
        提示：可以先跳过此步骤，后续在「设置 - 模型配置」中完成。未配置多模态模型时无法开始观察采集。
      </p>

      <div className="onboarding__actions">
        <button type="button" className="secondary" onClick={onSkip}>
          跳过此步
        </button>
        <button type="button" className="primary" onClick={onNext}>
          下一步
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 子组件：隐私设置确认步骤
// ============================================================================

interface PrivacyStepProps {
  settings: import("../state/store").AppSettingsState | null;
  privacyRules: import("../state/store").PrivacyRuleItem[];
  onNext: () => void;
  onSkip: () => void;
}

function PrivacyStep(props: PrivacyStepProps) {
  const { settings, privacyRules } = props;

  const retentionLabel = settings
    ? {
        delete_immediately: "立即删除",
        "1h": "1 小时",
        "6h": "6 小时",
        today: "当天",
        "3d": "3 天",
        "7d": "7 天",
      }[settings.screenshot.retentionPolicy]
    : "未知";

  const appRules = privacyRules.filter((r) => r.type === "app_name");
  const keywordRules = privacyRules.filter((r) => r.type === "window_title_keyword");
  const domainRules = privacyRules.filter((r) => r.type === "domain_keyword");

  return (
    <div className="onboarding__privacy-step">
      <h2 className="onboarding__title">确认隐私设置</h2>
      <p className="onboarding__subtitle">
        以下是 Recall 的默认隐私策略。你可以在「设置」中随时调整。
      </p>

      <div className="onboarding__privacy-summary">
        <p><strong>截图保留策略</strong>：{retentionLabel}</p>
        <p><strong>应用内提醒</strong>：{settings?.notification.inAppReminders ? "已开启（默认）" : "已关闭"}</p>
        <p><strong>桌面通知</strong>：{settings?.notification.desktopNotifications ? "已开启" : "已关闭（默认）"}</p>
        <p><strong>日报时间</strong>：{settings?.notification.dailyReportTime ?? "18:30"}</p>
        <p><strong>周报时间</strong>：{settings?.notification.weeklyReportTime ?? "20:00（每周日）"}</p>

        <p style={{ marginTop: "8px" }}><strong>已生效的隐私规则</strong>（共 {privacyRules.length} 条）：</p>
        <ul>
          <li>应用名规则 {appRules.length} 条（如 1Password、银行、支付）</li>
          <li>窗口标题关键词规则 {keywordRules.length} 条（如 password、login、bank）</li>
          <li>域名关键词规则 {domainRules.length} 条</li>
        </ul>
      </div>

      <p className="onboarding__hint">
        匹配上述规则的应用、窗口标题或域名不会被采集。可在「设置 - 黑名单与隐私规则」中添加或调整。
      </p>

      <div className="onboarding__actions">
        <button type="button" className="secondary" onClick={props.onSkip}>
          跳过引导
        </button>
        <button type="button" className="primary" onClick={props.onNext}>
          下一步
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 子组件：完成步骤
// ============================================================================

interface CompleteStepProps {
  visionConfigured: boolean;
  languageConfigured: boolean;
  multimodalConfigured: boolean;
  onComplete: (startObserving: boolean) => void;
}

function CompleteStep(props: CompleteStepProps) {
  const { visionConfigured, languageConfigured, multimodalConfigured } = props;

  // 当前主流水线依赖多模态模型；旧视觉/语言配置仅作为高级兼容保留。
  const hasValidModelConfig = multimodalConfigured;
  const legacyConfigured = visionConfigured || languageConfigured;

  return (
    <div className="onboarding__complete-step">
      <h2 className="onboarding__title">引导完成</h2>
      <p className="onboarding__subtitle">
        你已准备好使用 Recall。以下是当前配置摘要：
      </p>

      <div className="onboarding__complete-summary">
        <p><strong>多模态模型</strong>：{multimodalConfigured ? "已配置" : "未配置（可在设置中后续完成）"}</p>
        {legacyConfigured && (
          <p><strong>高级兼容模型</strong>：已配置视觉/语言模型，当前版本仍优先使用多模态模型。</p>
        )}
        <p><strong>隐私规则</strong>：已加载默认黑名单</p>
        <p><strong>截图保留</strong>：当天（次日启动时自动清理）</p>
        <p><strong>桌面通知</strong>：默认关闭</p>
      </div>

      {!hasValidModelConfig ? (
        <p className="onboarding__hint">
          提示：未配置多模态模型时无法开始观察采集。请在「设置 - 模型配置」中配置一个支持图片输入的多模态模型。
        </p>
      ) : (
        <p className="onboarding__hint">
          选择开始观察后，Recall 会在本次运行和后续重启时自动恢复观察。暂停只在本次运行生效。
        </p>
      )}

      <div className="onboarding__actions">
        <button type="button" className="secondary" onClick={() => props.onComplete(false)}>
          暂不观察
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => props.onComplete(true)}
          disabled={!hasValidModelConfig}
        >
          开始观察
        </button>
      </div>
    </div>
  );
}
