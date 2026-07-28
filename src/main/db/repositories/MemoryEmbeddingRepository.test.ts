// src/main/db/repositories/MemoryEmbeddingRepository.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  computeContentHash,
  constructDocumentText,
  MemoryEmbeddingRepository,
} from "./MemoryEmbeddingRepository";

describe("MemoryEmbeddingRepository 向量存储与版本管理", () => {
  it("生成确定性文本构造与 contentHash", () => {
    const text = constructDocumentText("标题A", "摘要内容 B", ["kw1", "kw2"]);
    expect(text).toBe("标题A\n摘要内容 B\nkw1 kw2");

    const hash1 = computeContentHash(text);
    const hash2 = computeContentHash(text);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it("正确执行 Float32Array 向量 BLOB 序列化与反序列化", () => {
    let storedRow: Record<string, unknown> | null = null;

    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("INSERT INTO memory_embeddings")) {
          return {
            run: (...args: unknown[]) => {
              storedRow = {
                object_type: args[0],
                object_id: args[1],
                model_version: args[2],
                content_hash: args[3],
                dimension: args[4],
                encoding: "float32",
                vector: args[5],
                updated_at: args[6],
              };
              return { changes: 1 };
            },
          };
        }
        if (sql.includes("SELECT * FROM memory_embeddings WHERE object_type = ?")) {
          return {
            get: () => storedRow,
          };
        }
        if (sql.includes("DELETE FROM memory_embeddings")) {
          return {
            run: () => {
              storedRow = null;
              return { changes: 1 };
            },
          };
        }
        return { all: () => [] };
      }),
    };

    const repo = new MemoryEmbeddingRepository(db as never);

    const originalVec = new Float32Array([0.1, -0.5, 0.9, 0.0]);
    repo.upsertVector("fact", "fact-100", originalVec, "hash-123");

    const fetched = repo.getVector("fact", "fact-100");
    expect(fetched).not.toBeNull();
    expect(fetched?.objectType).toBe("fact");
    expect(fetched?.objectId).toBe("fact-100");
    expect(fetched?.dimension).toBe(4);
    const vec = Array.from(fetched!.vector);
    expect(vec[0]).toBeCloseTo(0.1);
    expect(vec[1]).toBeCloseTo(-0.5);
    expect(vec[2]).toBeCloseTo(0.9);
    expect(vec[3]).toBeCloseTo(0.0);

    const deleted = repo.deleteVector("fact", "fact-100");
    expect(deleted).toBe(true);
    expect(repo.getVector("fact", "fact-100")).toBeNull();
  });

  it("复用未变化的向量快照，并在签名变化后重新读取", () => {
    let latest = "2026-07-28T00:00:00.000Z";
    let vectorReads = 0;
    const raw = new Float32Array([1, 0]);
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*) AS count")) {
          return { get: () => ({ count: 1, latest }) };
        }
        if (sql.includes("SELECT * FROM memory_embeddings WHERE model_version")) {
          return {
            all: () => {
              vectorReads++;
              return [{
                object_type: "fact",
                object_id: "fact-cache",
                model_version: MemoryEmbeddingRepository.CURRENT_MODEL_VERSION,
                content_hash: "hash",
                dimension: 2,
                encoding: "float32",
                vector: Buffer.from(raw.buffer),
                updated_at: latest,
              }];
            },
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    const repo = new MemoryEmbeddingRepository(db as never);

    expect(repo.listVectors()).toHaveLength(1);
    expect(repo.listVectors("fact")).toHaveLength(1);
    expect(vectorReads).toBe(1);

    latest = "2026-07-28T00:01:00.000Z";
    expect(repo.listVectors()).toHaveLength(1);
    expect(vectorReads).toBe(2);
  });
});
