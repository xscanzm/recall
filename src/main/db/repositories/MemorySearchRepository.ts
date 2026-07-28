import fs from "node:fs";
import path from "node:path";
import type { DB } from "../Database";

export type MemorySearchType = "fact" | "scene" | "task" | "project" | "decision" | "report" | "person" | "record";
export type MemoryDetailType = MemorySearchType | "timeline";

export interface MemorySearchFilters {
  timeFrom?: string;
  timeTo?: string;
  projectId?: string;
  type?: MemorySearchType;
  personId?: string;
}

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
  matchReasons: string[];
  sourceCount: number;
}

export interface MemorySearchResponse {
  results: MemorySearchItem[];
  total: number;
  quality: "strong" | "weak" | "none";
  queryTerms: string[];
}

export interface MemorySearchRef {
  id: string;
  type: MemorySearchType;
}

export interface MemoryDetailRef {
  id: string;
  type: MemoryDetailType;
}

export interface MemoryVisibleContent {
  type: "webpage" | "document" | "chat" | "code" | "spreadsheet" | "design" | "email" | "terminal" | "unknown";
  summary: string;
  fullText: string;
  keyTextSnippets: string[];
}

export interface MemorySource {
  id: string;
  capturedAt: string;
  appName: string;
  windowTitle: string;
  url: string | null;
  summary: string;
  visibleContent: MemoryVisibleContent[];
  screenshotState: "available" | "expired" | "none";
  screenshotCount: number;
}

export interface MemoryDetail {
  id: string;
  type: MemoryDetailType;
  title: string;
  summary: string;
  createdAt: string;
  projectId: string | null;
  projectName: string | null;
  fields: Array<{ label: string; value: string }>;
  contentSections: Array<{ title: string; text: string; items: string[] }>;
  sources: MemorySource[];
  relations: Array<MemorySearchRef & { title: string; summary?: string }>;
  correctionType: "fact" | "task" | "scene" | "project" | "person" | "decision" | null;
}

interface SearchRow {
  object_id: string;
  object_type: MemorySearchType;
  title: string;
  summary: string;
  keywords: string;
  created_at: string;
  project_id: string | null;
  source_type: MemorySearchItem["sourceType"] | null;
  source_id: string | null;
  rank?: number;
}

interface ObservationRow {
  id: string;
  captured_at: string;
  app_name: string;
  window_title: string;
  url_or_domain: string | null;
  scene_summary: string;
  visible_content_json: string;
  screenshot_retention: string;
  screenshot_paths_json: string;
  user_facing_summary?: string | null;
  exact_match_reasons?: string[];
}

interface ProjectRow {
  id: string;
  name: string;
  summary: string;
  created_at: string;
}

const QUESTION_STOP_PHRASES = [
  "上周", "本周", "这周", "上个月", "本月", "昨天", "今天", "前天",
  "是什么", "什么", "有什么", "怎么做", "为什么", "哪些", "哪个", "那次", "上次",
  "最近", "当时", "我", "的", "了", "吗", "呢", "和", "与", "关于", "那个",
];

export class MemorySearchRepository {
  constructor(private readonly db: DB) {}

  search(query: string, limit = 50, offset = 0, filters: MemorySearchFilters = {}): MemorySearchResponse {
    const parsedFilters = mergeParsedTime(filters, query);
    const queryTerms = buildSearchTerms(query);
    const trimmedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const projectNames = this.projectNameMap();
    const peopleNames = this.personNameMap();
    const candidates = new Map<string, Candidate>();

    // 精确标识不依赖 FTS 索引。object_id 等 UNINDEXED 字段也必须可直接召回。
    const exactRows = this.executeExactQuery(query, filters, parsedFilters);
    const exactReasonsByKey = new Map<string, string[]>();
    const rowsByKey = new Map<string, SearchRow>();
    for (const row of exactRows) {
      const key = `${row.object_type}:${row.object_id}`;
      rowsByKey.set(key, row);
      exactReasonsByKey.set(key, exactMatchReasons(row, trimmedQuery));
    }

    // 1. 在数据库底层执行 FTS5 MATCH + bm25 检索（带候选上限 500 条）
    const ftsRows = this.executeFtsQuery(queryTerms, filters, parsedFilters);
    for (const row of ftsRows) {
      rowsByKey.set(`${row.object_type}:${row.object_id}`, row);
    }

    for (const row of rowsByKey.values()) {
      const key = `${row.object_type}:${row.object_id}`;
      const exactReasons = exactReasonsByKey.get(key) ?? [];

      const matched = scoreText(queryTerms, [
        { text: row.title, weight: 5, reason: "标题" },
        { text: row.summary, weight: 3, reason: "内容" },
        { text: row.keywords, weight: 1.5, reason: "标签或关联" },
      ]);

      if (!matched && exactReasons.length === 0 && queryTerms.length > 0) continue;

      let relevance = matched?.score ?? 0.1;
      const matchReasons = [...exactReasons, ...(matched?.reasons ?? [])];

      if (exactReasons.includes("exact_id")) relevance += 100;
      if (exactReasons.includes("exact_title")) relevance += 50;
      if (exactReasons.includes("exact_alias")) relevance += 40;
      if (exactReasons.includes("exact_filename")) relevance += 30;
      if (row.rank !== undefined) {
        relevance += Math.max(0, -row.rank * 0.1);
      }

      candidates.set(key, {
        item: {
          id: row.object_id,
          type: row.object_type,
          title: row.title,
          summary: row.summary || undefined,
          createdAt: row.created_at,
          projectName: row.project_id ? projectNames.get(row.project_id) : undefined,
          projectId: row.project_id,
          sourceType: row.source_type ?? undefined,
          sourceId: row.source_id,
          relevance,
          matchReasons: uniqueStrings(matchReasons),
          sourceCount: row.source_id ? 1 : 0,
        },
        sourceObservationIds: row.source_type === "observation" && row.source_id ? [row.source_id] : [],
      });
    }

    // 2. 观察数据检索与关联父级批量读取
    const observations = this.listObservations(parsedFilters, queryTerms, query);
    if (observations.length > 0) {
      const parentMap = this.buildObservationParentsForObs(observations.map((o) => o.id));
      const neededParentKeys = new Set<string>();
      for (const parents of parentMap.values()) {
        for (const p of parents) {
          neededParentKeys.add(`${p.type}:${p.id}`);
        }
      }
      const parentRowsMap = this.batchGetFtsRowsByKeys(Array.from(neededParentKeys));

      for (const observation of observations) {
        const observationText = observationSearchText(observation);
        const matched = scoreText(queryTerms, [
          { text: observation.window_title, weight: 3, reason: "窗口" },
          { text: observation.scene_summary, weight: 3, reason: "识别摘要" },
          { text: observationText, weight: 2, reason: "识别内容" },
        ]);
        const exactReasons = observation.exact_match_reasons ?? [];
        if (!matched && exactReasons.length === 0 && queryTerms.length > 0) continue;
        const observationRelevance = (matched?.score ?? 0.1) + exactReasonBoost(exactReasons);
        const observationReasons = uniqueStrings([...exactReasons, ...(matched?.reasons ?? [])]);
        const parents = parentMap.get(observation.id) ?? [];
        if (parents.length === 0) {
          if (filters.type && filters.type !== "record") continue;
          if (filters.projectId) continue;
          const key = `record:${observation.id}`;
          candidates.set(key, {
            item: {
              id: observation.id,
              type: "record",
              title: observation.user_facing_summary || observation.window_title || "屏幕记录",
              summary: observation.scene_summary || firstVisibleSummary(observation),
              createdAt: observation.captured_at,
              projectId: null,
              sourceType: "observation",
              sourceId: observation.id,
              relevance: observationRelevance,
              matchReasons: observationReasons.length > 0 ? observationReasons : ["识别内容"],
              sourceCount: 1,
            },
            sourceObservationIds: [observation.id],
          });
          continue;
        }

        for (const parent of parents) {
          if (filters.type && filters.type !== parent.type) continue;
          const key = `${parent.type}:${parent.id}`;
          const parentRow = parentRowsMap.get(key);
          if (!parentRow || !this.matchesRowFilters(parentRow, filters, parsedFilters)) continue;
          let parentCandidate = candidates.get(key);
          if (!parentCandidate) {
            parentCandidate = {
              item: {
                id: parentRow.object_id,
                type: parentRow.object_type,
                title: parentRow.title,
                summary: parentRow.summary || undefined,
                createdAt: parentRow.created_at,
                projectName: parentRow.project_id ? projectNames.get(parentRow.project_id) : undefined,
                projectId: parentRow.project_id,
                sourceType: parentRow.source_type ?? undefined,
                sourceId: parentRow.source_id,
                relevance: 0.5,
                matchReasons: ["识别内容"],
                sourceCount: parentRow.source_id ? 1 : 0,
              },
              sourceObservationIds: parentRow.source_id && parentRow.source_type === "observation" ? [parentRow.source_id] : [],
            };
            candidates.set(key, parentCandidate);
          }
          parentCandidate.item.relevance += observationRelevance * 0.7;
          parentCandidate.item.matchReasons = uniqueStrings([
            ...parentCandidate.item.matchReasons,
            ...(observationReasons.length > 0 ? observationReasons : ["识别内容"]),
          ]);
          parentCandidate.sourceObservationIds = uniqueStrings([...parentCandidate.sourceObservationIds, observation.id]);
          parentCandidate.item.sourceCount = parentCandidate.sourceObservationIds.length;
        }
      }
    }

    const sorted = Array.from(candidates.values())
      .filter((candidate) => this.matchesPersonFilter(candidate, filters.personId, peopleNames))
      .sort((a, b) => b.item.relevance - a.item.relevance || b.item.createdAt.localeCompare(a.item.createdAt))
      .map((candidate) => candidate.item);
    const total = sorted.length;
    const results = sorted.slice(offset, offset + limit);
    const quality = classifyQuality(sorted);
    return { results, total, quality, queryTerms };
  }

  getDetail(ref: MemoryDetailRef): MemoryDetail | null {
    const projectNames = this.projectNameMap();
    const record = this.readRecord(ref);
    if (!record) return null;
    const sourceObservationIds = this.collectSourceObservationIds(ref, record);
    const sources = this.readSources(sourceObservationIds);
    const projectId = record.projectId ?? null;
    const relations = this.readRelations(ref, record);
    return {
      id: ref.id,
      type: ref.type,
      title: record.title,
      summary: record.summary,
      createdAt: record.createdAt,
      projectId,
      projectName: projectId ? projectNames.get(projectId) ?? null : null,
      fields: record.fields,
      contentSections: record.contentSections,
      sources,
      relations,
      correctionType: ["fact", "task", "scene", "project", "person", "decision"].includes(ref.type)
        ? (ref.type as MemoryDetail["correctionType"])
        : null,
    };
  }

  getCandidates(refs: MemorySearchRef[], filters: MemorySearchFilters = {}): MemorySearchItem[] {
    const result: MemorySearchItem[] = [];
    const projectNames = this.projectNameMap();
    const peopleNames = this.personNameMap();
    const rowsByKey = this.batchGetFtsRowsByKeys(refs.map((ref) => `${ref.type}:${ref.id}`));

    for (const ref of refs) {
      const row = rowsByKey.get(`${ref.type}:${ref.id}`);
      if (!row || !this.matchesRowFilters(row, filters, filters)) continue;
      const candidate: Candidate = {
        item: {
          id: row.object_id,
          type: row.object_type,
          title: row.title,
          summary: row.summary || undefined,
          createdAt: row.created_at,
          projectName: row.project_id ? projectNames.get(row.project_id) : undefined,
          projectId: row.project_id,
          sourceType: row.source_type ?? undefined,
          sourceId: row.source_id,
          relevance: 1,
          matchReasons: [],
          sourceCount: row.source_id ? 1 : 0,
        },
        sourceObservationIds: row.source_type === "observation" && row.source_id ? [row.source_id] : [],
      };
      if (!this.matchesPersonFilter(candidate, filters.personId, peopleNames)) continue;
      result.push(candidate.item);
    }
    return result;
  }

  getSourcePreview(observationId: string, index: number): { dataUrl?: string; code?: string; message?: string } {
    const row = this.db.prepare("SELECT screenshot_paths_json, screenshot_retention FROM observations WHERE id = ?").get(observationId) as { screenshot_paths_json?: string; screenshot_retention?: string } | undefined;
    if (!row) return { code: "not_found", message: "来源记录不存在" };
    if (row.screenshot_retention === "expired" || row.screenshot_retention === "deleted") {
      return { code: "expired", message: "原始截图已按保留策略清理" };
    }
    const paths = parseArray<string>(row.screenshot_paths_json);
    const filePath = paths[index];
    if (!filePath) return { code: "not_found", message: "截图不存在" };
    try {
      if (!fs.existsSync(filePath)) return { code: "expired", message: "原始截图已按保留策略清理" };
      const stat = fs.statSync(filePath);
      if (stat.size > 8 * 1024 * 1024) return { code: "too_large", message: "截图过大，暂不支持预览" };
      const mime = mimeForPath(filePath);
      return { dataUrl: `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}` };
    } catch {
      return { code: "read_failed", message: "读取截图失败" };
    }
  }

  private executeExactQuery(
    query: string,
    filters: MemorySearchFilters,
    parsed: ParsedFilters
  ): SearchRow[] {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (!normalized || filters.type === "record") return [];

    const exactConditions = ["lower(object_id) = ?", "lower(title) = ?"];
    const exactParams: unknown[] = [normalized, normalized];
    exactConditions.push(`(
      object_type IN ('project', 'person')
      AND EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(keywords) THEN keywords ELSE '[]' END) AS alias
        WHERE lower(CAST(alias.value AS TEXT)) = ?
      )
    )`);
    exactParams.push(normalized);

    if (looksLikeFilename(normalized)) {
      const pattern = `%${escapeLike(normalized)}%`;
      exactConditions.push(`(
        lower(COALESCE(title, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(summary, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(keywords, '')) LIKE ? ESCAPE '\\'
      )`);
      exactParams.push(pattern, pattern, pattern);
    }

    const conditions = [`(${exactConditions.join(" OR ")})`];
    const params = [...exactParams];
    if (filters.type) { conditions.push("object_type = ?"); params.push(filters.type); }
    if (filters.projectId) { conditions.push("project_id = ?"); params.push(filters.projectId); }
    if (parsed.timeFrom) { conditions.push("created_at >= ?"); params.push(parsed.timeFrom); }
    if (parsed.timeTo) { conditions.push("created_at < ?"); params.push(parsed.timeTo); }

    return this.db.prepare(`
      SELECT object_id, object_type, title, summary, keywords, created_at,
             project_id, source_type, source_id
      FROM memory_search_fts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT 100
    `).all(...params) as SearchRow[];
  }

  private executeFtsQuery(
    terms: string[],
    filters: MemorySearchFilters,
    parsed: ParsedFilters
  ): SearchRow[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.type) {
      conditions.push("object_type = ?");
      params.push(filters.type);
    }
    if (filters.projectId) {
      conditions.push("project_id = ?");
      params.push(filters.projectId);
    }
    if (parsed.timeFrom) {
      conditions.push("created_at >= ?");
      params.push(parsed.timeFrom);
    }
    if (parsed.timeTo) {
      conditions.push("created_at < ?");
      params.push(parsed.timeTo);
    }

    // 尝试构建 FTS5 MATCH
    const ftsExpr = toFtsMatchExpression(terms);
    if (ftsExpr) {
      try {
        const whereClause = ["memory_search_fts MATCH ?", ...conditions].join(" AND ");
        const sql = `
          SELECT object_id, object_type, title, summary, keywords, created_at,
                 project_id, source_type, source_id, bm25(memory_search_fts) as rank
          FROM memory_search_fts
          WHERE ${whereClause}
          ORDER BY bm25(memory_search_fts)
          LIMIT 500
        `;
        return this.db.prepare(sql).all(ftsExpr, ...params) as SearchRow[];
      } catch {
        // 静默降级到 LIKE 渠道
      }
    }

    // 只有无法构造 usable FTS 或 MATCH 执行失败时，才使用有界 LIKE 渠道。
    // 成功执行但零结果必须直接返回，避免把 FTS 省下的全表扫描又做一遍。
    const likeConditions = [...conditions];
    const likeParams = [...params];

    if (terms.length > 0) {
      const searchable = "title || ' ' || summary || ' ' || keywords";
      likeConditions.push(`(${terms.map(() => `${searchable} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      likeParams.push(...terms.map((term) => `%${escapeLike(term)}%`));
    }

    const where = likeConditions.length ? `WHERE ${likeConditions.join(" AND ")}` : "";
    const sql = `
      SELECT object_id, object_type, title, summary, keywords, created_at,
             project_id, source_type, source_id, 0 as rank
      FROM memory_search_fts
      ${where}
      ORDER BY created_at DESC
      LIMIT 500
    `;
    return this.db.prepare(sql).all(...likeParams) as SearchRow[];
  }

  private listObservations(filters: ParsedFilters, terms: string[], query: string): ObservationRow[] {
    const conditions: string[] = [];
    const params: string[] = [];
    if (filters.timeFrom) { conditions.push("captured_at >= ?"); params.push(filters.timeFrom); }
    if (filters.timeTo) { conditions.push("captured_at < ?"); params.push(filters.timeTo); }
    const byId = new Map<string, ObservationRow>();

    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    if (normalized) {
      const exactConditions = [
        "lower(id) = ?",
        "lower(window_title) = ?",
        "lower(COALESCE(user_facing_summary, '')) = ?",
      ];
      const exactParams = [normalized, normalized, normalized];
      if (looksLikeFilename(normalized)) {
        const pattern = `%${escapeLike(normalized)}%`;
        exactConditions.push(
          "lower(COALESCE(window_title, '')) LIKE ? ESCAPE '\\'",
          "lower(COALESCE(url_or_domain, '')) LIKE ? ESCAPE '\\'",
          "lower(COALESCE(visible_content_json, '')) LIKE ? ESCAPE '\\'"
        );
        exactParams.push(pattern, pattern, pattern);
      }
      const exactWhere = [`(${exactConditions.join(" OR ")})`, ...conditions].join(" AND ");
      const exactRows = this.db.prepare(`
        SELECT id, captured_at, app_name, window_title, url_or_domain, scene_summary,
               visible_content_json, screenshot_retention, screenshot_paths_json, user_facing_summary
        FROM observations
        WHERE ${exactWhere}
        ORDER BY captured_at DESC
        LIMIT 100
      `).all(...exactParams, ...params) as ObservationRow[];
      for (const row of exactRows) {
        byId.set(row.id, { ...row, exact_match_reasons: exactObservationMatchReasons(row, normalized) });
      }
    }

    const ftsExpr = toFtsMatchExpression(terms);
    let ftsSuccess = false;
    if (ftsExpr) {
      try {
        const ftsConditions = conditions.map((c) => `o.${c}`);
        const ftsWhere = [`observation_search_fts MATCH ?`, ...ftsConditions].join(" AND ");
        const rows = this.db.prepare(`
          SELECT o.id, o.captured_at, o.app_name, o.window_title, o.url_or_domain,
                 o.scene_summary, o.visible_content_json, o.screenshot_retention,
                 o.screenshot_paths_json, o.user_facing_summary
          FROM observation_search_fts
          JOIN observations o ON o.id = observation_search_fts.observation_id
          WHERE ${ftsWhere}
          ORDER BY bm25(observation_search_fts), o.captured_at DESC
          LIMIT 500
        `).all(ftsExpr, ...params) as ObservationRow[];

        for (const row of rows) {
          const existing = byId.get(row.id);
          byId.set(row.id, { ...row, exact_match_reasons: existing?.exact_match_reasons });
        }
        ftsSuccess = true;
      } catch {
        // 静默降级
      }
    }

    // FTS 成功执行时不得再无条件执行 LIKE 全表兜底
    if (!ftsSuccess) {
      const likeConditions = [...conditions];
      const likeParams = [...params];
      if (terms.length > 0) {
        const searchable = "COALESCE(user_facing_summary, '') || ' ' || scene_summary || ' ' || window_title || ' ' || app_name || ' ' || COALESCE(url_or_domain, '') || ' ' || visible_content_json";
        likeConditions.push(`(${terms.map(() => `${searchable} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
        likeParams.push(...terms.map((term) => `%${escapeLike(term)}%`));
      }
      const where = likeConditions.length ? `WHERE ${likeConditions.join(" AND ")}` : "";
      const likeRows = this.db.prepare(`
        SELECT id, captured_at, app_name, window_title, url_or_domain, scene_summary,
               visible_content_json, screenshot_retention, screenshot_paths_json, user_facing_summary
        FROM observations ${where} ORDER BY captured_at DESC LIMIT 500
      `).all(...likeParams) as ObservationRow[];
      for (const row of likeRows) {
        const existing = byId.get(row.id);
        byId.set(row.id, { ...row, exact_match_reasons: existing?.exact_match_reasons });
      }
    }

    return Array.from(byId.values());
  }

  private buildObservationParentsForObs(obsIds: string[]): Map<string, MemorySearchRef[]> {
    const map = new Map<string, MemorySearchRef[]>();
    if (obsIds.length === 0) return map;

    const append = (observationId: string, ref: MemorySearchRef) => {
      const list = map.get(observationId) ?? [];
      list.push(ref);
      map.set(observationId, list);
    };

    const obsSet = new Set(obsIds);
    // 仅按传入的 obsIds 带条件过滤查询 facts 与 scenes，消除全表扫描
    const factLikeConditions = obsIds.map(() => "source_observation_ids_json LIKE ?").join(" OR ");
    const factParams = obsIds.map((id) => `%"${id}"%`);
    const factRows = this.db.prepare(
      `SELECT id, source_observation_ids_json FROM facts WHERE deleted_at IS NULL AND (${factLikeConditions})`
    ).all(...factParams) as Array<{ id: string; source_observation_ids_json: string }>;

    for (const fact of factRows) {
      for (const id of parseArray<string>(fact.source_observation_ids_json)) {
        if (obsSet.has(id)) append(id, { id: fact.id, type: "fact" });
      }
    }

    const sceneLikeConditions = obsIds.map(() => "observation_ids_json LIKE ?").join(" OR ");
    const sceneParams = obsIds.map((id) => `%"${id}"%`);
    const sceneRows = this.db.prepare(
      `SELECT id, observation_ids_json FROM scenes WHERE deleted_at IS NULL AND (${sceneLikeConditions})`
    ).all(...sceneParams) as Array<{ id: string; observation_ids_json: string }>;

    for (const scene of sceneRows) {
      for (const id of parseArray<string>(scene.observation_ids_json)) {
        if (obsSet.has(id)) append(id, { id: scene.id, type: "scene" });
      }
    }
    return map;
  }

  private batchGetFtsRowsByKeys(keys: string[]): Map<string, SearchRow> {
    const map = new Map<string, SearchRow>();
    if (keys.length === 0) return map;

    // 按 type 分组使用 IN (...) 语句批量查找，消除 N+1 查询
    const byType = new Map<string, string[]>();
    for (const key of keys) {
      const [type, id] = key.split(":");
      if (!type || !id) continue;
      const list = byType.get(type) ?? [];
      list.push(id);
      byType.set(type, list);
    }

    for (const [type, ids] of byType.entries()) {
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT object_id, object_type, title, summary, keywords, created_at, project_id, source_type, source_id
        FROM memory_search_fts
        WHERE object_type = ? AND object_id IN (${placeholders})
      `).all(type, ...ids) as SearchRow[];

      for (const r of rows) {
        map.set(`${r.object_type}:${r.object_id}`, r);
      }
    }

    return map;
  }

  private projectNameMap(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name, summary, created_at FROM projects WHERE archived_at IS NULL").all() as ProjectRow[];
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private personNameMap(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name FROM people WHERE deleted_at IS NULL").all() as Array<{ id: string; name: string }>;
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  private matchesPersonFilter(candidate: Candidate, personId: string | undefined, peopleNames: Map<string, string>): boolean {
    if (!personId) return true;
    if (candidate.item.type === "person" && candidate.item.id === personId) return true;
    const personName = peopleNames.get(personId);
    if (!personName) return false;
    return `${candidate.item.title} ${candidate.item.summary ?? ""}`.includes(personName);
  }

  private matchesRowFilters(
    row: SearchRow,
    filters: MemorySearchFilters,
    parsed: ParsedFilters
  ): boolean {
    if (filters.type && row.object_type !== filters.type) return false;
    if (filters.projectId && row.project_id !== filters.projectId) return false;
    if (parsed.timeFrom && row.created_at < parsed.timeFrom) return false;
    if (parsed.timeTo && row.created_at >= parsed.timeTo) return false;
    return true;
  }

  private readRecord(ref: MemoryDetailRef): RecordData | null {
    const tableByType: Partial<Record<MemorySearchType, string>> = {
      fact: "facts", scene: "scenes", task: "tasks", project: "projects", decision: "decisions", person: "people", report: "reports",
    };
    if (ref.type === "record") {
      const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(ref.id) as ObservationRow | undefined;
      if (!row) return null;
      return {
        title: row.user_facing_summary || row.window_title || "屏幕记录",
        summary: row.scene_summary || firstVisibleSummary(row),
        createdAt: row.captured_at,
        projectId: null,
        fields: [{ label: "应用", value: row.app_name }, { label: "窗口", value: row.window_title }, ...(row.url_or_domain ? [{ label: "来源", value: row.url_or_domain }] : [])],
        contentSections: [{ title: "识别内容", text: row.scene_summary, items: visibleContentItems(row) }],
        sourceObservationIds: [row.id],
        sourceFactIds: [],
        sourceSceneIds: [],
        factIds: [],
      };
    }
    if (ref.type === "timeline") {
      const row = this.db.prepare("SELECT * FROM timeline_blocks WHERE id = ?").get(ref.id) as Record<string, unknown> | undefined;
      if (!row) return null;
      const projectIds = parseArray<string>(row.project_ids_json);
      const projectNames = parseArray<string>(row.project_names_json);
      const highlights = parseArray<string>(row.highlights_json);
      const generatedTasks = parseArray<string>(row.generated_tasks_json);
      const generatedDecisions = parseArray<string>(row.generated_decisions_json);
      return {
        title: String(row.title ?? "时间轴片段"),
        summary: String(row.summary ?? ""),
        createdAt: String(row.created_at ?? row.start_at ?? ""),
        projectId: projectIds[0] ?? null,
        fields: [
          { label: "开始", value: String(row.start_at ?? "") },
          { label: "结束", value: String(row.end_at ?? "") },
          { label: "类型", value: String(row.category ?? "") },
          { label: "整理把握", value: formatNumber(row.confidence) },
          { label: "关联项目", value: projectNames.join("、") },
        ],
        contentSections: [
          { title: "时间轴片段", text: String(row.summary ?? ""), items: highlights },
          { title: "接下来要做", text: "", items: generatedTasks },
          { title: "形成的决定", text: "", items: generatedDecisions },
        ],
        sourceObservationIds: parseArray<string>(row.source_observation_ids_json),
        sourceFactIds: parseArray<string>(row.source_fact_ids_json),
        sourceSceneIds: parseArray<string>(row.source_scene_ids_json),
        factIds: [],
      };
    }
    const table = tableByType[ref.type];
    if (!table) return null;
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(ref.id) as Record<string, unknown> | undefined;
    if (!row || row.deleted_at != null || row.archived_at != null) return null;
    const createdAt = String(row.created_at ?? row.updated_at ?? "");
    const projectId = row.project_id ? String(row.project_id) : null;
    const sourceMeta: Pick<RecordData, "sourceObservationIds" | "sourceFactIds" | "sourceSceneIds" | "factIds"> = {
      sourceObservationIds: parseArray<string>(row.source_observation_ids_json),
      sourceFactIds: parseArray<string>(row.source_fact_ids_json),
      sourceSceneIds: parseArray<string>(row.source_scene_ids_json),
      factIds: parseArray<string>(row.fact_ids_json),
    };
    switch (ref.type) {
      case "fact": return { ...sourceMeta, title: String(row.content ?? "资料"), summary: String(row.evidence_text ?? ""), createdAt, projectId, fields: [{ label: "类型", value: String(row.type ?? "资料") }, { label: "置信度", value: formatNumber(row.confidence) }], contentSections: [{ title: "具体内容", text: String(row.content ?? ""), items: row.evidence_text ? [String(row.evidence_text)] : [] }] };
      case "scene": return { ...sourceMeta, sourceObservationIds: uniqueStrings([...sourceMeta.sourceObservationIds, ...parseArray<string>(row.observation_ids_json)]), title: String(row.title ?? "工作片段"), summary: String(row.summary ?? ""), createdAt, projectId, fields: [{ label: "开始", value: String(row.start_at ?? "") }, { label: "结束", value: String(row.end_at ?? "") }], contentSections: [{ title: "工作片段", text: String(row.summary ?? ""), items: parseArray<string>(row.entity_names_json as string) }] };
      case "task": return { ...sourceMeta, title: String(row.title ?? "任务"), summary: String(row.summary ?? ""), createdAt, projectId, fields: [{ label: "状态", value: String(row.status ?? "") }, ...(row.due_hint ? [{ label: "期限", value: String(row.due_hint) }] : [])], contentSections: [{ title: "任务内容", text: String(row.summary ?? ""), items: [] }] };
      case "decision": return { ...sourceMeta, title: String(row.title ?? "决策"), summary: String(row.decision ?? ""), createdAt, projectId, fields: [{ label: "决定时间", value: String(row.decided_at ?? row.created_at ?? "") }], contentSections: [{ title: "决策", text: String(row.decision ?? ""), items: row.rationale ? [`理由：${String(row.rationale)}`] : [] }] };
      case "project": return { ...sourceMeta, title: String(row.name ?? "项目"), summary: String(row.summary ?? ""), createdAt, projectId: String(row.id), fields: [{ label: "状态", value: String(row.status ?? "") }], contentSections: [{ title: "项目概览", text: String(row.summary ?? ""), items: [] }] };
      case "person": return { ...sourceMeta, title: String(row.name ?? "人物"), summary: String(row.summary ?? ""), createdAt, projectId: null, fields: [{ label: "角色", value: String(row.role ?? "") }, ...(row.organization ? [{ label: "组织", value: String(row.organization) }] : [])], contentSections: [{ title: "人物概览", text: String(row.summary ?? ""), items: [] }] };
      case "report": return { ...sourceMeta, title: String(row.title ?? "报告"), summary: stringifyContent(row.content_json), createdAt, projectId, fields: [{ label: "类型", value: String(row.type ?? "") }, { label: "日期", value: String(row.date_key ?? "") }], contentSections: [{ title: "报告正文", text: stringifyContent(row.content_json), items: [] }] };
      default: return null;
    }
  }

  private collectSourceObservationIds(ref: MemoryDetailRef, record: RecordData): string[] {
    if (ref.type === "record") return [ref.id];
    return uniqueStrings([...record.sourceObservationIds, ...this.observationsForFacts(uniqueStrings([...record.sourceFactIds, ...record.factIds])), ...this.observationsForScenes(record.sourceSceneIds)]);
  }

  private observationsForFacts(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT source_observation_ids_json FROM facts WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ source_observation_ids_json: string }>;
    return rows.flatMap((row) => parseArray<string>(row.source_observation_ids_json));
  }

  private observationsForScenes(ids: string[]): string[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT observation_ids_json FROM scenes WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ observation_ids_json: string }>;
    return rows.flatMap((row) => parseArray<string>(row.observation_ids_json));
  }

  private readSources(ids: string[]): MemorySource[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT id, captured_at, app_name, window_title, url_or_domain, scene_summary, visible_content_json, screenshot_retention, screenshot_paths_json, user_facing_summary FROM observations WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids) as ObservationRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byId.get(id)).filter((row): row is ObservationRow => !!row).map((row) => {
      const paths = parseArray<string>(row.screenshot_paths_json);
      const expired = row.screenshot_retention === "expired" || row.screenshot_retention === "deleted";
      const existingCount = paths.filter((filePath) => { try { return fs.existsSync(filePath); } catch { return false; } }).length;
      return {
        id: row.id,
        capturedAt: row.captured_at,
        appName: row.app_name,
        windowTitle: row.window_title,
        url: row.url_or_domain,
        summary: row.user_facing_summary || row.scene_summary,
        visibleContent: parseVisibleContent(row.visible_content_json),
        screenshotState: expired ? "expired" : existingCount > 0 ? "available" : paths.length > 0 ? "expired" : "none",
        screenshotCount: existingCount,
      };
    });
  }

  private readRelations(ref: MemoryDetailRef, row: RecordData): Array<MemorySearchRef & { title: string; summary?: string }> {
    if (ref.type === "record") return [];
    const relationRefs: MemorySearchRef[] = [];
    if (row.projectId && ref.type !== "project") relationRefs.push({ id: row.projectId, type: "project" });
    for (const id of row.sourceFactIds) relationRefs.push({ id, type: "fact" });
    for (const id of row.sourceSceneIds) relationRefs.push({ id, type: "scene" });
    const results: Array<MemorySearchRef & { title: string; summary?: string }> = [];
    for (const relation of relationRefs.slice(0, 12)) {
      const related = this.readRecord(relation);
      if (related) results.push({ id: relation.id, type: relation.type, title: related.title, summary: related.summary || undefined });
    }
    return uniqueRelations(results);
  }
}

interface Candidate { item: MemorySearchItem; sourceObservationIds: string[] }
interface RecordData { title: string; summary: string; createdAt: string; projectId: string | null; fields: Array<{ label: string; value: string }>; contentSections: Array<{ title: string; text: string; items: string[] }>; sourceObservationIds: string[]; sourceFactIds: string[]; sourceSceneIds: string[]; factIds: string[] }
interface ParsedFilters { timeFrom?: string; timeTo?: string }

function buildSearchTerms(query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  if (!normalized) return [];
  const terms = new Set<string>();
  const asciiTokens = normalized.split(/[^\p{L}\p{N}\u3400-\u9fff]+/u).filter(Boolean);
  for (const token of asciiTokens) {
    let reduced = token;
    for (const phrase of QUESTION_STOP_PHRASES) reduced = reduced.replaceAll(phrase, " ");
    for (const part of reduced.split(/\s+/u).filter(Boolean)) {
      if (/^[\u3400-\u9fff]+$/u.test(part) && part.length > 4) {
        for (let i = 0; i < part.length - 1; i++) terms.add(part.slice(i, i + 2));
        for (let i = 0; i < part.length - 2; i += 2) terms.add(part.slice(i, i + 3));
      } else if (part.length > 1) terms.add(part);
    }
  }
  return Array.from(terms).slice(0, 24);
}

export function searchQueryTerms(query: string): string[] { return buildSearchTerms(query); }

function toFtsMatchExpression(terms: string[]): string | null {
  const cleanTerms = terms
    .map((t) => t.replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, "").trim())
    .filter((t) => t.length >= 3);
  if (cleanTerms.length === 0) return null;
  return cleanTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
}

function scoreText(terms: string[], fields: Array<{ text: string | null | undefined; weight: number; reason: string }>): { score: number; reasons: string[] } | null {
  if (terms.length === 0) return { score: 0.1, reasons: [] };
  let score = 0;
  const reasons: string[] = [];
  for (const field of fields) {
    const text = (field.text ?? "").toLocaleLowerCase("zh-CN");
    const hits = terms.filter((term) => text.includes(term));
    if (hits.length > 0) {
      score += (field.weight * hits.length) / Math.max(1, terms.length);
      reasons.push(field.reason);
    }
  }
  return score > 0 ? { score, reasons: uniqueStrings(reasons) } : null;
}

function classifyQuality(items: MemorySearchItem[]): "strong" | "weak" | "none" {
  if (items.length === 0) return "none";
  const top = items[0];
  if (
    top.relevance >= 4.0 ||
    top.matchReasons.some((r) => r.includes("exact") || r === "title_exact" || r === "id_exact" || r === "标题")
  ) {
    return "strong";
  }
  return items.some((item) => item.relevance >= 0.8) ? "weak" : "none";
}

function exactMatchReasons(row: SearchRow, normalizedQuery: string): string[] {
  if (!normalizedQuery) return [];
  const reasons: string[] = [];
  if (row.object_id.toLocaleLowerCase("zh-CN") === normalizedQuery) reasons.push("exact_id");
  if (row.title.toLocaleLowerCase("zh-CN") === normalizedQuery) reasons.push("exact_title");

  if (row.object_type === "project" || row.object_type === "person") {
    const aliases = parseArray<unknown>(row.keywords)
      .map((value) => String(value).trim().toLocaleLowerCase("zh-CN"));
    if (aliases.includes(normalizedQuery)) reasons.push("exact_alias");
  }

  if (looksLikeFilename(normalizedQuery)) {
    const fields = [row.title, row.summary, row.keywords]
      .map((value) => value.toLocaleLowerCase("zh-CN"));
    if (fields.some((value) => value.includes(normalizedQuery))) reasons.push("exact_filename");
  }
  return uniqueStrings(reasons);
}

function exactObservationMatchReasons(row: ObservationRow, normalizedQuery: string): string[] {
  if (!normalizedQuery) return [];
  const reasons: string[] = [];
  if (row.id.toLocaleLowerCase("zh-CN") === normalizedQuery) reasons.push("exact_id");
  if (
    row.window_title.toLocaleLowerCase("zh-CN") === normalizedQuery
    || (row.user_facing_summary ?? "").toLocaleLowerCase("zh-CN") === normalizedQuery
  ) {
    reasons.push("exact_title");
  }
  if (looksLikeFilename(normalizedQuery)) {
    const fields = [row.window_title, row.url_or_domain ?? "", row.visible_content_json]
      .map((value) => value.toLocaleLowerCase("zh-CN"));
    if (fields.some((value) => value.includes(normalizedQuery))) reasons.push("exact_filename");
  }
  return uniqueStrings(reasons);
}

function exactReasonBoost(reasons: string[]): number {
  let boost = 0;
  if (reasons.includes("exact_id")) boost += 100;
  if (reasons.includes("exact_title")) boost += 50;
  if (reasons.includes("exact_alias")) boost += 40;
  if (reasons.includes("exact_filename")) boost += 30;
  return boost;
}

function looksLikeFilename(value: string): boolean {
  const leaf = value.split(/[\\/]/u).at(-1) ?? value;
  return /^[^\s.][^\s]*\.[\p{L}\p{N}]{1,12}$/u.test(leaf);
}

function mergeParsedTime(filters: MemorySearchFilters, query: string): ParsedFilters {
  if (filters.timeFrom || filters.timeTo) return { timeFrom: filters.timeFrom, timeTo: filters.timeTo };
  const now = new Date();
  const start = new Date(now);
  if (query.includes("今天")) start.setHours(0, 0, 0, 0);
  else if (query.includes("昨天")) { start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0); now.setDate(now.getDate() - 1); now.setHours(23, 59, 59, 999); }
  else if (query.includes("上周")) { const day = start.getDay() || 7; start.setDate(start.getDate() - day - 6); start.setHours(0, 0, 0, 0); now.setDate(now.getDate() - day + 1); now.setHours(0, 0, 0, 0); }
  else return {};
  return { timeFrom: start.toISOString(), timeTo: now.toISOString() };
}

function observationSearchText(row: ObservationRow): string {
  return [row.scene_summary, row.user_facing_summary, row.visible_content_json, row.window_title, row.app_name, row.url_or_domain].filter(Boolean).join(" ");
}

function firstVisibleSummary(row: ObservationRow): string {
  const visible = parseVisibleContent(row.visible_content_json);
  return visible.map((item) => item.summary).filter(Boolean).join("；");
}

function visibleContentItems(row: ObservationRow): string[] {
  return parseVisibleContent(row.visible_content_json).flatMap((item) => [item.summary, item.fullText, ...item.keyTextSnippets]).filter(Boolean);
}

function parseVisibleContent(json: string | undefined): MemoryVisibleContent[] {
  const parsed = parseArray<Partial<MemoryVisibleContent>>(json);
  return parsed.map((item) => ({
    type: ["webpage", "document", "chat", "code", "spreadsheet", "design", "email", "terminal", "unknown"].includes(String(item.type)) ? (item.type as MemoryVisibleContent["type"]) : "unknown",
    summary: String(item.summary ?? ""),
    fullText: typeof item.fullText === "string" ? item.fullText : "",
    keyTextSnippets: Array.isArray(item.keyTextSnippets) ? item.keyTextSnippets.map(String) : [],
  }));
}

function parseArray<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (typeof json !== "string") return [];
  try { const parsed = JSON.parse(json); return Array.isArray(parsed) ? parsed as T[] : []; } catch { return []; }
}

function stringifyContent(value: unknown): string {
  if (typeof value !== "string") return value == null ? "" : JSON.stringify(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  } catch { return value; }
}

function formatNumber(value: unknown): string { return typeof value === "number" ? `${Math.round(value * 100)}%` : ""; }
function uniqueStrings(values: string[]): string[] { return Array.from(new Set(values.filter(Boolean))); }
function uniqueRelations(values: Array<MemorySearchRef & { title: string; summary?: string }>): Array<MemorySearchRef & { title: string; summary?: string }> { const seen = new Set<string>(); return values.filter((value) => { const key = `${value.type}:${value.id}`; if (seen.has(key)) return false; seen.add(key); return true; }); }
function mimeForPath(filePath: string): string { const ext = path.extname(filePath).toLocaleLowerCase(); return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"; }
function escapeLike(value: string): string { return value.replace(/[\\%_]/g, (match) => `\\${match}`); }

export function toLiteralFtsQuery(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).map((token) => `"${token.replace(/"/g, '""')}"`).join(" AND ");
}
