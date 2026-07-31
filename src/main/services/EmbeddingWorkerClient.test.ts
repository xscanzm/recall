import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddingWorkerClient } from "./EmbeddingWorkerClient";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString());
      callback();
    },
  });
  killed = false;
  exitCode: number | null = null;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  respond(vectors: number[][]): void {
    const request = JSON.parse(this.writes.at(-1) ?? "{}") as { id?: string };
    this.stdout.write(`${JSON.stringify({
      id: request.id,
      available: true,
      vectors,
    })}\n`);
  }
}

const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalResourcesPath) {
    Object.defineProperty(process, "resourcesPath", originalResourcesPath);
  } else {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  }
});

describe("EmbeddingWorkerClient", () => {
  it("resolves the packaged worker directly below process.resourcesPath/ocr", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recall-embedding-client-"));
    const exeName = process.platform === "win32" ? "rapidocr-worker.exe" : "rapidocr-worker";
    const worker = path.join(root, "ocr", "rapidocr-worker", exeName);
    const model = path.join(root, "embedding", "bge-small-zh-v1.5");
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.mkdirSync(model, { recursive: true });
    fs.writeFileSync(worker, "test");
    Object.defineProperty(process, "resourcesPath", { configurable: true, value: root });

    const resolved = (new EmbeddingWorkerClient() as unknown as {
      resolveWorkerExecutable(): { cmd: string; args: string[]; modelDir: string };
    }).resolveWorkerExecutable();

    expect(resolved.cmd).toBe(worker);
    expect(resolved.modelDir).toBe(model);
    expect(resolved.args).toEqual(["--mode", "embedding", "--model-dir", model]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not let an old child exit clear requests owned by a newer generation", async () => {
    vi.useFakeTimers();
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    const client = new EmbeddingWorkerClient("C:\\worker.exe", spawnProcess);
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const first = client.embed(["first"], false, 10);
    const firstRejection = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await firstRejection;

    const second = client.embed(["second"], false, 1_000);
    expect(children).toHaveLength(2);
    children[0].emit("exit", 1, null);
    children[0].emit("error", new Error("late old-process error"));
    children[1].respond([[0.25, 0.75]]);

    await expect(second).resolves.toEqual([[0.25, 0.75]]);
    client.close();
  });
});
