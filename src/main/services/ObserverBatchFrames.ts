import type { BatchCaptureBundle, ObserverOutputV2 } from "../models/types";

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
      : undefined;
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
