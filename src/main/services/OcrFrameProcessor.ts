import { createHash } from "node:crypto";
import * as fs from "node:fs";
import sharp from "sharp";
import type {
  BatchFrameOcrResult,
  CaptureBundle,
  OcrBoundingBox,
  OcrFrameDelta,
  OcrScreenSignature,
  OcrTextBlock,
} from "../models/types";
import type { WindowsOcrBatchResult } from "./WindowsOcrService";

const DEFAULT_MAX_CONTEXTS = 32;
const REGION_SIGNATURE_WIDTH = 128;

type OcrService = {
  recognizeImages(imagePaths: string[]): Promise<WindowsOcrBatchResult>;
};

interface ContextState {
  captureId: string;
  result: BatchFrameOcrResult;
  batchFrameIndex?: number;
}

interface FramePlan {
  signature?: OcrScreenSignature;
  contextKey: string;
  kind: "ocr" | "reuse";
  ocrResultIndex?: number;
  sourceFrameIndex?: number;
  sourceState?: ContextState;
}

export interface PreparedOcrBatch {
  results: BatchFrameOcrResult[];
  /** Commits staged state after the containing batch is durably inserted. */
  commit(): void;
}

export class OcrFrameProcessor {
  private committedContexts = new Map<string, ContextState>();
  private readonly ocrService: OcrService;
  private readonly maxContexts: number;

  constructor(config: { ocrService: OcrService; maxContexts?: number }) {
    this.ocrService = config.ocrService;
    this.maxContexts = Math.max(1, config.maxContexts ?? DEFAULT_MAX_CONTEXTS);
  }

  async prepareBatch(frames: CaptureBundle[]): Promise<PreparedOcrBatch> {
    const signatures = await Promise.all(
      frames.map((frame) => computeScreenSignatureSafe(frame.imagePaths[0]))
    );
    const latestPlanByContext = new Map<string, {
      signature?: OcrScreenSignature;
      frameIndex?: number;
      state?: ContextState;
    }>();
    for (const [key, value] of this.committedContexts) {
      latestPlanByContext.set(key, {
        signature: value.result.screenSignature,
        state: value,
      });
    }

    const plans: FramePlan[] = [];
    const ocrPaths: string[] = [];
    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      const signature = signatures[index];
      const contextKey = buildContextKey(frame);
      const previous = latestPlanByContext.get(contextKey);
      const exactMatch = !!signature
        && !!previous?.signature
        && signature.pixelHash === previous.signature.pixelHash;

      if (exactMatch && (previous?.frameIndex !== undefined || previous?.state)) {
        plans.push({
          signature,
          contextKey,
          kind: "reuse",
          sourceFrameIndex: previous.frameIndex,
          sourceState: previous.state,
        });
      } else {
        plans.push({
          signature,
          contextKey,
          kind: "ocr",
          ocrResultIndex: ocrPaths.length,
        });
        ocrPaths.push(frame.imagePaths[0] ?? "");
      }
      latestPlanByContext.set(contextKey, { signature, frameIndex: index });
    }

    const ocrBatch = ocrPaths.length > 0
      ? await this.ocrService.recognizeImages(ocrPaths)
      : { available: true, frames: [] };
    const stagedContexts = new Map(this.committedContexts);
    const results: BatchFrameOcrResult[] = [];

    for (let index = 0; index < frames.length; index++) {
      const frame = frames[index];
      const plan = plans[index];
      const previousState = stagedContexts.get(plan.contextKey);
      let result: BatchFrameOcrResult;

      if (plan.kind === "reuse") {
        const source = plan.sourceFrameIndex === undefined
          ? plan.sourceState?.result
          : results[plan.sourceFrameIndex];
        result = source
          ? cloneExactReuseResult(source, index + 1, plan)
          : emptyResult(index + 1, "windows_ocr_reuse_source_missing");
      } else {
        const raw = ocrBatch.frames[plan.ocrResultIndex ?? -1]
          ?? emptyResult(index + 1, "windows_ocr_missing_result");
        const blocks = await decorateBlocks(frame.imagePaths[0], raw.blocks ?? []);
        const delta = previousState?.result.blocks
          ? diffBlocks(previousState.result.blocks, blocks)
          : undefined;
        result = {
          ...raw,
          frameIndex: index + 1,
          blocks,
          screenSignature: plan.signature,
          mode: delta ? "delta" : "full",
          deltaFromFrameIndex: delta ? previousState?.batchFrameIndex : undefined,
          delta,
        };
      }

      results.push(result);
      touchContext(stagedContexts, plan.contextKey, {
        captureId: frame.captureId,
        result,
        batchFrameIndex: index + 1,
      });
    }

    return {
      results,
      commit: () => {
        const committed = new Map<string, ContextState>();
        for (const [key, state] of stagedContexts) {
          committed.set(key, { ...state, batchFrameIndex: undefined });
        }
        this.committedContexts = trimContexts(committed, this.maxContexts);
      },
    };
  }

  getCommittedContextCount(): number {
    return this.committedContexts.size;
  }
}

function cloneExactReuseResult(
  source: BatchFrameOcrResult,
  frameIndex: number,
  plan: FramePlan
): BatchFrameOcrResult {
  return {
    ...source,
    frameIndex,
    blocks: source.blocks?.map(cloneBlock),
    screenSignature: plan.signature ?? source.screenSignature,
    mode: "exact_reuse",
    reuseFromFrameIndex: plan.sourceFrameIndex === undefined
      ? undefined
      : plan.sourceFrameIndex + 1,
    reusedFromCaptureId: plan.sourceState?.captureId,
    deltaFromFrameIndex: undefined,
    delta: source.blocks ? {
      unchangedBlockIds: source.blocks.map((block) => block.id),
      addedBlocks: [],
      changedBlocks: [],
      removedBlocks: [],
    } : undefined,
    errorCode: source.errorCode,
  };
}

function emptyResult(frameIndex: number, errorCode: string): BatchFrameOcrResult {
  return { frameIndex, text: "", lines: [], blocks: [], errorCode };
}

async function computeScreenSignatureSafe(
  imagePath: string | undefined
): Promise<OcrScreenSignature | undefined> {
  if (!imagePath || !fs.existsSync(imagePath)) return undefined;
  try {
    const decoded = await sharp(imagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const dHashPixels = await sharp(imagePath)
      .grayscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer();
    return {
      pixelHash: createHash("sha256").update(decoded.data).digest("hex"),
      dHash: computeDHash(dHashPixels),
      width: decoded.info.width,
      height: decoded.info.height,
    };
  } catch {
    return undefined;
  }
}

function computeDHash(pixels: Buffer): string {
  let hash = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash <<= 1n;
      const offset = y * 9 + x;
      if (pixels[offset] > pixels[offset + 1]) hash |= 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

async function decorateBlocks(
  imagePath: string | undefined,
  blocks: OcrTextBlock[]
): Promise<OcrTextBlock[]> {
  const output: OcrTextBlock[] = [];
  for (const block of blocks) {
    const visualHash = imagePath
      ? await computeRegionSignatureSafe(imagePath, block.boundingBox)
      : undefined;
    output.push({
      ...cloneBlock(block),
      id: createBlockId(block),
      visualHash,
    });
  }
  return output;
}

async function computeRegionSignatureSafe(
  imagePath: string,
  box: OcrBoundingBox
): Promise<string | undefined> {
  try {
    const metadata = await sharp(imagePath).metadata();
    if (!metadata.width || !metadata.height) return undefined;
    const left = clamp(Math.floor(box.x), 0, metadata.width - 1);
    const top = clamp(Math.floor(box.y), 0, metadata.height - 1);
    const width = clamp(Math.ceil(box.width), 1, metadata.width - left);
    const height = clamp(Math.ceil(box.height), 1, metadata.height - top);
    const pixels = await sharp(imagePath)
      .extract({ left, top, width, height })
      .grayscale()
      .resize({ width: REGION_SIGNATURE_WIDTH, fit: "inside", withoutEnlargement: false })
      .raw()
      .toBuffer();
    for (let index = 0; index < pixels.length; index++) {
      pixels[index] = pixels[index] >> 4;
    }
    return createHash("sha256").update(pixels).digest("hex");
  } catch {
    return undefined;
  }
}

export function diffBlocks(
  previousBlocks: OcrTextBlock[],
  currentBlocks: OcrTextBlock[]
): OcrFrameDelta {
  const unmatchedPrevious = new Set(previousBlocks.map((_block, index) => index));
  const unchangedBlockIds: string[] = [];
  const addedBlocks: OcrTextBlock[] = [];
  const changedBlocks: OcrFrameDelta["changedBlocks"] = [];

  for (const current of currentBlocks) {
    const sameTextMatch = findBestMatch(previousBlocks, unmatchedPrevious, current, true);
    if (sameTextMatch !== null) {
      const previous = previousBlocks[sameTextMatch];
      current.id = previous.id;
      unchangedBlockIds.push(previous.id);
      unmatchedPrevious.delete(sameTextMatch);
      continue;
    }

    const spatialMatch = findBestMatch(previousBlocks, unmatchedPrevious, current, false);
    if (spatialMatch !== null) {
      const previous = previousBlocks[spatialMatch];
      changedBlocks.push({ previousBlockId: previous.id, block: current });
      unmatchedPrevious.delete(spatialMatch);
      continue;
    }
    addedBlocks.push(current);
  }

  return {
    unchangedBlockIds,
    addedBlocks,
    changedBlocks,
    removedBlocks: Array.from(unmatchedPrevious, (index) => cloneBlock(previousBlocks[index])),
  };
}

function findBestMatch(
  previousBlocks: OcrTextBlock[],
  candidateIndices: Set<number>,
  current: OcrTextBlock,
  requireSameText: boolean
): number | null {
  let bestIndex: number | null = null;
  let bestScore = 0;
  const normalizedCurrent = normalizeText(current.text);
  for (const index of candidateIndices) {
    const previous = previousBlocks[index];
    const sameText = normalizeText(previous.text) === normalizedCurrent;
    if (requireSameText !== sameText && requireSameText) continue;
    const overlap = intersectionOverUnion(previous.boundingBox, current.boundingBox);
    const sameVisualRegion = !!previous.visualHash
      && previous.visualHash === current.visualHash
      && centerDistance(previous.boundingBox, current.boundingBox)
        <= Math.max(16, previous.boundingBox.height * 2, current.boundingBox.height * 2);
    const qualifies = requireSameText
      ? overlap >= 0.5 || sameVisualRegion
      : overlap >= 0.5;
    if (!qualifies) continue;
    const score = overlap + (sameVisualRegion ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function intersectionOverUnion(left: OcrBoundingBox, right: OcrBoundingBox): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  );
  const intersection = intersectionWidth * intersectionHeight;
  if (intersection === 0) return 0;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function centerDistance(left: OcrBoundingBox, right: OcrBoundingBox): number {
  const dx = left.x + left.width / 2 - (right.x + right.width / 2);
  const dy = left.y + left.height / 2 - (right.y + right.height / 2);
  return Math.sqrt(dx * dx + dy * dy);
}

function createBlockId(block: OcrTextBlock): string {
  const box = block.boundingBox;
  const payload = [
    normalizeText(block.text),
    Math.round(box.x / 4),
    Math.round(box.y / 4),
    Math.round(box.width / 4),
    Math.round(box.height / 4),
  ].join(":");
  return `b${createHash("sha256").update(payload).digest("hex").slice(0, 8)}`;
}

function normalizeText(value: string): string {
  return Array.from(value.toLowerCase())
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
}

function cloneBlock(block: OcrTextBlock): OcrTextBlock {
  return {
    ...block,
    boundingBox: { ...block.boundingBox },
    words: block.words.map((word) => ({
      ...word,
      boundingBox: { ...word.boundingBox },
    })),
  };
}

function buildContextKey(frame: CaptureBundle): string {
  return `${frame.appName.trim().toLowerCase()}\u0000${frame.windowTitle.trim().toLowerCase()}`;
}

function touchContext(
  contexts: Map<string, ContextState>,
  key: string,
  state: ContextState
): void {
  contexts.delete(key);
  contexts.set(key, state);
}

function trimContexts(
  contexts: Map<string, ContextState>,
  maxContexts: number
): Map<string, ContextState> {
  const trimmed = new Map(contexts);
  while (trimmed.size > maxContexts) {
    const oldest = trimmed.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    trimmed.delete(oldest);
  }
  return trimmed;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
