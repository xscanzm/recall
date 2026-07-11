import type { DB } from "../Database";

export type MemorySearchType = "fact" | "scene" | "task" | "project" | "decision" | "report" | "person";

export interface MemorySearchItem {
  id: string;
  type: MemorySearchType;
  title: string;
  summary?: string;
  createdAt: string;
  projectName?: string;
  projectId?: string | null;
  sourceType?: "observation" | "fact" | "scene" | "project" | "report";
  sourceId?: string | null;
  relevance: number;
}

interface SearchRow {
  object_id: string;
  object_type: MemorySearchType;
  title: string;
  summary: string;
  created_at: string;
  project_id: string | null;
  project_name: string | null;
  source_type: MemorySearchItem["sourceType"] | null;
  source_id: string | null;
  relevance: number;
  total: number;
}

export class MemorySearchRepository {
  constructor(private readonly db: DB) {}

  search(query: string, limit: number, offset: number): { results: MemorySearchItem[]; total: number } {
    const match = toLiteralFtsQuery(query);
    if (!match) return { results: [], total: 0 };

    const rows = this.db.prepare(`
      WITH matches AS (
        SELECT rowid, object_id, object_type, title, summary, created_at, project_id,
               source_type, source_id, bm25(memory_search_fts, 0.0, 0.0, 6.0, 2.5, 1.0) AS rank
        FROM memory_search_fts
        WHERE memory_search_fts MATCH ?
      ), counted AS (
        SELECT *, COUNT(*) OVER () AS total FROM matches
      )
      SELECT counted.*, projects.name AS project_name, -rank AS relevance
      FROM counted
      LEFT JOIN projects ON projects.id = counted.project_id AND projects.archived_at IS NULL
      ORDER BY rank ASC, created_at DESC, object_type ASC, object_id ASC
      LIMIT ? OFFSET ?
    `).all(match, limit, offset) as SearchRow[];

    const total = rows[0]?.total ?? (offset > 0 ? this.count(match) : 0);
    return {
      total,
      results: rows.map((row) => ({
        id: row.object_id,
        type: row.object_type,
        title: row.title,
        summary: row.summary || undefined,
        createdAt: row.created_at,
        projectName: row.project_name ?? undefined,
        projectId: row.project_id,
        sourceType: row.source_type ?? undefined,
        sourceId: row.source_id,
        relevance: row.relevance,
      })),
    };
  }

  private count(match: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM memory_search_fts WHERE memory_search_fts MATCH ?").get(match) as { count: number }).count;
  }
}

export function toLiteralFtsQuery(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}
