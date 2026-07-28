// src/main/services/IdentityAuditService.ts
// 历史重复对象只读 dry-run 审计服务
//
// 约束：
// - 不运行真实数据合并
// - 不修改数据库
// - 不把真实姓名或记忆正文写入仓库
// - 不把“完全同名”直接判定为同一人物
// - 区分：
//   1. 仅归一化名称相同 (normalized_name_match)
//   2. 名称及组织/角色等强字段一致 (strong_field_match)
//   3. 名称相同但存在冲突 (conflict_detected)

import type { DB } from "../db/Database";
import { normalizeIdentity, comparePersonIdentity } from "../../shared/identity";

export interface DuplicateAuditItem {
  id: string;
  name: string;
  role?: string | null;
  organization?: string | null;
  summary?: string | null;
}

export interface AuditDuplicateGroup {
  objectType: "project" | "person";
  normalizedName: string;
  classification: "normalized_name_match" | "strong_field_match" | "conflict_detected";
  items: DuplicateAuditItem[];
  reason: string;
}

export interface AuditReport {
  timestamp: string;
  scannedProjectsCount: number;
  scannedPeopleCount: number;
  projectDuplicateGroups: AuditDuplicateGroup[];
  personDuplicateGroups: AuditDuplicateGroup[];
  summary: {
    totalDuplicateGroups: number;
    normalizedNameMatches: number;
    strongFieldMatches: number;
    conflictsDetected: number;
  };
}

export class IdentityAuditService {
  /**
   * 执行只读 dry-run 重复对象审计
   */
  static audit(db: DB): AuditReport {
    const projectRows = db.prepare(
      "SELECT id, name, summary FROM projects WHERE archived_at IS NULL"
    ).all() as Array<{ id: string; name: string; summary: string | null }>;

    const peopleRows = db.prepare(
      "SELECT id, name, role, organization, summary FROM people WHERE deleted_at IS NULL"
    ).all() as Array<{
      id: string;
      name: string;
      role: string | null;
      organization: string | null;
      summary: string | null;
    }>;

    const projectDuplicateGroups = IdentityAuditService.auditProjects(projectRows);
    const personDuplicateGroups = IdentityAuditService.auditPeople(peopleRows);

    const allGroups = [...projectDuplicateGroups, ...personDuplicateGroups];
    const summary = {
      totalDuplicateGroups: allGroups.length,
      normalizedNameMatches: allGroups.filter((g) => g.classification === "normalized_name_match").length,
      strongFieldMatches: allGroups.filter((g) => g.classification === "strong_field_match").length,
      conflictsDetected: allGroups.filter((g) => g.classification === "conflict_detected").length,
    };

    return {
      timestamp: new Date().toISOString(),
      scannedProjectsCount: projectRows.length,
      scannedPeopleCount: peopleRows.length,
      projectDuplicateGroups,
      personDuplicateGroups,
      summary,
    };
  }

  private static auditProjects(
    rows: Array<{ id: string; name: string; summary: string | null }>
  ): AuditDuplicateGroup[] {
    const groupsMap = new Map<string, Array<{ id: string; name: string; summary?: string | null }>>();

    for (const r of rows) {
      const norm = normalizeIdentity(r.name);
      if (!norm) continue;
      const list = groupsMap.get(norm) ?? [];
      list.push(r);
      groupsMap.set(norm, list);
    }

    const result: AuditDuplicateGroup[] = [];
    for (const [normName, items] of groupsMap.entries()) {
      if (items.length < 2) continue;

      const nonNullSummaries = new Set(items.map((i) => (i.summary ?? "").trim()).filter(Boolean));
      const classification: "normalized_name_match" | "strong_field_match" | "conflict_detected" = "normalized_name_match";
      const hasDifferentSummaries = nonNullSummaries.size > 1;
      const reason = hasDifferentSummaries
        ? "候选同名项目（仅名称归一化一致，存在不同摘要，需人工复核）"
        : "候选同名项目（仅名称归一化一致，需人工复核）";

      result.push({
        objectType: "project",
        normalizedName: normName,
        classification,
        items,
        reason,
      });
    }

    return result;
  }

  private static auditPeople(
    rows: Array<{
      id: string;
      name: string;
      role: string | null;
      organization: string | null;
      summary: string | null;
    }>
  ): AuditDuplicateGroup[] {
    const groupsMap = new Map<string, DuplicateAuditItem[]>();

    for (const r of rows) {
      const norm = normalizeIdentity(r.name);
      if (!norm) continue;
      const list = groupsMap.get(norm) ?? [];
      list.push(r);
      groupsMap.set(norm, list);
    }

    const result: AuditDuplicateGroup[] = [];
    for (const [normName, items] of groupsMap.entries()) {
      if (items.length < 2) continue;

      let hasConflict = false;
      let hasStrongMatch = false;

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const comp = comparePersonIdentity(items[i], items[j]);
          if (comp.classification === "conflict_detected") {
            hasConflict = true;
          } else if (comp.classification === "strong_field_match") {
            hasStrongMatch = true;
          }
        }
      }

      const classification: "normalized_name_match" | "strong_field_match" | "conflict_detected" =
        hasConflict
          ? "conflict_detected"
          : hasStrongMatch
          ? "strong_field_match"
          : "normalized_name_match";

      const reason =
        classification === "conflict_detected"
          ? "人物名称一致但角色/组织存在非空冲突"
          : classification === "strong_field_match"
          ? "人物名称与角色/组织强字段一致"
          : "仅归一化名称相同（单边或缺少强字段）";

      result.push({
        objectType: "person",
        normalizedName: normName,
        classification,
        items,
        reason,
      });
    }

    return result;
  }
}
