import type { BatchCaptureBundle, ObserverOutputV2 } from "../models/types";

const APPROXIMATE_DHASH_DISTANCE = 2;
const PRESERVE_FRAME_REASONS = new Set([
  "manual_capture",
  "scene_boundary",
  "project_switch",
  "window_focus_changed",
  "window_title_changed",
  "daily_preflight",
]);

export interface AvailableObserverFrame {
  imagePath: string;
  originalFrameIndex: number;
  availableFramePosition: number;
}

export interface ObserverBatchFramePlan {
  availableFrames: AvailableObserverFrame[];
  submittedFrames: AvailableObserverFrame[];
  duplicateSourceByOriginalFrameIndex: Map<number, number>;
}

export function buildObserverBatchFramePlan(
  batchBundle: BatchCaptureBundle
): ObserverBatchFramePlan {
  const availableFrames = batchBundle.compressedImagePaths
    .map((imagePath, originalFrameIndex) => ({ imagePath, originalFrameIndex }))
    .filter((item) => item.imagePath.length > 0)
    .map((item, availableFramePosition) => ({ ...item, availableFramePosition }));
  const availableOriginalIndices = new Set(
    availableFrames.map((frame) => frame.originalFrameIndex)
  );
  const duplicateSourceByOriginalFrameIndex = new Map<number, number>();
  const submittedFrames: AvailableObserverFrame[] = [];

  for (const frame of availableFrames) {
    const ocr = batchBundle.ocrResults?.[frame.originalFrameIndex];
    const sourceOriginalIndex = ocr?.mode === "exact_reuse" && ocr.reuseFromFrameIndex
      ? ocr.reuseFromFrameIndex - 1
      : approximateDuplicateSource(batchBundle, frame.originalFrameIndex);
    if (
      sourceOriginalIndex !== undefined
      && sourceOriginalIndex < frame.originalFrameIndex
      && availableOriginalIndices.has(sourceOriginalIndex)
    ) {
      duplicateSourceByOriginalFrameIndex.set(
        frame.originalFrameIndex,
        resolveDuplicateSource(sourceOriginalIndex, duplicateSourceByOriginalFrameIndex)
      );
      continue;
    }
    submittedFrames.push(frame);
  }

  return { availableFrames, submittedFrames, duplicateSourceByOriginalFrameIndex };
}

function approximateDuplicateSource(
  batchBundle: BatchCaptureBundle,
  originalFrameIndex: number
): number | undefined {
  const currentFrame = batchBundle.frames[originalFrameIndex];
  const currentOcr = batchBundle.ocrResults?.[originalFrameIndex];
  if (!currentFrame || !currentOcr || currentOcr.mode !== "delta" || currentOcr.errorCode) return undefined;
  if (PRESERVE_FRAME_REASONS.has(currentFrame.captureReason)) return undefined;
  const sourceIndex = currentOcr.deltaFromFrameIndex
    ? currentOcr.deltaFromFrameIndex - 1
    : undefined;
  if (sourceIndex === undefined || sourceIndex < 0 || sourceIndex >= originalFrameIndex) return undefined;
  const sourceFrame = batchBundle.frames[sourceIndex];
  const sourceOcr = batchBundle.ocrResults?.[sourceIndex];
  if (!sourceFrame || !sourceOcr || sourceOcr.errorCode) return undefined;
  if (sourceFrame.appName !== currentFrame.appName || sourceFrame.windowTitle !== currentFrame.windowTitle) {
    return undefined;
  }
  const delta = currentOcr.delta;
  if (!delta || delta.addedBlocks.length > 0 || delta.changedBlocks.length > 0 || delta.removedBlocks.length > 0) {
    return undefined;
  }
  const sourceHash = sourceOcr.screenSignature?.dHash;
  const currentHash = currentOcr.screenSignature?.dHash;
  if (!sourceHash || !currentHash) return undefined;
  return hammingDistance(sourceHash, currentHash) <= APPROXIMATE_DHASH_DISTANCE
    ? sourceIndex
    : undefined;
}

function hammingDistance(left: string, right: string): number {
  if (left.length !== right.length || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < left.length; index++) {
    let xor = Number.parseInt(left[index], 16) ^ Number.parseInt(right[index], 16);
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

export function expandObserverObservations(
  observations: ObserverOutputV2[],
  plan: ObserverBatchFramePlan
): ObserverOutputV2[] {
  const byOriginalFrameIndex = new Map<number, ObserverOutputV2>();
  for (let index = 0; index < observations.length; index++) {
    const observation = observations[index];
    const submittedPosition = (observation.frameIndex ?? index + 1) - 1;
    const submittedFrame = plan.submittedFrames[submittedPosition];
    if (!submittedFrame) continue;
    byOriginalFrameIndex.set(submittedFrame.originalFrameIndex, {
      ...deepClone(observation),
      frameIndex: submittedFrame.availableFramePosition + 1,
    });
  }

  for (const frame of plan.availableFrames) {
    if (byOriginalFrameIndex.has(frame.originalFrameIndex)) continue;
    const sourceOriginalIndex = plan.duplicateSourceByOriginalFrameIndex.get(
      frame.originalFrameIndex
    );
    const source = sourceOriginalIndex === undefined
      ? undefined
      : byOriginalFrameIndex.get(sourceOriginalIndex);
    if (!source) continue;
    byOriginalFrameIndex.set(frame.originalFrameIndex, {
      ...deepClone(source),
      frameIndex: frame.availableFramePosition + 1,
    });
  }

  return plan.availableFrames.flatMap((frame) => {
    const observation = byOriginalFrameIndex.get(frame.originalFrameIndex);
    return observation ? [observation] : [];
  });
}

function resolveDuplicateSource(
  originalFrameIndex: number,
  duplicates: Map<number, number>
): number {
  let current = originalFrameIndex;
  const visited = new Set<number>();
  while (duplicates.has(current) && !visited.has(current)) {
    visited.add(current);
    current = duplicates.get(current)!;
  }
  return current;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
