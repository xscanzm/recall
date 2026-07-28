import crypto from "node:crypto";
import type { DB } from "../Database";

export interface MemoryEmbeddingRow {
  objectType: string;
  objectId: string;
  modelVersion: string;
  contentHash: string;
  dimension: number;
  encoding: "float32";
  vector: Float32Array;
  updatedAt: string;
}

export class MemoryEmbeddingRepository {
  public static readonly CURRENT_MODEL_VERSION = "bge-small-zh-v1.5";
  public static readonly DIMENSION = 512;
  private cachedSignature: string | null = null;
  private cachedVectors: MemoryEmbeddingRow[] = [];

  constructor(private readonly db: DB) {}

  upsertVector(
    objectType: string,
    objectId: string,
    vector: number[] | Float32Array,
    contentHash: string,
    modelVersion = MemoryEmbeddingRepository.CURRENT_MODEL_VERSION
  ): void {
    const floatArray = vector instanceof Float32Array ? vector : new Float32Array(vector);
    const buffer = Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO memory_embeddings (
        object_type, object_id, model_version, content_hash, dimension, encoding, vector, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'float32', ?, ?)
      ON CONFLICT(object_type, object_id) DO UPDATE SET
        model_version = excluded.model_version,
        content_hash = excluded.content_hash,
        dimension = excluded.dimension,
        encoding = excluded.encoding,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `).run(objectType, objectId, modelVersion, contentHash, floatArray.length, buffer, now);
    this.cachedSignature = null;
  }

  deleteVector(objectType: string, objectId: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM memory_embeddings WHERE object_type = ? AND object_id = ?"
    ).run(objectType, objectId);
    if (result.changes > 0) this.cachedSignature = null;
    return result.changes > 0;
  }

  getVector(objectType: string, objectId: string): MemoryEmbeddingRow | null {
    const row = this.db.prepare(
      "SELECT * FROM memory_embeddings WHERE object_type = ? AND object_id = ?"
    ).get(objectType, objectId) as {
      object_type: string;
      object_id: string;
      model_version: string;
      content_hash: string;
      dimension: number;
      encoding: string;
      vector: Buffer;
      updated_at: string;
    } | undefined;

    if (!row) return null;

    const float32Array = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT
    );

    return {
      objectType: row.object_type,
      objectId: row.object_id,
      modelVersion: row.model_version,
      contentHash: row.content_hash,
      dimension: row.dimension,
      encoding: "float32",
      vector: float32Array,
      updatedAt: row.updated_at,
    };
  }

  listVectors(objectType?: string): MemoryEmbeddingRow[] {
    const signatureRow = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS latest
      FROM memory_embeddings
      WHERE model_version = ?
    `).get(MemoryEmbeddingRepository.CURRENT_MODEL_VERSION) as { count: number; latest: string };
    const signature = `${signatureRow.count}:${signatureRow.latest}`;

    if (this.cachedSignature !== signature) {
      const rows = this.db.prepare(
        "SELECT * FROM memory_embeddings WHERE model_version = ?"
      ).all(MemoryEmbeddingRepository.CURRENT_MODEL_VERSION) as Array<{
        object_type: string;
        object_id: string;
        model_version: string;
        content_hash: string;
        dimension: number;
        encoding: string;
        vector: Buffer;
        updated_at: string;
      }>;

      this.cachedVectors = rows.map((row) => ({
        objectType: row.object_type,
        objectId: row.object_id,
        modelVersion: row.model_version,
        contentHash: row.content_hash,
        dimension: row.dimension,
        encoding: "float32",
        vector: new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT
        ),
        updatedAt: row.updated_at,
      }));
      this.cachedSignature = signature;
    }

    return objectType
      ? this.cachedVectors.filter((row) => row.objectType === objectType)
      : this.cachedVectors;
  }

  getMissingOrStaleObjectIds(
    objectType: string,
    currentObjects: Array<{ id: string; contentHash: string }>
  ): string[] {
    const existing = new Map<string, string>();
    const rows = this.db.prepare(
      "SELECT object_id, content_hash FROM memory_embeddings WHERE object_type = ? AND model_version = ?"
    ).all(objectType, MemoryEmbeddingRepository.CURRENT_MODEL_VERSION) as Array<{
      object_id: string;
      content_hash: string;
    }>;

    for (const r of rows) {
      existing.set(r.object_id, r.content_hash);
    }

    const missingOrStale: string[] = [];
    for (const obj of currentObjects) {
      const hashInDb = existing.get(obj.id);
      if (!hashInDb || hashInDb !== obj.contentHash) {
        missingOrStale.push(obj.id);
      }
    }
    return missingOrStale;
  }
}

export function computeContentHash(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function constructDocumentText(title: string, summary?: string, keywords?: string[]): string {
  const parts = [title.trim()];
  if (summary && summary.trim()) parts.push(summary.trim());
  if (keywords && keywords.length > 0) parts.push(keywords.filter(Boolean).join(" "));
  return parts.join("\n");
}
