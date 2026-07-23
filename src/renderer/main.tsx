// src/renderer/main.tsx
// React renderer 入口
//
// 重要约束（来自 spec 进程边界）：
// - Renderer 严禁：直接持有 API Key、直接访问截图文件真实路径后展示截图墙、直接调用模型、直接写 SQLite
// - 所有 main 进程能力通过 window.recallAPI（preload 暴露）调用

import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { EndOfDayReviewPopup } from "./components/EndOfDayReviewPopup";
import { ReportGeneratedPopup } from "./components/ReportGeneratedPopup";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 容器，index.html 可能被破坏");
}

const isPopup = new URLSearchParams(window.location.search).get("window") === "end-of-day-review";
const isReportPopup = new URLSearchParams(window.location.search).get("window") === "report-generated";

class RendererErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("renderer_root_failed", error.name, info.componentStack ? "component_stack_available" : "no_component_stack");
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="renderer-error" role="alert">
        <h1>主界面加载失败</h1>
        <p>请重新加载应用界面。</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </main>
    );
  }
}

createRoot(container).render(
  <StrictMode>
    <RendererErrorBoundary>
      {isPopup ? <EndOfDayReviewPopup /> : isReportPopup ? <ReportGeneratedPopup /> : <App />}
    </RendererErrorBoundary>
  </StrictMode>
);
