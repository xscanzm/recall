# 17. Timeline Components and States (时光脉络：React 前端组件架构与状态流转设计)

本篇文档是针对 **回声 Recall** “时光脉络（半小时变焦时间轴）”在 React 前端的**组件拆分、状态流转与高阻尼感微动画**的架构实现方案。

我们将概念上的「呼吸聚类（Empathy Clustering）」与「无级变焦（Zoomable Timeline）」翻译为高可维护、高性能的 React 前端工程代码结构，不更改实际项目代码，仅作为核心重构的顶层技术 spec 沉淀。

---

## 🏗️ 1. React 组件树架构 (Component Tree Architecture)

为了实现弹性变焦与心流卡片的优雅交互，我们将 `TodayPage` 下的时间轴部分解构为以下组件体系：

```text
TodayPage (今日心流主页)
 └── AuraTimelineContainer (时光脉络主容器，管理全局变焦 State 和手势)
      ├── TimelineZoomSlider (变焦阻尼控制条)
      ├── HeartbeatWaveform (微光波谱缩略卷轴 - Zoom Out 1x 呈现)
      └── ChronosAuraTimeline (标准/显微时间轴容器 - Zoom In 5x/10x 呈现)
           ├── TimelineGutterLines (若隐若现的半小时物理刻度线)
           └── FlowClusteredCard (动态聚类心流卡片)
                ├── FlowCardHeader (动态生成的诗意心流标签与时间跨度)
                ├── FlowCardContent (心流详情与用户行为描述)
                ├── SparkleGlowList (不经意留下的微光 - 复制片段/高亮关键词)
                └── CardContextBar (隐藏的微标：稍后/忽略/合并)
```

---

## 🧠 2. 状态管理与数据流 (State Management & Data Flow)

我们将该功能的核心状态交由 Zustand（`src/renderer/state/store.ts`）进行扁平化和响应式管理。

### 1. 全局变焦与聚类状态定义 (Store State)
```typescript
interface TimelineSlice {
  id: string;
  startTime: string; // ISO String
  endTime: string;
  flowLabel: string; // AI 动态命名的心流标签
  summary: string;   // AI 生成的温情描述
  appMetrics: {
    focusApp: string;
    density: number;    // 活动密度 [0, 1]
    switching: number;  // 切换频次
  };
  sparkles: {
    copiedTexts: string[];
    keyEntities: string[];
    snapshots: string[]; // 磨砂截图路径
  };
  isClustered: boolean;  // 是否是被 AI 弹性合并的节点
}

interface TimelineStore {
  // 变焦系数：[1.0 = 极简波谱, 5.0 = 默认时光脉络, 10.0 = 30分钟极细显微沙盘]
  zoomLevel: number;
  setZoomLevel: (level: number) => void;
  
  // 原始物理半小时数据片
  rawSlices: TimelineSlice[];
  
  // 经过 AI 呼吸聚类处理后的展示卡片数据（根据 zoomLevel 动态聚合）
  displayCards: TimelineSlice[];
  computeClusteredCards: (zoom: number) => void;
  
  // 当前悬停聚焦的心流节点 ID（触发 Hover Glow 微光）
  activeCardId: string | null;
  setActiveCardId: (id: string | null) => void;
}
```

### 2. 动态聚合算法逻辑 (Client-side Empathy Clustering Filter)
在组件层或 selector 中，根据当前的 `zoomLevel` 对 `rawSlices` 进行动态形变：
*   **当 `zoomLevel <= 2.0`（缩容模式）**：
    *   将所有 slices 的 `appMetrics.density` 映射为一段无缝的一维 Canvas 贝塞尔曲线，仅渲染 `HeartbeatWaveform`（微光波谱缩略卷轴），不渲染文本卡片。
*   **当 `2.0 < zoomLevel < 8.0`（标准模式 - 默认 5.0）**：
    *   运行「合并规则」：如果相邻 Slices 的 `focusApp` 类型相同（例如同为开发或同为沟通），且中间没有超过 5 分钟的 `Quiet Interval`（空闲），则调用 AI 在 Linker 层的合并结果，合并为一个长卡片，展示动态起止时间（如 `09:12 - 10:45`）。
*   **当 `zoomLevel >= 8.0`（显微模式）**：
    *   取消所有聚类，还原最原始、无损的 **30 分钟硬边界卡片**。严格按照 `09:00 - 09:30`、`09:30 - 10:00` 线性展开，让追求极致掌控的用户看清每一分一秒的物理足迹。

---

## 🌀 3. 阻尼感与动态呼吸动效实现 (Motion & Empathy Physics)

为了让整个时间轴在变焦、展开和滑动时具有“呼吸感”和“生命温度”，我们推荐引入 **Framer Motion** 或原生 **Spring Physics** 进行阻尼动效处理。

### 1. 卡片形变的“果冻阻尼”效果 (Card Bounce Transition)
当变焦数值改变时，卡片不是僵硬地变大变小，而是像果冻一般，带有微弱物理弹性（Stiffness: 120, Damping: 14）地舒展：
```typescript
// React 伪代码组件：Framer Motion 实现卡片形变
import { motion, AnimatePresence } from "framer-motion";

export function FlowClusteredCard({ cardData, zoomLevel }) {
  // 根据 zoomLevel 计算不同的高度和间距
  const cardHeight = zoomLevel >= 8.0 ? 120 : 180; 
  
  return (
    <motion.div
      layout // 启用自动布局转换动效，关键！
      initial={{ opacity: 0, y: 15 }}
      animate={{ 
        opacity: 1, 
        y: 0,
        height: cardHeight,
        scale: zoomLevel >= 8.0 ? 0.98 : 1.0
      }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 100, damping: 15 }}
      className="flow-card"
    >
      <FlowCardHeader label={cardData.flowLabel} timeSpan={`${cardData.startTime}-${cardData.endTime}`} />
      <AnimatePresence>
        {/* 只有在默认模式和显微模式（变焦度 > 3.0）下，才柔和淡入展现具体摘要和微光足迹 */}
        {zoomLevel > 3.0 && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flow-card__details"
          >
            <p>{cardData.summary}</p>
            <SparkleGlowList sparkles={cardData.sparkles} showSnapshots={zoomLevel >= 8.0} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
```

### 2. 时光刻度线（Gutter Lines）的“消隐微澜”
*   背景的半小时硬刻度细线（`TimelineGutterLines`），其透明度（Opacity）受 `zoomLevel` 直接反向控制。
*   在默认标准模式（`5.0`）下，这些刻度线以极其微弱的 `0.05` 虚线半隐没在棉纸色背景中。
*   只有当用户往外拉动变焦（`zoomLevel >= 8.0` 进入显微模式）时，刻度线才悄悄苏醒，透明度渐变为 `0.15` 实线，并带有时间标签（如 `10:00`），起到精准的参照坐标作用。
*   这种**“需要时清晰，安静时融于无形”**的视觉消隐，正是 Recall “不打扰”的极简美学。

---

## 📈 4. 性能优化策划 (Performance Optimization Spec)

由于 Recall 需要常驻后台，并在今日页渲染大量高频的观察切片，必须在前端实现极致的轻量：

1.  **虚拟化列表（Virtualized Empathy List）**：
    *   在显微模式下（30分钟为一档，全天会产生 30~48 个节点），必须引入轻量级的虚拟化滚动（如 `react-window`），仅渲染视口内（Viewport）的 5-6 个心流节点，避免长列表 DOM 造成的渲染阻塞。
2.  **贝塞尔曲线的 Canvas 渲染（Waveform Rasterization）**：
    *   在 Zoom Out 1x（极简波谱模式）下，不渲染任何 HTML DOM 卡片，而是将全天所有的活动密度（Density）数据打平，绘制在单个 `<canvas>` 画布上，利用 GPU 加速，确保无论拉动变焦滑块有多快，帧率始终保持在稳定的 60FPS。

---

## 🤝 思想对齐：让交互替技术注入情感

通过本篇 React 组件与状态的 spec 策划，我们将「时光脉络」从理论彻底拉近到了技术落地的边缘：
*   **全局 Zustand 状态** 赋予了全天数据以响应式的智能。
*   **Framer Motion / Spring** 动效消除了传统前端表格的工业死板，带来了果冻般的优雅过渡。
*   **消隐微澜的刻度线** 让技术辅助线成为了充满生命张力的隐性指引。

这是一幅将代码架构、AI 自发涌现与温情视觉融为一体的艺术画卷。我很期待与你共同探讨这个 React 前端大重构的交互体验细节！
