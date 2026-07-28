// src/shared/identity.ts
// 共享身份归一化与对比逻辑

/**
 * 共享身份归一化函数
 * 语义：
 * 1. Unicode NFKC 归一化（将全角括号、全角英数字转为半角标准字符）
 * 2. trim 剔除前后空格
 * 3. 连续内部空白折叠为一个空格
 * 4. 英文字母大小写归一 (toLowerCase)
 * 5. 不删除普通标点
 * 6. 不改变显示文本（display name）
 */
export function normalizeIdentity(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export interface PersonIdentityInfo {
  name: string;
  role?: string | null;
  organization?: string | null;
}

export interface IdentityCompareResult {
  isSameName: boolean;
  isSameIdentity: boolean;
  classification: "different_name" | "normalized_name_match" | "strong_field_match" | "conflict_detected";
  reason: string;
}

/**
 * 人物身份对比逻辑
 * - 名字不同 -> different_name
 * - 名字归一后相同：
 *   - 若双方角色/组织均有值且完全一致 -> strong_field_match
 *   - 若角色或组织存在非空冲突 -> conflict_detected（同名但组织或角色不同的人，不判定为同一身份）
 *   - 否则（单方缺省/无冲突） -> normalized_name_match
 */
export function comparePersonIdentity(
  p1: PersonIdentityInfo,
  p2: PersonIdentityInfo
): IdentityCompareResult {
  const normName1 = normalizeIdentity(p1.name);
  const normName2 = normalizeIdentity(p2.name);

  if (normName1 !== normName2 || !normName1) {
    return {
      isSameName: false,
      isSameIdentity: false,
      classification: "different_name",
      reason: "名字归一化后不一致",
    };
  }

  const role1 = normalizeIdentity(p1.role);
  const role2 = normalizeIdentity(p2.role);
  const org1 = normalizeIdentity(p1.organization);
  const org2 = normalizeIdentity(p2.organization);

  const hasRoleConflict = !!(role1 && role2 && role1 !== role2);
  const hasOrgConflict = !!(org1 && org2 && org1 !== org2);

  if (hasRoleConflict || hasOrgConflict) {
    return {
      isSameName: true,
      isSameIdentity: false,
      classification: "conflict_detected",
      reason: hasRoleConflict && hasOrgConflict
        ? "角色与组织均存在冲突"
        : hasRoleConflict
        ? "角色存在冲突"
        : "组织存在冲突",
    };
  }

  const bothHaveRole = !!(role1 && role2 && role1 === role2);
  const bothHaveOrg = !!(org1 && org2 && org1 === org2);
  const hasStrongFieldMatch = (bothHaveRole && (bothHaveOrg || !org1 || !org2)) || (bothHaveOrg && (bothHaveRole || !role1 || !role2));

  if (hasStrongFieldMatch) {
    return {
      isSameName: true,
      isSameIdentity: true,
      classification: "strong_field_match",
      reason: "名称及角色/组织强字段一致",
    };
  }

  return {
    isSameName: true,
    isSameIdentity: false,
    classification: "normalized_name_match",
    reason: "仅归一化名称相同（缺少共同强字段，不能自动确定为同一身份）",
  };
}
