import type { BatchFrameOcrResult, OcrTextBlock } from "../models/types";

interface PromptOcrFrame {
  frameIndex: number;
  source: "windows_ocr_original_image";
  available: boolean;
  language?: string;
  mode?: "full" | "exact_reuse" | "delta";
  text?: string;
  blocks?: PromptOcrBlock[];
  reuseFromFrameIndex?: number;
  baseFrameIndex?: number;
  unchangedBlockCount?: number;
  addedBlocks?: PromptOcrBlock[];
  changedBlocks?: Array<{ previousBlockId: string; block: PromptOcrBlock }>;
  removedBlocks?: Array<{ id: string; text: string; boundingBox: OcrTextBlock["boundingBox"] }>;
}

interface PromptOcrBlock {
  id: string;
  text: string;
  boundingBox: OcrTextBlock["boundingBox"];
  words: OcrTextBlock["words"];
  confidence?: number;
}

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
  const frames: PromptOcrFrame[] = originalFrameIndices.map((originalIndex, modelIndex) => {
    const result = byOriginalFrame.get(originalIndex + 1);
    const base = {
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
        return {
          ...base,
          mode: "delta",
          baseFrameIndex,
          unchangedBlockCount: result.delta.unchangedBlockIds.length,
          addedBlocks: result.delta.addedBlocks.map(toPromptBlock),
          changedBlocks: result.delta.changedBlocks.map((change) => ({
            previousBlockId: change.previousBlockId,
            block: toPromptBlock(change.block),
          })),
          removedBlocks: result.delta.removedBlocks.map((block) => ({
            id: block.id,
            text: block.text,
            boundingBox: block.boundingBox,
          })),
        };
      }
    }

    return {
      ...base,
      mode: "full",
      text: preferredOcrText(result),
      blocks: result.blocks.map(toPromptBlock),
    };
  });
  return JSON.stringify(frames, null, 2);
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
  return {
    id: block.id,
    text: block.text,
    boundingBox: block.boundingBox,
    words: block.words,
    confidence: block.confidence,
  };
}

function preferredOcrText(result: BatchFrameOcrResult): string {
  const lines = result.lines.map((line) => line.trimEnd()).filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : result.text;
}
