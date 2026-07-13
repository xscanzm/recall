// src/renderer/main.tsx
// React renderer 入口
//
// 重要约束（来自 spec 进程边界）：
// - Renderer 严禁：直接持有 API Key、直接访问截图文件真实路径后展示截图墙、直接调用模型、直接写 SQLite
// - 所有 main 进程能力通过 window.recallAPI（preload 暴露）调用

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { EndOfDayReviewPopup } from "./components/EndOfDayReviewPopup";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 容器，index.html 可能被破坏");
}

const isPopup = new URLSearchParams(window.location.search).get("window") === "end-of-day-review";

createRoot(container).render(
  <StrictMode>
    {isPopup ? <EndOfDayReviewPopup /> : <App />}
  </StrictMode>
);
