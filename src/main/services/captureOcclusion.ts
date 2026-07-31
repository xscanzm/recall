// src/main/services/captureOcclusion.ts
//
// 遮挡判定（纯函数，无 electron / active-win 依赖，便于单测）。
//
// 存在理由：screen crop 兜底路径是"抓整屏再裁出目标窗口那块"。它不向任何窗口发
// WM_PRINT，所以对第三方应用无害 —— 但代价是：如果目标窗口被别的窗口压住，裁出来
// 的那块像素其实是压在上面那个窗口的内容。这既可能拍到不该拍的东西（比如密码管理器
// 浮在上面），也可能生成一张与"用户当时在看什么"完全不符的截图。
//
// 所以走这条路之前必须先回答："目标窗口那块矩形现在归谁"。这个文件只负责这个判断。
//
// 坐标系：所有 bounds 都来自 active-win，是同一套 Windows 原生屏幕像素坐标，
// 彼此可以直接比较，不需要 DIP 换算。（CaptureService 里的 toElectronDipBounds
// 只用于和 Electron display bounds 比对，与这里无关。）

/** 矩形（Windows 原生屏幕坐标） */
export interface OcclusionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 遮挡判定所需的窗口信息（active-win getOpenWindows 的子集） */
export interface OcclusionWindow {
  /** 窗口 id（Windows 上即 HWND） */
  id?: number;
  /** 所属进程 id */
  processId?: number;
  /** 应用名 */
  appName: string;
  /** 窗口标题 */
  windowTitle: string;
  /** URL/域名（Windows 上通常没有）。遮挡窗口要过 PrivacyGuard，它会用到这个字段 */
  urlOrDomain?: string;
  /** 窗口边界 */
  bounds?: OcclusionRect;
}

/**
 * 良性遮挡的容忍上限。
 *
 * 超过这个比例就跳过这次采集：截图里目标窗口的内容已经少到不能代表"用户在看什么"。
 * 敏感遮挡不看比例，一律跳过（由调用方用 PrivacyGuard 判定）。
 *
 * 0.35 是个产品取舍：日常使用里侧边挂个聊天窗、右下角弹个通知都在这之下，
 * 而"另一个窗口盖了大半屏"会被挡掉。若线上 occluded 跳过率偏高再调。
 */
export const MAX_BENIGN_OCCLUSION_RATIO = 0.35;

/**
 * Windows 给最小化窗口的哨兵坐标是 (-32000, -32000)。
 * 用一个比它宽松的阈值判断，避免依赖精确值。
 *
 * macOS 上 active-win 对 minimized 窗口通常返回 width=0/height=0
 * （会被下面的尺寸判断拦截），但某些版本可能返回离屏坐标，
 * 这个阈值同样能覆盖。双平台安全。
 */
const MINIMIZED_COORDINATE_THRESHOLD = -30000;

/** 最小化 / 无效尺寸的窗口不参与遮挡判定 */
function isRenderableWindow(bounds: OcclusionRect | undefined): bounds is OcclusionRect {
  if (!bounds) return false;
  // macOS minimized 常返回 0 尺寸；Windows minimized 返回 -32000 哨兵坐标
  if (bounds.width <= 0 || bounds.height <= 0) return false;
  if (bounds.x <= MINIMIZED_COORDINATE_THRESHOLD || bounds.y <= MINIMIZED_COORDINATE_THRESHOLD) {
    return false;
  }
  return true;
}

/** 两个矩形的交集，无交集返回 null */
function intersect(a: OcclusionRect, b: OcclusionRect): OcclusionRect | null {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 找出真正压在目标窗口上面的窗口。
 *
 * @param windowsFrontToBack active-win getOpenWindows() 的结果，**必须是 Z 序**
 *   （最前面的在数组开头）。这一点已实测确认。
 * @param target 目标窗口
 * @param ownProcessIds 自身进程 id（Recall 主窗口/悬浮窗不算遮挡，否则我们自己
 *   的界面一挂在前面就永远采不到东西）
 *
 * 判定逻辑：只有 Z 序**严格在目标之前**的窗口才可能压住它。目标之后的窗口在它下面，
 * 与遮挡无关。找不到目标本身时返回 null —— 证明不了 Z 序位置就不能声称没被遮挡。
 */
export function findVisibleOccluders(
  windowsFrontToBack: readonly OcclusionWindow[],
  target: { id?: number; bounds?: OcclusionRect },
  ownProcessIds: readonly number[] = []
): OcclusionWindow[] | null {
  if (!isRenderableWindow(target.bounds)) return null;
  const targetBounds = target.bounds;

  const targetIndex = windowsFrontToBack.findIndex((candidate) =>
    matchesTarget(candidate, target, targetBounds)
  );
  if (targetIndex === -1) return null;

  const ownProcessIdSet = new Set(ownProcessIds);
  const occluders: OcclusionWindow[] = [];

  for (let index = 0; index < targetIndex; index += 1) {
    const candidate = windowsFrontToBack[index];
    if (!isRenderableWindow(candidate.bounds)) continue;
    if (candidate.processId !== undefined && ownProcessIdSet.has(candidate.processId)) continue;
    if (!intersect(candidate.bounds, targetBounds)) continue;
    occluders.push(candidate);
  }

  return occluders;
}

/**
 * 在窗口列表里认出目标。
 *
 * 优先用 id（HWND）精确匹配。id 缺失时退化为矩形完全相同 —— 这不如 id 可靠，
 * 但比按标题匹配安全（标题会变，比如钉钉的未读数）。
 */
function matchesTarget(
  candidate: OcclusionWindow,
  target: { id?: number },
  targetBounds: OcclusionRect
): boolean {
  if (target.id !== undefined && candidate.id !== undefined) {
    return candidate.id === target.id;
  }
  const bounds = candidate.bounds;
  if (!bounds) return false;
  return (
    bounds.x === targetBounds.x &&
    bounds.y === targetBounds.y &&
    bounds.width === targetBounds.width &&
    bounds.height === targetBounds.height
  );
}

/**
 * 目标窗口被遮挡的面积占比，0..1。
 *
 * 必须算矩形**并集**面积，不能把各遮挡矩形面积简单相加：两个互相重叠的遮挡窗口
 * 累加会把比例算过 1，让本来能采的场景被误判成"几乎全被挡住"。
 *
 * 实现用扫描线：按 x 方向切成若干条带，每条带内各遮挡矩形的 y 区间做区间合并。
 * 遮挡窗口个数是十几个量级，这个复杂度完全够用。
 */
export function computeOccludedRatio(
  targetBounds: OcclusionRect,
  occluders: readonly OcclusionWindow[]
): number {
  const targetArea = targetBounds.width * targetBounds.height;
  if (targetArea <= 0) return 0;

  // 先裁到目标矩形内，超出目标的部分不算遮挡。
  const clipped: OcclusionRect[] = [];
  for (const occluder of occluders) {
    if (!isRenderableWindow(occluder.bounds)) continue;
    const overlap = intersect(occluder.bounds, targetBounds);
    if (overlap) clipped.push(overlap);
  }
  if (clipped.length === 0) return 0;

  // x 方向的切割点
  const xEdges = new Set<number>();
  for (const rect of clipped) {
    xEdges.add(rect.x);
    xEdges.add(rect.x + rect.width);
  }
  const xs = [...xEdges].sort((a, b) => a - b);

  let coveredArea = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const stripLeft = xs[i];
    const stripRight = xs[i + 1];
    const stripWidth = stripRight - stripLeft;
    if (stripWidth <= 0) continue;

    // 收集这条带里覆盖到的 y 区间，合并后求总长度
    const spans: Array<[number, number]> = [];
    for (const rect of clipped) {
      if (rect.x <= stripLeft && rect.x + rect.width >= stripRight) {
        spans.push([rect.y, rect.y + rect.height]);
      }
    }
    if (spans.length === 0) continue;

    spans.sort((a, b) => a[0] - b[0]);
    let mergedLength = 0;
    let [currentStart, currentEnd] = spans[0];
    for (let s = 1; s < spans.length; s += 1) {
      const [start, end] = spans[s];
      if (start > currentEnd) {
        mergedLength += currentEnd - currentStart;
        currentStart = start;
        currentEnd = end;
      } else if (end > currentEnd) {
        currentEnd = end;
      }
    }
    mergedLength += currentEnd - currentStart;

    coveredArea += stripWidth * mergedLength;
  }

  // 并集面积不可能超过目标面积，但浮点/整数边界上夹一下更省心
  return Math.min(1, coveredArea / targetArea);
}
