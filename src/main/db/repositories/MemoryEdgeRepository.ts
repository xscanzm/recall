// src/main/db/repositories/MemoryEdgeRepository.ts
// 记忆关系层（Edges）数据访问
//
// 用途：
// - 连接 L0 Moment / L1 Episode / L2 Atom / L3 Object / Report
// - 记录关系来源：system / model / user
// - 支持后续重建、纠错、来源追溯

import type { DB } from "../Database";
import type { MemoryEdge, CreateMemoryEdgeInput } from "../../models/types";

interface MemoryEdgeRow {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation_type: string;
  confidence: number;
  created_by: string;
  evidence_ids_json: string;
  status: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export class MemoryEdgeRepository {
  constructor(private db: DB) {}

  list(opts: { status?: string; limit?: number; offset?: number } = {}): MemoryEdge[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 1000;
    const offset = opts.offset ?? 0;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_edges ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as MemoryEdgeRow[];
    return rows.map(mapRow);
  }

  create(input: CreateMemoryEdgeInput): MemoryEdge {
    const id = input.id ?? generateId("edge");
    const now = new Date().toISOString();

    this.validateEndpoint(input.fromType, input.fromId);
    this.validateEndpoint(input.toType, input.toId);
    this.db
      .prepare(
        `INSERT INTO memory_edges (
          id, from_type, from_id, to_type, to_id, relation_type,
          confidence, created_by, evidence_ids_json, status, reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(from_type, from_id, to_type, to_id, relation_type) DO UPDATE SET
          confidence = excluded.confidence,
          created_by = excluded.created_by,
          evidence_ids_json = excluded.evidence_ids_json,
          status = excluded.status,
          reason = excluded.reason,
          updated_at = excluded.updated_at`
      )
      .run(
        id,
        input.fromType,
        input.fromId,
        input.toType,
        input.toId,
        input.relationType,
        input.confidence ?? 1,
        input.createdBy,
        JSON.stringify(input.evidenceIds ?? []),
        input.status ?? "active",
        input.reason ?? null,
        now,
        now
      );

    return this.getByNaturalKey(input.fromType, input.fromId, input.toType, input.toId, input.relationType)!;
  }

  private getByNaturalKey(fromType: string, fromId: string, toType: string, toId: string, relationType: string): MemoryEdge | null {
    const row = this.db.prepare(`SELECT * FROM memory_edges WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND relation_type = ?`)
      .get(fromType, fromId, toType, toId, relationType) as MemoryEdgeRow | undefined;
    return row ? mapRow(row) : null;
  }

  private validateEndpoint(type: string, id: string): void {
    const table = ENDPOINT_TABLES[type];
    if (!table) return;
    const found = this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
    if (!found) throw new Error(`memory edge ${type} endpoint does not exist: ${id}`);
  }

  getById(id: string): MemoryEdge | null {
    const row = this.db
      .prepare("SELECT * FROM memory_edges WHERE id = ?")
      .get(id) as MemoryEdgeRow | undefined;
    return row ? mapRow(row) : null;
  }

  listFrom(fromType: string, fromId: string, opts: { status?: string; limit?: number } = {}): MemoryEdge[] {
    const limit = opts.limit ?? 100;
    if (opts.status) {
      const rows = this.db
        .prepare(
          `SELECT * FROM memory_edges
           WHERE from_type = ? AND from_id = ? AND status = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(fromType, fromId, opts.status, limit) as MemoryEdgeRow[];
      return rows.map(mapRow);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_edges
         WHERE from_type = ? AND from_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(fromType, fromId, limit) as MemoryEdgeRow[];
    return rows.map(mapRow);
  }

  listTo(toType: string, toId: string, opts: { status?: string; limit?: number } = {}): MemoryEdge[] {
    const limit = opts.limit ?? 100;
    if (opts.status) {
      const rows = this.db
        .prepare(
          `SELECT * FROM memory_edges
           WHERE to_type = ? AND to_id = ? AND status = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(toType, toId, opts.status, limit) as MemoryEdgeRow[];
      return rows.map(mapRow);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM memory_edges
         WHERE to_type = ? AND to_id = ?
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(toType, toId, limit) as MemoryEdgeRow[];
    return rows.map(mapRow);
  }

  updateStatus(id: string, status: MemoryEdge["status"], reason?: string | null): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_edges
         SET status = ?, reason = COALESCE(?, reason), updated_at = ?
         WHERE id = ?`
      )
      .run(status, reason ?? null, now, id);
    return result.changes > 0;
  }

  updateStatusByNode(
    nodeType: string,
    nodeId: string,
    status: MemoryEdge["status"],
    reason?: string | null
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE memory_edges
         SET status = ?, reason = COALESCE(?, reason), updated_at = ?
         WHERE (from_type = ? AND from_id = ?)
            OR (to_type = ? AND to_id = ?)`
      )
      .run(status, reason ?? null, now, nodeType, nodeId, nodeType, nodeId);
    return result.changes;
  }
}

const ENDPOINT_TABLES: Record<string, string> = {
  observation: "observations", moment: "observations", fact: "facts", atom: "facts",
  scene: "scenes", episode: "scenes", project: "projects", task: "tasks",
  person: "people", decision: "decisions", report: "reports",
};

export function createMemoryEdgeRepository(db: DB): MemoryEdgeRepository {
  return new MemoryEdgeRepository(db);
}

function mapRow(row: MemoryEdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromType: row.from_type as MemoryEdge["fromType"],
    fromId: row.from_id,
    toType: row.to_type as MemoryEdge["toType"],
    toId: row.to_id,
    relationType: row.relation_type as MemoryEdge["relationType"],
    confidence: row.confidence,
    createdBy: row.created_by as MemoryEdge["createdBy"],
    evidenceIds: safeParseArray<string>(row.evidence_ids_json),
    status: row.status as MemoryEdge["status"],
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParseArray<T = unknown>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
