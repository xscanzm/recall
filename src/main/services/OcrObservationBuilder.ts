// src/main/services/OcrObservationBuilder.ts
// 视觉链路降级观察构造器：本地 OCR + 窗口元数据 → ObserverOutputV2[]
//
// 必须与模型路径共用 buildObserverBatchFramePlan / expandObserverObservations：
// exact_reuse 复用帧不单独构造，扩展自源帧 observation，保证与视觉路径帧语义一致。
// 产物只流入现有 ObservationNormalizer.normalize() 管道（含 attachLocalOcrEvidence）。

import type { BatchCaptureBundle, CaptureBundle, ObserverOutputV2 } from "../models/types";
import {
  buildObserverBatchFramePlan,
  expandObserverObservations,
} from "./ObserverBatchFrames";

export const OCR_FALLBACK_GENERATION_PATH = "ocr_fallback:v1";
export const VISION_MODEL_GENERATION_PATH = "vision_model:v1";

const SCENE_SUMMARY_MAX_CHARS = 400;
const FULL_TEXT_MAX_CHARS = 20_000;

export interface OcrFallbackBuildResult {
  observations: ObserverOutputV2[];
  /** OCR 文本为空的帧数（仍生成仅含窗口标题的观察，置信度更低） */
  emptyOcrFrames: number;
}

export function buildOcrFallbackObservations(
  batchBundle: BatchCaptureBundle
): OcrFallbackBuildResult {
  const plan = buildObserverBatchFramePlan(batchBundle);
  let emptyOcrFrames = 0;
  const submitted = plan.submittedFrames.map((submittedFrame, submittedIndex) => {
    const bundleFrame = batchBundle.frames[submittedFrame.originalFrameIndex];
    const ocr = batchBundle.ocrResults?.[submittedFrame.originalFrameIndex];
    const ocrText = (ocr?.text ?? "").trim();
    if (!ocrText) emptyOcrFrames += 1;
    return buildFrameObservation(bundleFrame, ocrText, submittedIndex + 1);
  });
  return {
    observations: expandObserverObservations(submitted, plan),
    emptyOcrFrames,
  };
}

function buildFrameObservation(
  bundleFrame: CaptureBundle,
  ocrText: string,
  frameIndex: number
): ObserverOutputV2 {
  const windowTitle = (bundleFrame.windowTitle ?? "").trim();
  const appName = (bundleFrame.appName ?? "").trim();
  const title = windowTitle || appName || "未知窗口";
  const ocrLines = ocrText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    frameIndex,
    sceneSummary: truncate([title, ...ocrLines.slice(0, 3)].join(" · "), SCENE_SUMMARY_MAX_CHARS),
    userFacingSummary: truncate(title, 200),
    likelyWorkPurpose: "",
    visibleContent: [
      {
        type: "unknown",
        summary: truncate(windowTitle, 200),
        fullText: truncate(ocrText, FULL_TEXT_MAX_CHARS),
        keyTextSnippets: ocrLines.slice(0, 5).map((line) => truncate(line, 120)),
      },
    ],
    detectedEntities: [],
    possibleUserIntent: "",
    possibleTasks: [],
    possibleDecisions: [],
    possibleProjectProgress: [],
    privacyRisk: "medium",
    privacyRiskReason: "降级模式（本地 OCR）无法进行视觉隐私评估",
    reportableSignal: "maybe",
    reportableReason: "降级模式由本地 OCR 生成，仅含屏幕文字与窗口元数据",
    sensitivity: "normal",
    confidence: ocrText ? 0.35 : 0.15,
    uncertainties: ["视觉链路降级：观察由本地 OCR + 窗口元数据生成，无场景语义理解"],
  };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen);
}
