// src/main/services/zodToDescription.ts
//
// 将 zod schema 转换为人类可读的字段描述文本，用于 JSON repair prompt。
// 解决 audit finding M-2：buildSchemaDescription 之前过于通用，
// 模型在 JSON repair 时拿不到具体字段名/类型/约束，导致修复成功率下降。
//
// 设计要点：
// - 接收 unknown 参数，避免与 ModelGateway.ts 的 ZodSchemaLike 形成循环依赖
// - 仅识别 zod 运行时类型（ZodObject/ZodString/ZodNumber/ZodBoolean/ZodEnum/
//   ZodArray/ZodLiteral），其它类型降级为「未知类型」
// - 自动剥离 ZodOptional/ZodNullable/ZodDefault 包装器以访问内部类型
// - 任何异常都向上抛出，由调用方 try/catch 降级到通用描述

import { z } from "zod";

type ZodChecks = Array<{ kind: string; value?: number; message?: string }>;

/**
 * 剥离 ZodOptional / ZodNullable / ZodDefault 包装器，返回内部类型。
 * 例如 `z.string().max(120).optional()` -> `ZodString`
 */
function unwrapType(field: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = field;
  // 最多剥离 5 层，防止意外循环
  for (let i = 0; i < 5; i++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      const inner = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
      if (!inner || inner === current) break;
      current = inner;
      continue;
    }
    break;
  }
  return current;
}

/**
 * 描述单个 zod 字段类型。
 * 返回值示例：
 *   字符串，最大长度 120，必填。
 *   数值，范围 [0, 1]，必填。
 *   枚举，可选值 [a/b/c]，必填。
 *   字符串 的数组，必填。
 */
function describeField(field: z.ZodTypeAny): string {
  const isOptional = field.isOptional();
  const isNullable = field.isNullable();
  const inner = unwrapType(field);

  let typeDesc: string;

  if (inner instanceof z.ZodString) {
    const checks = (inner as unknown as { _def: { checks?: ZodChecks } })._def.checks;
    const maxCheck = checks?.find((c) => c.kind === "max");
    const minCheck = checks?.find((c) => c.kind === "min");
    const maxStr = maxCheck ? `，最大长度 ${maxCheck.value}` : "";
    const minStr = minCheck ? `，最小长度 ${minCheck.value}` : "";
    typeDesc = `字符串${minStr}${maxStr}`;
  } else if (inner instanceof z.ZodNumber) {
    const checks = (inner as unknown as { _def: { checks?: ZodChecks } })._def.checks;
    const minCheck = checks?.find((c) => c.kind === "min");
    const maxCheck = checks?.find((c) => c.kind === "max");
    const rangeStr =
      minCheck || maxCheck
        ? `，范围 [${minCheck?.value ?? 0}, ${maxCheck?.value ?? 1}]`
        : "";
    typeDesc = `数值${rangeStr}`;
  } else if (inner instanceof z.ZodBoolean) {
    typeDesc = `布尔值`;
  } else if (inner instanceof z.ZodEnum) {
    const values = (inner as unknown as { _def: { values: string[] } })._def.values;
    typeDesc = `枚举，可选值 [${values.join("/")}]`;
  } else if (inner instanceof z.ZodLiteral) {
    const value = (inner as unknown as { _def: { value: unknown } })._def.value;
    typeDesc = `字面量 [${String(value)}]`;
  } else if (inner instanceof z.ZodArray) {
    const elementSchema = (inner as unknown as { _def: { type: z.ZodTypeAny } })._def.type;
    const elementDesc = describeField(elementSchema);
    typeDesc = `${elementDesc} 的数组`;
  } else if (inner instanceof z.ZodObject) {
    typeDesc = `对象`;
  } else {
    typeDesc = `未知类型`;
  }

  const optStr = isOptional ? "可选" : "必填";
  const nullStr = isNullable ? "，可为 null" : "";
  return `${typeDesc}，${optStr}${nullStr}`;
}

/**
 * 将 ZodObject schema 转换为多行字段描述文本。
 *
 * 返回示例：
 *   字段 sceneSummary: 字符串，最大长度 1000，必填。
 *   字段 confidence: 数值，范围 [0, 1]，必填。
 *   字段 projectHint: 字符串，最大长度 120，可选。
 *   字段 tags: 字符串，最大长度 120，必填。 的数组，必填。
 *
 * 如果 schema 不是 ZodObject 或解析失败，返回降级提示文本（不抛异常）。
 */
export function zodToDescription(schema: unknown): string {
  try {
    if (!(schema instanceof z.ZodObject)) {
      return `(schema 不是 ZodObject，无法解析字段)`;
    }
    const shape = (
      schema as unknown as { _def: { shape: () => Record<string, z.ZodTypeAny> } }
    )._def.shape();
    const lines: string[] = [];
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const description = describeField(fieldSchema);
      lines.push(`字段 ${fieldName}: ${description}`);
    }
    return lines.join("\n");
  } catch {
    return `(无法解析 schema 结构)`;
  }
}
