import type { BatchFrameOcrResult, OcrTextBlock } from "../models/types";

interface PromptOcrFrame {
  frameIndex: number;
  source: "windows_ocr_original_image";
  available: boolean;
  language?: string;
  mode?: "full" | "full_text" | "exact_reuse" | "delta";
  text?: string;
  blocks?: PromptOcrBlock[];
  reuseFromFrameIndex?: number;
  baseFrameIndex?: number;
  unchangedBlockCount?: number;
  addedBlocks?: PromptOcrBlock[];
  changedBlocks?: Array<[string, PromptOcrBlock]>;
  removedBlockIds?: string[];
}

type PromptOcrBlock = [
  id: string,
  text: string,
  confidence?: number,
];

/**
 * Remaps OCR results from original batch indexes to the contiguous image order
 * seen by the model after failed JPEG frames have been filtered out.
 */
export function buildBatchOcrEvidenceJson(
  ocrResults: BatchFrameOcrResult[] | undefined,
  originalFrameIndices: number[]
): string {
  const byOriginalFrame = new Map(
    (ocrResults ?? []).map((result) => [result.frameIndex, result])
  );
  const originalToModelFrame = new Map(
    originalFrameIndices.map((originalIndex, modelIndex) => [originalIndex + 1, modelIndex + 1])
  );
  const referencedModelFrames = new Set<number>();
  for (const originalIndex of originalFrameIndices) {
    const result = byOriginalFrame.get(originalIndex + 1);
    const sourceOriginalFrame = result?.deltaFromFrameIndex ?? result?.reuseFromFrameIndex;
    if (!sourceOriginalFrame) continue;
    const sourceModelFrame = resolveModelFrameIndex(
      sourceOriginalFrame,
      byOriginalFrame,
      originalToModelFrame
    );
    if (sourceModelFrame) referencedModelFrames.add(sourceModelFrame);
  }
  const frames: PromptOcrFrame[] = originalFrameIndices.map((originalIndex, modelIndex) => {
    const result = byOriginalFrame.get(originalIndex + 1);
    const base: PromptOcrFrame = {
      frameIndex: modelIndex + 1,
      source: "windows_ocr_original_image",
      available: !!result && !result.errorCode,
      language: result?.language,
    };
    if (!result) return { ...base, text: "" };
    if (!result.blocks || !result.mode) {
      return { ...base, text: preferredOcrText(result) };
    }

    if (result.mode === "exact_reuse" && result.reuseFromFrameIndex) {
      const reuseFromFrameIndex = resolveModelFrameIndex(
        result.reuseFromFrameIndex,
        byOriginalFrame,
        originalToModelFrame
      );
      if (reuseFromFrameIndex) {
        return { ...base, mode: "exact_reuse", reuseFromFrameIndex };
      }
    }

    if (result.mode === "delta" && result.delta && result.deltaFromFrameIndex) {
      const baseFrameIndex = resolveModelFrameIndex(
        result.deltaFromFrameIndex,
        byOriginalFrame,
        originalToModelFrame
      );
      if (baseFrameIndex) {
        const deltaFrame: PromptOcrFrame = {
          ...base,
          mode: "delta",
          baseFrameIndex,
          unchangedBlockCount: result.delta.unchangedBlockIds.length,
          addedBlocks: result.delta.addedBlocks.map(toPromptBlock),
          changedBlocks: result.delta.changedBlocks.map((change) => [
            change.previousBlockId,
            toPromptBlock(change.block),
          ]),
          removedBlockIds: result.delta.removedBlocks.map((block) => block.id),
        };
        const fullFrame: PromptOcrFrame = {
          ...base,
          mode: "full",
          blocks: result.blocks.map(toPromptBlock),
        };
        const candidates = [deltaFrame, fullFrame];
        if (!referencedModelFrames.has(modelIndex + 1)) {
          candidates.push(toFullTextFrame(base, result));
        }
        return smallestFrame(candidates);
      }
    }

    const fullFrame: PromptOcrFrame = {
      ...base,
      mode: "full",
      blocks: result.blocks.map(toPromptBlock),
    };
    return referencedModelFrames.has(modelIndex + 1)
      ? fullFrame
      : smallestFrame([fullFrame, toFullTextFrame(base, result)]);
  });
  const actuallyReferencedFrames = new Set<number>();
  for (const frame of frames) {
    if (frame.mode === "delta" && frame.baseFrameIndex) {
      actuallyReferencedFrames.add(frame.baseFrameIndex);
    }
    if (frame.mode === "exact_reuse" && frame.reuseFromFrameIndex) {
      actuallyReferencedFrames.add(frame.reuseFromFrameIndex);
    }
  }
  const optimizedFrames = frames.map((frame, modelIndex) => {
    if (frame.mode !== "full" || actuallyReferencedFrames.has(modelIndex + 1)) {
      return frame;
    }
    const result = byOriginalFrame.get(originalFrameIndices[modelIndex] + 1);
    return result
      ? smallestFrame([frame, toFullTextFrame({
          frameIndex: frame.frameIndex,
          source: frame.source,
          available: frame.available,
          language: frame.language,
        }, result)])
      : frame;
  });
  return JSON.stringify(optimizedFrames);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function smallestFrame(frames: PromptOcrFrame[]): PromptOcrFrame {
  return frames.reduce((smallest, candidate) =>
    serializedBytes(candidate) < serializedBytes(smallest) ? candidate : smallest
  );
}

function toFullTextFrame(
  base: PromptOcrFrame,
  result: BatchFrameOcrResult
): PromptOcrFrame {
  return { ...base, mode: "full_text", text: preferredOcrText(result) };
}

function resolveModelFrameIndex(
  originalFrameIndex: number,
  byOriginalFrame: Map<number, BatchFrameOcrResult>,
  originalToModelFrame: Map<number, number>
): number | undefined {
  let current = originalFrameIndex;
  const visited = new Set<number>();
  while (!originalToModelFrame.has(current) && !visited.has(current)) {
    visited.add(current);
    const result = byOriginalFrame.get(current);
    if (result?.mode !== "exact_reuse" || !result.reuseFromFrameIndex) break;
    current = result.reuseFromFrameIndex;
  }
  return originalToModelFrame.get(current);
}

function toPromptBlock(block: OcrTextBlock): PromptOcrBlock {
  const tuple: PromptOcrBlock = [
    block.id,
    block.text,
  ];
  if (block.confidence !== undefined) tuple.push(block.confidence);
  return tuple;
}

function preferredOcrText(result: BatchFrameOcrResult): string {
  const lines = result.lines.map((line) => line.trimEnd()).filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : result.text;
}
