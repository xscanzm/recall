// src/main/services/HybridSearchService.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  cosineSimilarity,
  HybridSearchService,
} from "./HybridSearchService";

describe("HybridSearchService 混合检索与静默降级", () => {
  it("正确计算 余弦相似度 (Cosine Similarity)", () => {
    const a = new Float32Array([1.0, 0.0, 0.0]);
    const b = new Float32Array([1.0, 0.0, 0.0]);
    const c = new Float32Array([0.0, 1.0, 0.0]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0.0);
  });

  it("当 Worker 故障或超时时，静默降级为完整词法 FTS 结果，不返回空列表", async () => {
    const lexicalItems = [
      {
        id: "fact-1",
        type: "fact" as const,
        title: "保底词法资料",
        summary: "这是词法命中结果",
        createdAt: new Date().toISOString(),
        relevance: 2.0,
        matchReasons: ["标题"],
        sourceCount: 1,
      },
    ];

    const searchRepo = {
      search: vi.fn(() => ({
        results: lexicalItems,
        total: 1,
        quality: "strong" as const,
        queryTerms: ["保底"],
      })),
    };

    const embeddingRepo = {
      listVectors: vi.fn(() => []),
    };

    const failingWorkerClient = {
      embed: vi.fn().mockRejectedValue(new Error("WORKER_CRASHED")),
    };

    const hybridService = new HybridSearchService(
      searchRepo as never,
      embeddingRepo as never,
      failingWorkerClient as never
    );

    const res = await hybridService.search("测试查询");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("fact-1");
    expect(res.results[0].title).toBe("保底词法资料");
  });

  it("当精确 ID 或精确标题匹配时，提权并标注 matchReasons", async () => {
    const lexicalItems = [
      {
        id: "PRD-1024",
        type: "fact" as const,
        title: "PRD-1024 需求文档",
        summary: "核心需求",
        createdAt: new Date().toISOString(),
        relevance: 1.0,
        matchReasons: ["exact_id", "标题"],
        sourceCount: 1,
      },
    ];

    const searchRepo = {
      search: vi.fn(() => ({
        results: lexicalItems,
        total: 1,
        quality: "strong" as const,
        queryTerms: ["PRD-1024"],
      })),
    };

    const embeddingRepo = {
      listVectors: vi.fn(() => []),
    };

    const mockWorkerClient = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    };

    const hybridService = new HybridSearchService(
      searchRepo as never,
      embeddingRepo as never,
      mockWorkerClient as never
    );

    const res = await hybridService.search("PRD-1024");
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe("PRD-1024");
    expect(res.results[0].matchReasons).toContain("exact_id");
  });

  it("向量主路径把项目、人物、类型和时间筛选完整传给候选仓库", async () => {
    const lexicalItem = {
      id: "fact-lexical",
      type: "fact" as const,
      title: "词法候选",
      createdAt: "2026-07-28T01:00:00.000Z",
      relevance: 2,
      matchReasons: ["标题"],
      sourceCount: 0,
    };
    const semanticItem = {
      id: "fact-semantic",
      type: "fact" as const,
      title: "语义候选",
      createdAt: "2026-07-28T02:00:00.000Z",
      relevance: 1,
      matchReasons: [],
      sourceCount: 0,
    };
    const filters = {
      type: "fact" as const,
      projectId: "project-1",
      personId: "person-1",
      timeFrom: "2026-07-28T00:00:00.000Z",
      timeTo: "2026-07-29T00:00:00.000Z",
    };
    const getCandidates = vi.fn(() => [semanticItem]);
    const searchRepo = {
      search: vi.fn(() => ({
        results: [lexicalItem], total: 1, quality: "weak" as const, queryTerms: ["语义"],
      })),
      getCandidates,
    };
    const embeddingRepo = {
      listVectors: vi.fn(() => [{
        objectType: "fact", objectId: "fact-semantic", vector: new Float32Array([1, 0]),
      }]),
    };
    const workerClient = { embed: vi.fn().mockResolvedValue([[1, 0]]) };
    const service = new HybridSearchService(
      searchRepo as never, embeddingRepo as never, workerClient as never
    );

    const result = await service.search("同义改写", 10, 0, filters);

    expect(getCandidates).toHaveBeenCalledWith(
      [{ id: "fact-semantic", type: "fact" }],
      filters
    );
    expect(result.results.map((item) => item.id)).toEqual(expect.arrayContaining([
      "fact-lexical", "fact-semantic",
    ]));
    expect(result.results.find((item) => item.id === "fact-semantic")?.matchReasons)
      .toContain("semantic_similarity");
    expect(result.quality).toBe("weak");
  });

  it("向量不可用时保留词法仓库的完整 total，只对结果页切片", async () => {
    const items = ["one", "two"].map((id) => ({
      id,
      type: "fact" as const,
      title: id,
      createdAt: "2026-07-28T00:00:00.000Z",
      relevance: 1,
      matchReasons: ["内容"],
      sourceCount: 0,
    }));
    const service = new HybridSearchService(
      { search: vi.fn(() => ({ results: items, total: 123, quality: "weak", queryTerms: ["x"] })) } as never,
      { listVectors: vi.fn(() => []) } as never,
      { embed: vi.fn().mockResolvedValue([[1, 0]]) } as never
    );

    const result = await service.search("query", 1, 1);
    expect(result.results.map((item) => item.id)).toEqual(["two"]);
    expect(result.total).toBe(123);
  });
});
