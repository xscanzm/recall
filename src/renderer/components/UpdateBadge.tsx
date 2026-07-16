// src/renderer/components/UpdateBadge.tsx
// 顶栏右上角版本更新提醒入口
//
// 根据 updateStatus 状态机派生不同 UI：
// - idle / checking / noUpdate：不渲染
// - hasUpdate：红点 + "有升级，更新" 按钮 → 打开 UpdatePanel
// - downloading：进度条 + 百分比（不可点击）
// - downloaded："立即安装" 按钮 → 二次确认后调用 installUpdate
// - installing："正在安装..." + spinner
// - error：红点 + "更新失败"（hover 显示 message）

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useAppStore } from "../state/store";
import { UpdatePanel } from "./UpdatePanel";

export const UpdateBadge = () => {
  const [showPanel, setShowPanel] = useState(false);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const installUpdate = useAppStore((s) => s.installUpdate);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  const handleInstall = () => {
    requestConfirm({
      title: "立即安装更新",
      message: "应用将退出并启动安装程序，确定现在安装吗？",
      confirmText: "立即安装",
      onConfirm: () => {
        void installUpdate();
      },
    });
  };

  const state = updateStatus.state;

  // idle / checking / noUpdate：不渲染
  if (state === "idle" || state === "checking" || state === "noUpdate") {
    return null;
  }

  if (state === "hasUpdate") {
    return (
      <>
        <div className="update-badge">
          <span className="update-badge__dot" />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowPanel(true)}
          >
            有升级，更新
          </button>
        </div>
        {showPanel && <UpdatePanel onClose={() => setShowPanel(false)} />}
      </>
    );
  }

  if (state === "downloading") {
    const percent = Math.round(updateStatus.progress.percent);
    return (
      <div className="update-badge" title="正在下载更新">
        <Download size={14} />
        <div className="update-badge__progress">
          <div
            className="update-badge__progress-bar"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span>{percent}%</span>
      </div>
    );
  }

  if (state === "downloaded") {
    return (
      <div className="update-badge">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleInstall}
        >
          立即安装
        </button>
      </div>
    );
  }

  if (state === "installing") {
    return (
      <div className="update-badge">
        <Loader2
          size={14}
          style={{ animation: "update-badge-spin 1s linear infinite" }}
        />
        <span>正在安装...</span>
        <style>{`@keyframes update-badge-spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // state === "error"
  return (
    <div className="update-badge" title={updateStatus.message}>
      <span className="update-badge__dot" />
      <span>更新失败</span>
    </div>
  );
};
