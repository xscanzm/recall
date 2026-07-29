import { describe, expect, it } from "vitest";
import {
  computeOccludedRatio,
  findVisibleOccluders,
  MAX_BENIGN_OCCLUSION_RATIO,
  type OcclusionWindow,
} from "./captureOcclusion";

/** 目标窗口：1000x1000，放在原点，方便按面积口算比例 */
const TARGET = { id: 100, bounds: { x: 0, y: 0, width: 1000, height: 1000 } };

function win(overrides: Partial<OcclusionWindow>): OcclusionWindow {
  return {
    id: 1,
    processId: 1,
    appName: "Some App",
    windowTitle: "Some Window",
    bounds: { x: 0, y: 0, width: 100, height: 100 },
    ...overrides,
  };
}

const targetWindow = win({ id: TARGET.id, processId: 900, bounds: TARGET.bounds });

describe("findVisibleOccluders", () => {
  it("只把 Z 序在目标之前的窗口算作遮挡", () => {
    const front = win({ id: 1, bounds: { x: 0, y: 0, width: 500, height: 500 } });
    const behind = win({ id: 2, bounds: { x: 0, y: 0, width: 500, height: 500 } });

    const occluders = findVisibleOccluders([front, targetWindow, behind], TARGET);

    expect(occluders?.map((o) => o.id)).toEqual([1]);
  });

  it("过滤最小化窗口的 -32000 哨兵坐标", () => {
    const minimized = win({ id: 1, bounds: { x: -32000, y: -32000, width: 1000, height: 1000 } });

    expect(findVisibleOccluders([minimized, targetWindow], TARGET)).toEqual([]);
  });

  it("过滤零面积窗口", () => {
    const zeroWidth = win({ id: 1, bounds: { x: 0, y: 0, width: 0, height: 500 } });
    const zeroHeight = win({ id: 2, bounds: { x: 0, y: 0, width: 500, height: 0 } });

    expect(findVisibleOccluders([zeroWidth, zeroHeight, targetWindow], TARGET)).toEqual([]);
  });

  it("过滤没有 bounds 的窗口", () => {
    const noBounds = win({ id: 1, bounds: undefined });

    expect(findVisibleOccluders([noBounds, targetWindow], TARGET)).toEqual([]);
  });

  it("排除自身进程的窗口，否则 Recall 自己的界面挂在前面就永远采不到", () => {
    const ownWindow = win({ id: 1, processId: 4242, bounds: { x: 0, y: 0, width: 800, height: 800 } });

    expect(findVisibleOccluders([ownWindow, targetWindow], TARGET, [4242])).toEqual([]);
    expect(findVisibleOccluders([ownWindow, targetWindow], TARGET, [1])).toHaveLength(1);
  });

  it("排除与目标矩形无交集的窗口", () => {
    const elsewhere = win({ id: 1, bounds: { x: 2000, y: 2000, width: 500, height: 500 } });
    // 边贴边不算重叠
    const touching = win({ id: 2, bounds: { x: 1000, y: 0, width: 500, height: 1000 } });

    expect(findVisibleOccluders([elsewhere, touching, targetWindow], TARGET)).toEqual([]);
  });

  it("目标不在列表里就返回 null —— 证明不了 Z 序位置就不能声称没被遮挡", () => {
    const other = win({ id: 1 });

    expect(findVisibleOccluders([other], TARGET)).toBeNull();
  });

  it("目标 bounds 缺失或最小化时返回 null", () => {
    expect(findVisibleOccluders([targetWindow], { id: TARGET.id })).toBeNull();
    expect(
      findVisibleOccluders([targetWindow], {
        id: TARGET.id,
        bounds: { x: -32000, y: -32000, width: 100, height: 100 },
      })
    ).toBeNull();
  });

  it("没有 id 时退化为矩形完全相同来认目标", () => {
    const sameRect = win({ id: undefined, bounds: { ...TARGET.bounds } });
    const front = win({ id: undefined, bounds: { x: 0, y: 0, width: 500, height: 500 } });

    const occluders = findVisibleOccluders([front, sameRect], { bounds: TARGET.bounds });

    expect(occluders).toHaveLength(1);
  });
});

describe("computeOccludedRatio", () => {
  it("无遮挡返回 0", () => {
    expect(computeOccludedRatio(TARGET.bounds, [])).toBe(0);
  });

  it("单个遮挡按交集面积算", () => {
    // 500x1000 覆盖左半边 = 0.5
    const half = win({ bounds: { x: 0, y: 0, width: 500, height: 1000 } });

    expect(computeOccludedRatio(TARGET.bounds, [half])).toBeCloseTo(0.5, 6);
  });

  it("超出目标的部分不计入", () => {
    // 从 x=500 起、宽 5000，实际只覆盖目标右半边
    const overflowing = win({ bounds: { x: 500, y: -1000, width: 5000, height: 5000 } });

    expect(computeOccludedRatio(TARGET.bounds, [overflowing])).toBeCloseTo(0.5, 6);
  });

  it("互相重叠的遮挡窗口按并集算，不会把比例累加过 1", () => {
    // 左 0..600（0.6）与 右 400..800（0.4）重叠 400..600：
    // 累加得 1.0，并集只覆盖 0..800 = 0.8
    const left = win({ id: 1, bounds: { x: 0, y: 0, width: 600, height: 1000 } });
    const right = win({ id: 2, bounds: { x: 400, y: 0, width: 400, height: 1000 } });

    const ratio = computeOccludedRatio(TARGET.bounds, [left, right]);

    expect(ratio).toBeCloseTo(0.8, 6);
    expect(ratio).toBeLessThanOrEqual(1);
  });

  it("完全重合的两个遮挡窗口不重复计数", () => {
    const a = win({ id: 1, bounds: { x: 0, y: 0, width: 500, height: 500 } });
    const b = win({ id: 2, bounds: { x: 0, y: 0, width: 500, height: 500 } });

    expect(computeOccludedRatio(TARGET.bounds, [a, b])).toBeCloseTo(0.25, 6);
  });

  it("不相交的多个遮挡窗口面积相加", () => {
    // 左上 500x500 + 右下 500x500 = 0.5
    const topLeft = win({ id: 1, bounds: { x: 0, y: 0, width: 500, height: 500 } });
    const bottomRight = win({ id: 2, bounds: { x: 500, y: 500, width: 500, height: 500 } });

    expect(computeOccludedRatio(TARGET.bounds, [topLeft, bottomRight])).toBeCloseTo(0.5, 6);
  });

  it("完全覆盖返回 1", () => {
    const full = win({ bounds: { ...TARGET.bounds } });

    expect(computeOccludedRatio(TARGET.bounds, [full])).toBeCloseTo(1, 6);
  });

  it("最小化的遮挡窗口不计入", () => {
    const minimized = win({ bounds: { x: -32000, y: -32000, width: 1000, height: 1000 } });

    expect(computeOccludedRatio(TARGET.bounds, [minimized])).toBe(0);
  });

  it("目标零面积时返回 0 而不是 NaN", () => {
    const anything = win({ bounds: { x: 0, y: 0, width: 100, height: 100 } });

    expect(computeOccludedRatio({ x: 0, y: 0, width: 0, height: 0 }, [anything])).toBe(0);
  });

  it("阈值边界：略低于阈值放行，略高于阈值拦下", () => {
    const below = win({ bounds: { x: 0, y: 0, width: 1000, height: 340 } }); // 0.34
    const above = win({ bounds: { x: 0, y: 0, width: 1000, height: 360 } }); // 0.36

    expect(computeOccludedRatio(TARGET.bounds, [below])).toBeLessThan(MAX_BENIGN_OCCLUSION_RATIO);
    expect(computeOccludedRatio(TARGET.bounds, [above])).toBeGreaterThan(MAX_BENIGN_OCCLUSION_RATIO);
  });
});
