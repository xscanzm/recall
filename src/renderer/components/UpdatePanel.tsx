// src/renderer/components/UpdatePanel.tsx
// 版本更新详情弹窗（模态对话框）
//
// 用途：
// - 由 UpdateBadge 在检测到新版本（updateStatus.state === "hasUpdate"）时触发显示
// - 展示版本对比 / 发布时间 / 更新日志 / SHA256
// - 提供三个操作：立即下载 / 跳过此版本 / 稍后提醒
//
// 行为：
// - 点击"立即下载"后触发 store.downloadUpdate() 并关闭弹窗，下载进度由 UpdateBadge 显示
// - 点击"跳过此版本"后调用 dismissUpdateVersion 并关闭弹窗
// - updateStatus 不再是 hasUpdate 时（如下载已开始）自动关闭

import { useEffect } from "react";
import { X, Download, SkipForward, Clock } from "lucide-react";
import { useAppStore } from "../state/store";

export interface UpdatePanelProps {
  onClose: () => void;
}

export const UpdatePanel = ({ onClose }: UpdatePanelProps) => {
  const updateStatus = useAppStore((s) => s.updateStatus);
  const downloadUpdate = useAppStore((s) => s.downloadUpdate);
  const dismissUpdateVersion = useAppStore((s) => s.dismissUpdateVersion);

  // 状态不再是 hasUpdate 时（如下载已开始），关闭弹窗
  useEffect(() => {
    if (updateStatus.state !== "hasUpdate") {
      onClose();
    }
  }, [updateStatus.state, onClose]);

  // 非 hasUpdate 不渲染（useEffect 已触发关闭）
  if (updateStatus.state !== "hasUpdate") {
    return null;
  }

  const { info } = updateStatus;
  const publishedAt = new Date(info.publishedAt).toLocaleString("zh-CN");
  const shaTruncated = info.sha256.slice(0, 16) + "...";

  const handleDownload = () => {
    // 触发下载（main 进程异步执行），立即关闭弹窗，进度由 UpdateBadge 显示
    void downloadUpdate();
    onClose();
  };

  const handleDismiss = () => {
    void dismissUpdateVersion(info.latestVersion);
    onClose();
  };

  return (
    <div
      className="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-panel-title"
      onClick={onClose}
    >
      <div
        className="confirm-dialog__box update-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="update-panel__header">
          <h3 id="update-panel-title" className="confirm-dialog__title">
            发现新版本 v{info.latestVersion}
          </h3>
          <button
            type="button"
            className="update-panel__close"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="update-panel__content">
          <div className="update-panel__version-row">
            <span>当前版本 v{info.currentVersion}</span>
            <span className="update-panel__arrow">→</span>
            <span>最新版本 v{info.latestVersion}</span>
          </div>

          <div className="update-panel__meta">
            <Clock size={14} />
            <span>发布时间：{publishedAt}</span>
          </div>

          <pre className="update-panel__release-notes">{info.releaseNotes}</pre>

          <div className="update-panel__sha" title={info.sha256}>
            SHA256：{shaTruncated}
          </div>
        </div>

        <div className="confirm-dialog__actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={handleDismiss}
          >
            <SkipForward size={14} />
            跳过此版本
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
          >
            稍后提醒
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownload}
          >
            <Download size={14} />
            立即下载
          </button>
        </div>
      </div>

      <style>{`
        .update-panel {
          max-width: 560px;
        }
        .update-panel__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .update-panel__close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          flex-shrink: 0;
          padding: 0;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--recall-text-muted);
          cursor: pointer;
        }
        .update-panel__close:hover {
          background: var(--recall-surface-muted);
          color: var(--recall-text);
        }
        .update-panel__content {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .update-panel__version-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          font-size: var(--fs-body);
          color: var(--recall-text);
        }
        .update-panel__arrow {
          color: var(--recall-text-muted);
        }
        .update-panel__meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--recall-text-muted);
        }
        .update-panel__release-notes {
          margin: 0;
          padding: 12px 14px;
          max-height: 220px;
          overflow: auto;
          background: var(--recall-surface-muted);
          border: 1px solid var(--recall-border);
          border-radius: var(--radius-md);
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 12px;
          line-height: 1.6;
          color: var(--recall-text);
          white-space: pre-wrap;
          word-break: break-word;
        }
        .update-panel__sha {
          font-family: var(--font-mono, ui-monospace, monospace);
          font-size: 11px;
          color: var(--recall-text-muted);
          cursor: help;
        }
        .update-panel .btn {
          gap: 6px;
        }
      `}</style>
    </div>
  );
};
