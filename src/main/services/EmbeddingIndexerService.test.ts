import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingIndexerService } from "./EmbeddingIndexerService";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("EmbeddingIndexerService resource controls", () => {
  it("closes an idle embedding worker after the configured idle period", async () => {
    vi.useFakeTimers();
    const workerClient = {
      closeIfIdle: vi.fn(),
      embed: vi.fn(),
    };
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("COUNT(*) AS count")) {
          return { get: () => ({ count: 0 }) };
        }
        if (sql.includes("SELECT object_type, object_id, generation")) {
          return { all: () => [] };
        }
        return { run: vi.fn() };
      }),
    };
    const service = new EmbeddingIndexerService(
      db as never,
      {} as never,
      workerClient as never,
      { idlePollMs: 250, idleWorkerMs: 1_000 }
    );

    service.startBackgroundIndexing();
    await vi.advanceTimersByTimeAsync(1_250);

    expect(workerClient.closeIfIdle).toHaveBeenCalledOnce();
    expect(workerClient.embed).not.toHaveBeenCalled();

    await service.stopAndDrain();
  });
});
