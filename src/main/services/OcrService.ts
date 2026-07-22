import type { BatchFrameOcrResult } from "../models/types";

export interface OcrBatchResult {
  available: boolean;
  frames: BatchFrameOcrResult[];
  errorCode?: string;
}

export interface OcrBatchService {
  recognizeImages(imagePaths: string[]): Promise<OcrBatchResult>;
}

export interface ManagedOcrBatchService extends OcrBatchService {
  stop(): Promise<void> | void;
}

export function unavailableOcrBatch(
  frameCount: number,
  errorCode: string,
  engine?: string
): OcrBatchResult {
  return {
    available: false,
    errorCode,
    frames: Array.from({ length: frameCount }, (_, index) => ({
      frameIndex: index + 1,
      text: "",
      lines: [],
      blocks: [],
      engine,
      errorCode,
    })),
  };
}
