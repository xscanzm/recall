// src/main/db/sqlIdentifiers.ts
// 动态 SQL 标识符运行时校验（fail-closed）
//
// 用途：任何被插值进 SQL 语句的标识符（表名、列名前缀）在拼接前必须先经过
// 本模块的允许集合校验。非法值一律抛 Error，绝不拼接未经验证的值——
// 防止外部可控输入经模板字符串注入 SQL（如 `${stage}_status` / `${table}`）。
//
// 允许集合来源（与代码中的既有映射保持一致）：
// - BATCH_STAGES：CaptureInboxRepository.ts:12 `export type BatchStage =
//   "observer" | "episode" | "atom" | "linker"`，用于 `${stage}_status` 列。
// - OBJECT_TABLES：MemoryObjectRepository.ts:850/933 的 ternary 表名映射
//   （projects/tasks/decisions、projects/tasks/people/decisions）与
//   MemoryEdgeRepository.ts:186-190 ENDPOINT_TABLES 的值
//   （observations/facts/scenes/projects/tasks/people/decisions/reports）
//   的并集。

export const BATCH_STAGES = ["observer", "episode", "atom", "linker"] as const;
export type BatchStageName = (typeof BATCH_STAGES)[number];

export const OBJECT_TABLES = [
  "projects",
  "tasks",
  "people",
  "decisions",
  "observations",
  "facts",
  "scenes",
  "reports",
] as const;
export type ObjectTableName = (typeof OBJECT_TABLES)[number];

/** 校验批次处理阶段标识符（用于 ${stage}_status 动态列名），通过则原样返回。 */
export function assertBatchStage(stage: string): string {
  if ((BATCH_STAGES as readonly string[]).includes(stage)) return stage;
  throw new Error(`Illegal batch stage for dynamic SQL identifier: ${JSON.stringify(stage)}`);
}

/** 校验对象表名标识符（用于 ${table} 动态表名），通过则原样返回。 */
export function assertObjectTable(table: string): string {
  if ((OBJECT_TABLES as readonly string[]).includes(table)) return table;
  throw new Error(`Illegal object table for dynamic SQL identifier: ${JSON.stringify(table)}`);
}
