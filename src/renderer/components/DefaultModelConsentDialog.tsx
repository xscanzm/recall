import { Cloud, KeyRound } from "lucide-react";
import { Button } from "./Button";

export function DefaultModelConsentDialog(props: {
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="confirm-dialog" role="presentation">
      <section
        className="confirm-dialog__box default-model-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="default-model-consent-title"
      >
        <div className="default-model-consent__icon" aria-hidden="true">
          <Cloud size={20} />
        </div>
        <div>
          <h2 id="default-model-consent-title" className="confirm-dialog__title">
            使用 Recall 默认模型服务？
          </h2>
          <p className="confirm-dialog__message">
            本次任务需要调用模型。Recall 会将完成任务所需的文字或截图发送到默认模型服务，并仅记录匿名安装级调用统计，不记录内容。
          </p>
        </div>
        <div className="default-model-consent__note">
          <KeyRound size={16} aria-hidden="true" />
          <span>你也可以拒绝并前往设置配置自己的 API Key。</span>
        </div>
        <div className="confirm-dialog__actions">
          <Button variant="secondary" onClick={props.onDecline} disabled={props.busy}>
            暂不使用
          </Button>
          <Button variant="primary" onClick={props.onAccept} disabled={props.busy}>
            {props.busy ? "正在确认" : "同意并继续"}
          </Button>
        </div>
      </section>
    </div>
  );
}
