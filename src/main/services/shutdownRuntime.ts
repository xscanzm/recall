import { logger } from "./Logger";

export interface ShutdownDependencies {
  reportScheduler?: { stop: () => void } | null;
  timelineWindowCoordinator?: {
    stop: () => void;
    persistTailForShutdown: () => Promise<void>;
  } | null;
  stopScreenshotCacheScheduler?: (() => void) | null;
  stopUpdateCheckerScheduler?: (() => void) | null;
  updateService?: { cleanupIncompleteDownloads: () => void } | null;
  activityService?: { stop: () => void } | null;
  captureService?: { stop: () => void; drain: () => Promise<void> } | null;
  endOfDayReviewService?: { stop: () => void } | null;
  modelJobRetentionService?: { stop: () => void } | null;
  sceneScheduler?: { stop: () => void } | null;
  captureBatcher?: { drain: () => Promise<void> } | null;
  ocrService?: { stop: () => Promise<void> | void } | null;
  embeddingIndexerService?: { stopAndDrain: () => Promise<void> } | null;
  embeddingWorkerClient?: { close: () => void } | null;
  batchProcessor?: { stopAndDrainActive: () => Promise<void> } | null;
  modelJobQueue?: { stopAndDrainActive: (timeoutMs?: number) => Promise<void> } | null;
  trayService?: { destroy: () => void } | null;
  closeDatabase?: (() => void) | null;
  exitApp?: (() => void) | null;
}

let shutdownPromise: Promise<void> | null = null;

export function shutdownRuntime(
  deps: ShutdownDependencies,
  // Streaming jobs have a 10-minute hard ceiling in ModelGateway.
  modelQueueTimeoutMs: number = 11 * 60_000
): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = performShutdown(deps, modelQueueTimeoutMs);
  return shutdownPromise;
}

async function performShutdown(
  deps: ShutdownDependencies,
  modelQueueTimeoutMs: number
): Promise<void> {
  logger.info({ message: "Starting graceful shutdown of Recall runtime" });

  await runBestEffort("stopReportScheduler", () => deps.reportScheduler?.stop());
  await runBestEffort("stopTimelineWindowCoordinator", () => deps.timelineWindowCoordinator?.stop());
  await runBestEffort("stopScreenshotCacheScheduler", () => deps.stopScreenshotCacheScheduler?.());
  await runBestEffort("stopUpdateCheckerScheduler", () => deps.stopUpdateCheckerScheduler?.());
  await runBestEffort("cleanupUpdateDownloads", () => deps.updateService?.cleanupIncompleteDownloads());
  await runBestEffort("stopSceneScheduler", () => deps.sceneScheduler?.stop());
  await runBestEffort("stopEndOfDayReviewService", () => deps.endOfDayReviewService?.stop());
  await runBestEffort("stopModelJobRetentionService", () => deps.modelJobRetentionService?.stop());

  const criticalErrors: Error[] = [];
  await runCritical("stopActivityService", () => deps.activityService?.stop(), criticalErrors);
  await runCritical("stopCaptureService", () => deps.captureService?.stop(), criticalErrors);
  await runCritical("drainCaptureService", () => deps.captureService?.drain(), criticalErrors);
  await runCritical("drainCaptureBatcher", () => deps.captureBatcher?.drain(), criticalErrors);
  await runCritical(
    "persistTimelineTail",
    () => deps.timelineWindowCoordinator?.persistTailForShutdown(),
    criticalErrors
  );
  await runCritical("stopOcrService", () => deps.ocrService?.stop(), criticalErrors);
  await runCritical("stopEmbeddingIndexerService", () => deps.embeddingIndexerService?.stopAndDrain(), criticalErrors);
  await runBestEffort("closeEmbeddingWorkerClient", () => deps.embeddingWorkerClient?.close());
  await runCritical("drainBatchProcessor", () => deps.batchProcessor?.stopAndDrainActive(), criticalErrors);
  await runCritical(
    "drainModelJobQueue",
    () => deps.modelJobQueue?.stopAndDrainActive(modelQueueTimeoutMs),
    criticalErrors
  );

  await runBestEffort("destroyTrayService", () => deps.trayService?.destroy());

  if (criticalErrors.length > 0) {
    throw new AggregateError(criticalErrors, "Recall runtime did not drain cleanly");
  }

  deps.closeDatabase?.();
  deps.exitApp?.();
}

async function runBestEffort(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logShutdownError(name, error);
  }
}

async function runCritical(
  name: string,
  fn: () => void | Promise<void>,
  errors: Error[]
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    errors.push(normalized);
    logShutdownError(name, normalized);
  }
}

function logShutdownError(name: string, error: unknown): void {
  logger.error({
    status: "failed",
    errorCode: "shutdown_step_failed",
    message: `Shutdown step [${name}] failed: ${error instanceof Error ? error.message : String(error)}`,
  });
}

export function resetShutdownStateForTests(): void {
  shutdownPromise = null;
}
