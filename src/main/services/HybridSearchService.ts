import type {
  MemorySearchFilters,
  MemorySearchItem,
  MemorySearchRepository,
  MemorySearchResponse,
} from "../db/repositories/MemorySearchRepository";
import type { MemoryEmbeddingRepository } from "../db/repositories/MemoryEmbeddingRepository";
import type { EmbeddingWorkerClient } from "./EmbeddingWorkerClient";

export interface HybridSearchOptions {
  k?: number; // RRF k constant, default 60
  lexicalWeight?: number; // default 1.0
  vectorWeight?: number; // default 0.7
  timeoutMs?: number; // default 1500ms
}

export class HybridSearchService {
  private readonly k: number;
  private readonly lexicalWeight: number;
  private readonly vectorWeight: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly searchRepo: MemorySearchRepository,
    private readonly embeddingRepo: MemoryEmbeddingRepository,
    private readonly workerClient: EmbeddingWorkerClient | null,
    options: HybridSearchOptions = {}
  ) {
    this.k = options.k ?? 60;
    this.lexicalWeight = options.lexicalWeight ?? 1.0;
    this.vectorWeight = options.vectorWeight ?? 0.7;
    this.timeoutMs = options.timeoutMs ?? 1500;
  }

  public async search(
    query: string,
    limit = 50,
    offset = 0,
    filters: MemorySearchFilters = {}
  ): Promise<MemorySearchResponse> {
    // 1. 始终获得词法检索基线结果（作为最强保底）
    const lexicalRes = this.searchRepo.search(query, 500, 0, filters);

    if (!query.trim() || !this.workerClient) {
      return this.sliceResponse(lexicalRes, limit, offset);
    }

    try {
      // 2. 尝试进行向量查询并打标超时与静默降级
      const vectorRes = await this.vectorSearch(query, filters, this.timeoutMs);
      if (!vectorRes || vectorRes.length === 0) {
        return this.sliceResponse(lexicalRes, limit, offset);
      }

      // 3. 执行 RRF 融合
      const fusedItems = this.rrfFusion(lexicalRes.results, vectorRes, query.trim());

      // 4. 计算融合质量
      const quality = lexicalRes.quality === "strong" || fusedItems.some(
        (item) => item.matchReasons.some((reason) => reason.startsWith("exact_"))
      )
        ? "strong"
        : fusedItems.length > 0
        ? "weak"
        : "none";

      const total = fusedItems.length;
      const results = fusedItems.slice(offset, offset + limit);

      return {
        results,
        total,
        quality,
        queryTerms: lexicalRes.queryTerms,
      };
    } catch (e) {
      console.warn("[HybridSearch] Vector search failed or timed out, silently falling back to lexical FTS:", e);
      return this.sliceResponse(lexicalRes, limit, offset);
    }
  }

  private async vectorSearch(
    query: string,
    filters: MemorySearchFilters,
    timeoutMs: number
  ): Promise<MemorySearchItem[]> {
    const vectors = await this.workerClient!.embed([query], true, timeoutMs);
    if (!vectors || vectors.length === 0) return [];
    const queryVec = new Float32Array(vectors[0]);

    // 读取所有存量向量
    const allEmbeddingRows = this.embeddingRepo.listVectors(filters.type);
    if (allEmbeddingRows.length === 0) return [];

    const scored: Array<{ row: typeof allEmbeddingRows[0]; score: number }> = [];

    for (const row of allEmbeddingRows) {
      const score = cosineSimilarity(queryVec, row.vector);
      if (!isNaN(score) && isFinite(score) && score > 0.15) {
        scored.push({ row, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topScored = scored.slice(0, 100);

    const refs = topScored.map((s) => ({
      id: s.row.objectId,
      type: s.row.objectType as MemorySearchItem["type"],
    }));

    const details = this.searchRepo.getCandidates(refs, filters);
    const detailsMap = new Map(details.map((d) => [`${d.type}:${d.id}`, d]));

    const result: MemorySearchItem[] = [];
    for (const s of topScored) {
      const key = `${s.row.objectType}:${s.row.objectId}`;
      const item = detailsMap.get(key);
      if (item) {
        result.push({
          ...item,
          relevance: s.score,
          matchReasons: ["semantic_similarity"],
        });
      }
    }

    return result;
  }

  private rrfFusion(
    lexicalItems: MemorySearchItem[],
    vectorItems: MemorySearchItem[],
    query: string
  ): MemorySearchItem[] {
    const rrfMap = new Map<
      string,
      {
        item: MemorySearchItem;
        lexicalRank?: number;
        vectorRank?: number;
        score: number;
        reasons: Set<string>;
      }
    >();

    // 标注词法排名
    lexicalItems.forEach((item, index) => {
      const key = `${item.type}:${item.id}`;
      const reasons = new Set(item.matchReasons);
      rrfMap.set(key, {
        item,
        lexicalRank: index + 1,
        score: this.lexicalWeight / (this.k + index + 1),
        reasons,
      });
    });

    // 标注向量排名
    vectorItems.forEach((item, index) => {
      const key = `${item.type}:${item.id}`;
      const existing = rrfMap.get(key);
      if (existing) {
        existing.vectorRank = index + 1;
        existing.score += this.vectorWeight / (this.k + index + 1);
        existing.reasons.add("semantic_similarity");
      } else {
        rrfMap.set(key, {
          item,
          vectorRank: index + 1,
          score: this.vectorWeight / (this.k + index + 1),
          reasons: new Set(["semantic_similarity"]),
        });
      }
    });

    // 标题/ID 精确匹配提权通道
    const trimmedQuery = query.toLocaleLowerCase("zh-CN");

    const merged = Array.from(rrfMap.values()).map((entry) => {
      const isExactTitle = entry.item.title.toLocaleLowerCase("zh-CN") === trimmedQuery;
      const isExactId = entry.item.id.toLocaleLowerCase("zh-CN") === trimmedQuery;

      let score = entry.score;
      if (isExactId) {
        score += 10.0;
        entry.reasons.add("exact_id");
      }
      if (isExactTitle) {
        score += 5.0;
        entry.reasons.add("exact_title");
      }

      return {
        ...entry.item,
        relevance: score,
        matchReasons: Array.from(entry.reasons),
      };
    });

    merged.sort((a, b) => b.relevance - a.relevance || b.createdAt.localeCompare(a.createdAt));
    return merged;
  }

  private sliceResponse(
    res: MemorySearchResponse,
    limit: number,
    offset: number
  ): MemorySearchResponse {
    return {
      ...res,
      results: res.results.slice(offset, offset + limit),
    };
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
