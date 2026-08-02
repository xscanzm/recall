// src/main/utils/id.ts
// 统一 ID 生成工具
//
// 统一前：16 处重复实现同一模式
//   `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
// （13 个 db/repositories + ModelJobQueue / SceneScheduler / CaptureService）。
// 统一后全部引用本模块，格式行为完全一致。

/**
 * 生成 ID：`{prefix}_{base36-时间戳}_{base36-随机8位}`
 * - 时间戳与随机部分均 base36，同一前缀下高概率唯一
 * - 例：`fact_<timestamp>_<random>` / `cap_<timestamp>_<random>`
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
