import type { DB } from "../db/Database";
import {
  computeContentHash,
  constructDocumentText,
  MemoryEmbeddingRepository,
} from "../db/repositories/MemoryEmbeddingRepository";
import type { EmbeddingWorkerClient } from "./EmbeddingWorkerClient";

export interface IndexableObject {
  objectType: string;
  objectId: string;
  title: string;
  summary?: string;
  keywords?: string[];
}

interface QueuedObject extends IndexableObject {
  generation: number;
}

interface QueueRow {
  object_type: string;
  object_id: string;
  generation: number;
}

const INDEXABLE_SOURCES = [
  {
    table: "facts", type: "fact", title: "content",
    summary: "COALESCE(evidence_text, '') || ' ' || COALESCE(project_hint, '') || ' ' || COALESCE(tags_json, '') || ' ' || COALESCE(people_hints_json, '')",
    active: "deleted_at IS NULL",
  },
  {
    table: "scenes", type: "scene", title: "title",
    summary: "summary || ' ' || COALESCE(entity_names_json, '')",
    active: "deleted_at IS NULL",
  },
  {
    table: "tasks", type: "task", title: "title",
    summary: "COALESCE(summary, '') || ' ' || COALESCE(due_hint, '')",
    active: "deleted_at IS NULL",
  },
  {
    table: "projects", type: "project", title: "name",
    summary: "summary || ' ' || COALESCE(aliases_json, '')",
    active: "archived_at IS NULL",
  },
  {
    table: "decisions", type: "decision", title: "title",
    summary: "decision || ' ' || COALESCE(rationale, '')",
    active: "deleted_at IS NULL",
  },
  {
    table: "people", type: "person", title: "name",
    summary: "COALESCE(role, '') || ' ' || COALESCE(organization, '') || ' ' || summary || ' ' || COALESCE(aliases_json, '')",
    active: "deleted_at IS NULL",
  },
  { table: "reports", type: "report", title: "title", summary: "content_json", active: "1 = 1" },
] as const;

export class EmbeddingIndexerService {
  private isRunning = false;
  private shouldStop = false;
  private loopPromise: Promise<void> | null = null;
  private wakeIdleWait: (() => void) | null = null;
  private readonly batchSize = 10;
  private readonly yieldDelayMs = 50;
  private readonly idlePollMs = 1_000;

  constructor(
    private readonly db: DB,
    private readonly embeddingRepo: MemoryEmbeddingRepository,
    private readonly workerClient: EmbeddingWorkerClient
  ) {}

  public startBackgroundIndexing(): void {
    if (this.isRunning) return;
    this.shouldStop = false;
    this.ensureBackfillQueue();
    this.isRunning = true;

    this.loopPromise = this.indexLoop()
      .catch((error) => {
        console.warn("[EmbeddingIndexer] Indexing loop stopped after an unexpected error:", error);
      })
      .finally(() => {
        this.isRunning = false;
        this.loopPromise = null;
      });
  }

  public async stopAndDrain(): Promise<void> {
    this.shouldStop = true;
    this.wakeIdleWait?.();
    if (this.loopPromise) await this.loopPromise;
  }

  public stop(): void {
    void this.stopAndDrain();
  }

  public invalidateObject(objectType: string, objectId: string): void {
    this.embeddingRepo.deleteVector(objectType, objectId);
    this.db.prepare(`
      INSERT INTO memory_embedding_queue (
        object_type, object_id, operation, generation, enqueued_at
      ) VALUES (?, ?, 'upsert', 1, ?)
      ON CONFLICT(object_type, object_id) DO UPDATE SET
        operation = 'upsert',
        generation = memory_embedding_queue.generation + 1,
        enqueued_at = excluded.enqueued_at
    `).run(objectType, objectId, new Date().toISOString());
    this.wakeIdleWait?.();
  }

  public async indexSingleObject(obj: IndexableObject): Promise<void> {
    const text = constructDocumentText(obj.title, obj.summary, obj.keywords);
    const contentHash = computeContentHash(text);
    const existing = this.embeddingRepo.getVector(obj.objectType, obj.objectId);
    if (
      existing
      && existing.modelVersion === MemoryEmbeddingRepository.CURRENT_MODEL_VERSION
      && existing.contentHash === contentHash
    ) {
      return;
    }

    const vectors = await this.workerClient.embed([text], false);
    if (vectors[0]) {
      this.embeddingRepo.upsertVector(obj.objectType, obj.objectId, vectors[0], contentHash);
    }
  }

  private async indexLoop(): Promise<void> {
    while (!this.shouldStop) {
      const pending = this.readQueuedObjects(this.batchSize);
      if (pending.length === 0) {
        this.ensureBackfillQueue();
        if (this.readQueueCount() === 0) {
          await this.waitForWork();
          continue;
        }
        continue;
      }

      const texts = pending.map((item) =>
        constructDocumentText(item.title, item.summary, item.keywords)
      );
      const hashes = texts.map((text) => computeContentHash(text));

      try {
        const vectors = await this.workerClient.embed(texts, false);
        for (let index = 0; index < pending.length; index++) {
          const item = pending[index];
          const vector = vectors[index];
          if (!vector || !this.isCurrentGeneration(item)) continue;

          // All statements below are synchronous. No source UPDATE can interleave
          // between the generation check, vector write and queue acknowledgement.
          this.embeddingRepo.upsertVector(
            item.objectType,
            item.objectId,
            vector,
            hashes[index]
          );
          this.db.prepare(`
            DELETE FROM memory_embedding_queue
            WHERE object_type = ? AND object_id = ? AND generation = ?
          `).run(item.objectType, item.objectId, item.generation);
        }
      } catch (error) {
        if (!this.shouldStop) {
          console.warn("[EmbeddingIndexer] Batch embedding failed; queued work will retry:", error);
          await this.waitForWork();
        }
      }

      if (!this.shouldStop) {
        await new Promise((resolve) => setTimeout(resolve, this.yieldDelayMs));
      }
    }
  }

  private readQueuedObjects(limit: number): QueuedObject[] {
    const queueRows = this.db.prepare(`
      SELECT object_type, object_id, generation
      FROM memory_embedding_queue
      WHERE operation = 'upsert'
      ORDER BY enqueued_at, object_type, object_id
      LIMIT ?
    `).all(limit) as QueueRow[];

    const result: QueuedObject[] = [];
    for (const row of queueRows) {
      const source = INDEXABLE_SOURCES.find((item) => item.type === row.object_type);
      if (!source) {
        this.acknowledgeMissing(row);
        continue;
      }

      const object = this.db.prepare(`
        SELECT id, ${source.title} AS title, ${source.summary} AS summary
        FROM ${source.table}
        WHERE id = ? AND ${source.active}
      `).get(row.object_id) as { id: string; title: string | null; summary: string | null } | undefined;

      if (!object) {
        this.acknowledgeMissing(row);
        continue;
      }

      result.push({
        objectType: row.object_type,
        objectId: row.object_id,
        generation: row.generation,
        title: object.title ?? "",
        summary: object.summary ?? "",
      });
    }
    return result;
  }

  private acknowledgeMissing(row: QueueRow): void {
    this.embeddingRepo.deleteVector(row.object_type, row.object_id);
    this.db.prepare(`
      DELETE FROM memory_embedding_queue
      WHERE object_type = ? AND object_id = ? AND generation = ?
    `).run(row.object_type, row.object_id, row.generation);
  }

  private isCurrentGeneration(item: QueuedObject): boolean {
    const row = this.db.prepare(`
      SELECT generation
      FROM memory_embedding_queue
      WHERE object_type = ? AND object_id = ? AND operation = 'upsert'
    `).get(item.objectType, item.objectId) as { generation: number } | undefined;
    return row?.generation === item.generation;
  }

  private ensureBackfillQueue(): void {
    const now = new Date().toISOString();
    for (const source of INDEXABLE_SOURCES) {
      this.db.prepare(`
        INSERT INTO memory_embedding_queue (
          object_type, object_id, operation, generation, enqueued_at
        )
        SELECT ?, source.id, 'upsert', 1, COALESCE(source.updated_at, ?)
        FROM ${source.table} AS source
        WHERE ${source.active}
          AND NOT EXISTS (
            SELECT 1
            FROM memory_embeddings AS embedding
            WHERE embedding.object_type = ?
              AND embedding.object_id = source.id
              AND embedding.model_version = ?
          )
        ON CONFLICT(object_type, object_id) DO NOTHING
      `).run(
        source.type,
        now,
        source.type,
        MemoryEmbeddingRepository.CURRENT_MODEL_VERSION
      );
    }
  }

  private readQueueCount(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM memory_embedding_queue"
    ).get() as { count: number };
    return row.count;
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeIdleWait === finish) this.wakeIdleWait = null;
        resolve();
      };
      const timer = setTimeout(finish, this.idlePollMs);
      this.wakeIdleWait = finish;
    });
  }
}
