import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface EmbeddingWorkerResponse {
  id: string;
  available: boolean;
  errorCode?: string;
  dimension?: number;
  vectors?: number[][];
}

type SpawnProcess = typeof spawn;

interface PendingRequest {
  resolve: (res: EmbeddingWorkerResponse) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  generation: number;
}

export class EmbeddingWorkerClient {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private reqCounter = 0;
  private childGeneration = 0;
  private isClosed = false;

  constructor(
    private readonly workerPath?: string,
    private readonly spawnProcess: SpawnProcess = spawn
  ) {}

  public async embed(texts: string[], isQuery = false, timeoutMs = 10000): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (this.isClosed) throw new Error("Embedding worker is closed");

    if (texts.length > 32) {
      const allVectors: number[][] = [];
      for (let i = 0; i < texts.length; i += 32) {
        const chunk = texts.slice(i, i + 32);
        const chunkVectors = await this.embed(chunk, isQuery, timeoutMs);
        allVectors.push(...chunkVectors);
      }
      return allVectors;
    }

    this.ensureProcess();
    if (!this.child || !this.child.stdin) {
      throw new Error("Embedding worker process not available");
    }
    const child = this.child;
    const generation = this.childGeneration;

    const reqId = `emb-${++this.reqCounter}-${Date.now()}`;
    const payload = {
      id: reqId,
      type: isQuery ? "query" : "document",
      texts,
    };

    return new Promise<number[][]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        // 超时后只终止承载本请求的那一代进程。旧进程稍后触发的
        // error/exit 不能影响已经重建的新进程和新请求。
        if (this.child === child) {
          try {
            child.kill();
          } catch {
            // ignore
          }
          this.child = null;
        }
        this.rejectGeneration(
          generation,
          new Error(`Embedding worker generation ${generation} timed out`)
        );
        reject(new Error(`Embedding worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: (res) => {
          if (res.available && Array.isArray(res.vectors)) {
            resolve(res.vectors);
          } else {
            reject(new Error(res.errorCode || "Embedding failed"));
          }
        },
        reject,
        timeout,
        generation,
      });

      try {
        child.stdin!.write(JSON.stringify(payload) + "\n");
      } catch (err) {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public close(): void {
    this.isClosed = true;
    for (const [, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Embedding worker process closed"));
    }
    this.pendingRequests.clear();

    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = null;
    }
  }

  private ensureProcess(): void {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return;
    }

    const resolved = this.resolveWorkerExecutable();
    const child = this.spawnProcess(resolved.cmd, resolved.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        EMBEDDING_MODEL_DIR: resolved.modelDir,
      },
    });

    this.child = child;
    const generation = ++this.childGeneration;

    const rlOut = readline.createInterface({ input: child.stdout! });
    rlOut.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const res = JSON.parse(line) as EmbeddingWorkerResponse;
        if (res && res.id) {
          const pending = this.pendingRequests.get(res.id);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(res.id);
            pending.resolve(res);
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    });

    const rlErr = readline.createInterface({ input: child.stderr! });
    rlErr.on("line", (line) => {
      if (line.trim()) {
        console.warn(`[EmbeddingWorker STDERR] ${line}`);
      }
    });

    child.on("error", (err) => {
      console.error("[EmbeddingWorker Process Error]", err);
      if (this.child === child) this.child = null;
      this.rejectGeneration(generation, err);
    });

    child.on("exit", (code, signal) => {
      console.warn(`[EmbeddingWorker Process Exited] code=${code}, signal=${signal}`);
      if (this.child === child) this.child = null;
      this.rejectGeneration(
        generation,
        new Error(`Worker process exited unexpectedly (code=${code})`)
      );
    });
  }

  private rejectGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private resolveWorkerExecutable(): { cmd: string; args: string[]; modelDir: string } {
    const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
    const repoRoot = process.cwd();

    let modelDir = path.join(repoRoot, "resources", "embedding", "bge-small-zh-v1.5");
    if (resourcesPath && fs.existsSync(path.join(resourcesPath, "embedding", "bge-small-zh-v1.5"))) {
      modelDir = path.join(resourcesPath, "embedding", "bge-small-zh-v1.5");
    }

    if (this.workerPath && fs.existsSync(this.workerPath)) {
      const args = this.workerPath.endsWith(".exe")
        ? ["--mode", "embedding", "--model-dir", modelDir]
        : [this.workerPath, "--mode", "embedding", "--model-dir", modelDir];
      const cmd = this.workerPath.endsWith(".exe") ? this.workerPath : "python";
      return { cmd, args, modelDir };
    }

    // 检查打包态进程可执行文件 (process.resourcesPath)
    if (resourcesPath) {
      const packagedExe = path.join(
        resourcesPath,
        "ocr",
        "rapidocr-worker",
        "rapidocr-worker.exe"
      );
      if (fs.existsSync(packagedExe)) {
        return {
          cmd: packagedExe,
          args: ["--mode", "embedding", "--model-dir", modelDir],
          modelDir,
        };
      }
    }

    // 本地开发态构建出的 rapidocr-worker.exe
    const builtExe = path.join(repoRoot, "resources", "ocr", "rapidocr-worker", "rapidocr-worker.exe");
    if (fs.existsSync(builtExe)) {
      return {
        cmd: builtExe,
        args: ["--mode", "embedding", "--model-dir", modelDir],
        modelDir,
      };
    }

    // 本地源码 Python 脚本
    const pyWorker = path.join(repoRoot, "resources", "ocr", "rapidocr_worker.py");
    return {
      cmd: "python",
      args: [pyWorker, "--mode", "embedding", "--model-dir", modelDir],
      modelDir,
    };
  }
}
