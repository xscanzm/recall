import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BatchProcessorStatus } from "./BatchProcessor";
import type { CaptureBatcherStatus } from "./CaptureBatcher";
import type { QueueStatus } from "./ModelJobQueue";
import { logger } from "./Logger";

const execFileAsync = promisify(execFile);

export interface ResourceMonitorDependencies {
  captureBatcher: { getStatus: () => CaptureBatcherStatus };
  batchProcessor: { getStatus: () => BatchProcessorStatus };
  modelJobQueue: { getStatus: () => QueueStatus };
  embeddingIndexerService?: { getStatus: () => { running: boolean; queued: number; batchSize: number } };
  ocrService?: { getPid?: () => number | null; getPendingRequestCount?: () => number };
  embeddingWorkerClient?: { getPid?: () => number | null; getPendingRequestCount?: () => number };
}

export interface ResourceMonitorConfig {
  intervalMs?: number;
  queueGrowthThreshold?: number;
}

export interface ResourceMonitorSnapshot {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  cpuPercent: number;
  capturePending: number;
  batchPending: number;
  batchActive: number;
  modelPending: number;
  modelRunning: number;
  embeddingPending: number;
  ocrWorkerPrivateBytes: number | null;
  embeddingWorkerPrivateBytes: number | null;
}

export class ResourceMonitor {
  private readonly intervalMs: number;
  private readonly queueGrowthThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private collecting = false;
  private previousCpu = process.cpuUsage();
  private previousSampleAt = Date.now();
  private previousQueueSize: number | null = null;
  private queueGrowthStreak = 0;
  private queueGrowthAlerted = false;
  private overdueAlerted = false;

  constructor(
    private readonly deps: ResourceMonitorDependencies,
    config: ResourceMonitorConfig = {}
  ) {
    this.intervalMs = Math.max(10_000, Math.floor(config.intervalMs ?? 60_000));
    this.queueGrowthThreshold = Math.max(2, Math.floor(config.queueGrowthThreshold ?? 3));
  }

  start(): void {
    if (this.timer) return;
    void this.collect();
    this.timer = setInterval(() => {
      void this.collect();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async collect(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const batch = this.deps.batchProcessor.getStatus();
      const model = this.deps.modelJobQueue.getStatus();
      const capture = this.deps.captureBatcher.getStatus();
      const embedding = this.deps.embeddingIndexerService?.getStatus() ?? {
        running: false,
        queued: 0,
        batchSize: 0,
      };
      const memory = process.memoryUsage();
      const workerMemory = await Promise.all([
        readPrivateMemoryBytes(this.deps.ocrService?.getPid?.() ?? null),
        readPrivateMemoryBytes(this.deps.embeddingWorkerClient?.getPid?.() ?? null),
      ]);
      const snapshot: ResourceMonitorSnapshot = {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        cpuPercent: this.readCpuPercent(),
        capturePending: capture.pending,
        batchPending: batch.pending,
        batchActive: batch.active,
        modelPending: model.pending,
        modelRunning: model.running,
        embeddingPending: embedding.queued,
        ocrWorkerPrivateBytes: workerMemory[0],
        embeddingWorkerPrivateBytes: workerMemory[1],
      };
      this.checkAlerts(snapshot, batch.overdueActive);
      logger.info({
        jobType: "resource_monitor",
        status: "succeeded",
        message: JSON.stringify({
          ...snapshot,
          batchRetries: batch.retries,
          modelRetries: model.retries,
          ocrWorkerPending: this.deps.ocrService?.getPendingRequestCount?.() ?? 0,
          embeddingWorkerPending: this.deps.embeddingWorkerClient?.getPendingRequestCount?.() ?? 0,
        }),
      });
    } catch (error) {
      logger.warn({
        jobType: "resource_monitor",
        status: "failed",
        errorCode: "resource_sample_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.collecting = false;
    }
  }

  private readCpuPercent(): number {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.previousSampleAt);
    const usage = process.cpuUsage(this.previousCpu);
    this.previousCpu = process.cpuUsage();
    this.previousSampleAt = now;
    return Number((((usage.user + usage.system) / 1000 / elapsedMs) * 100).toFixed(1));
  }

  private checkAlerts(snapshot: ResourceMonitorSnapshot, overdueActive: number): void {
    const queueSize = snapshot.capturePending + snapshot.batchPending + snapshot.modelPending;
    if (this.previousQueueSize !== null && queueSize > this.previousQueueSize) {
      this.queueGrowthStreak += 1;
    } else {
      this.queueGrowthStreak = 0;
      this.queueGrowthAlerted = false;
    }
    this.previousQueueSize = queueSize;

    if (this.queueGrowthStreak >= this.queueGrowthThreshold && !this.queueGrowthAlerted) {
      this.queueGrowthAlerted = true;
      logger.warn({
        jobType: "resource_monitor",
        status: "failed",
        errorCode: "queue_growth",
        message: `队列连续 ${this.queueGrowthStreak} 个采样周期增长 (capture=${snapshot.capturePending}, batch=${snapshot.batchPending}, model=${snapshot.modelPending})`,
      });
    }

    if (overdueActive > 0 && !this.overdueAlerted) {
      this.overdueAlerted = true;
      logger.warn({
        jobType: "resource_monitor",
        status: "failed",
        errorCode: "batch_processing_timeout",
        message: `存在 ${overdueActive} 个批次处理超过告警阈值`,
      });
    } else if (overdueActive === 0) {
      this.overdueAlerted = false;
    }
  }
}

async function readPrivateMemoryBytes(pid: number | null): Promise<number | null> {
  if (!pid || process.platform !== "win32") return null;
  const command = `(Get-Process -Id ${Math.floor(pid)} -ErrorAction SilentlyContinue).PrivateMemorySize64`;
  try {
    const result = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ], { windowsHide: true, timeout: 3_000, maxBuffer: 32 * 1024 });
    const value = Number(String(result.stdout).trim());
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
