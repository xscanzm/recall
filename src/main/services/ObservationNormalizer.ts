// src/main/services/ObservationNormalizer.ts
// Observation Normalizer（来自 03 文档）
//
// 职责：
// - 给 observation 生成 ID
// - 附加 capture metadata
// - 附加截图保留状态
// - 校验 JSON schema
// - 清洗过长字段（按长度限制截断 + 记录 warning）
// - 如果 sensitivity 为 high_sensitive，按隐私规则决定是否丢弃
// - 写入 observations 表
//
// 重要：Normalizer 不应该修改模型的语义判断，只做格式、长度、状态和安全处理
//
// 文本长度限制（来自 05 文档）：
// - title: 120 chars
// - summary: 1000 chars
// - fact content: 500 chars
// - evidenceText: 500 chars
// - reason: 500 chars
// - report overview: 2000 chars

import type { ObservationRepository } from "../db/repositories/ObservationRepository";
import type { Observation, ObserverOutputV2 } from "../models/types";
import type {
  BatchCaptureBundle,
  BatchFrameOcrResult,
  CaptureBundle,
  ScreenshotRetentionPolicy,
} from "../models/types";
import type { DebugEvent } from "../models/types";
import { TEXT_LIMITS } from "../models/schemas";
import type { PrivacyGuard } from "./PrivacyGuard";
import type { ScreenshotCache } from "./ScreenshotCache";

/**
 * Normalizer 输出
 */
export interface NormalizeResult {
  /** 写入数据库的 observation（如果 discarded=true 则为 null） */
  observation: Observation | null;
  /** 是否丢弃（high_sensitive 且按隐私规则决定丢弃时为 true） */
  discarded: boolean;
  /** 丢弃原因 */
  discardReason?: string;
  /** 清洗过程中产生的 warning */
  warnings: string[];
}

/**
 * 批次 Normalizer 输出
 */
export interface BatchNormalizeResult {
  /** 每帧 observation 落库后的真实 id（discarded 的帧为 null） */
  observationIds: (string | null)[];
  /** 每帧的清洗结果 */
  results: NormalizeResult[];
  /** results 中每项对应 batchBundle.frames 的原始下标 */
  frameIndices: Array<number | null>;
  /** 总 warning 数 */
  totalWarnings: number;
  /** 丢弃的帧数 */
  discardedCount: number;
}

/**
 * ObservationNormalizer：观察结果清洗器
 *
 * 处理流程：
 * 1. 检查 sensitivity，决定是否丢弃
 * 2. 生成 observation id
 * 3. 附加 capture metadata（captureId/capturedAt/appName/windowTitle/url/captureReason）
 * 4. 附加 screenshot 保留状态和路径
 * 5. 校验 JSON schema（vision 输出已由 ModelGateway zod 校验，此处只做长度清洗）
 * 6. 清洗过长字段
 * 7. 写入 observations 表
 *
 * 重要约束：
 * - 不修改模型语义判断（不改变 sensitivity/possibleTasks 等内容）
 * - 只做格式、长度、状态、安全处理
 * - high_sensitive 内容按隐私规则决定丢弃
 */
export class ObservationNormalizer {
  private readonly observationRepo: ObservationRepository;
  private readonly privacyGuard: PrivacyGuard | null;
  private readonly screenshotCache: ScreenshotCache | null;

  constructor(deps: {
    observationRepo: ObservationRepository;
    privacyGuard?: PrivacyGuard;
    screenshotCache?: ScreenshotCache;
  }) {
    this.observationRepo = deps.observationRepo;
    this.privacyGuard = deps.privacyGuard ?? null;
    this.screenshotCache = deps.screenshotCache ?? null;
  }

  /**
   * 清洗 vision 输出并写入 observations 表
   *
   * @param input vision 输出 + capture 元数据
   * @returns 处理结果（discarded=true 表示按隐私规则丢弃，未写入正式表）
   */
  normalize(input: {
    visionOutput: ObserverOutputV2;
    captureBundle: CaptureBundle;
    debugEvents?: DebugEvent[];
    frameIndex?: number;
    ocrResult?: BatchFrameOcrResult;
  }): NormalizeResult {
    const warnings: string[] = [];
    const { visionOutput, captureBundle } = input;

    // 1. 检查 sensitivity：high_sensitive 时按隐私规则处理
    //    来自 spec.md："如果 sensitivity 为 high_sensitive，按隐私规则决定是否丢弃"
    //    PrivacyGuard.checkPostVision 会根据 sensitivity 决定动作：
    //    - high_sensitive -> delete_observation（删除截图，删除 observation）
    //    - normal/possibly_sensitive -> keep
    if (visionOutput.sensitivity === "high_sensitive") {
      if (this.privacyGuard) {
        const postCheck = this.privacyGuard.checkPostVision(visionOutput.sensitivity);
        if (!postCheck.allowed && postCheck.action === "delete_observation") {
          this.deleteBundleScreenshots(captureBundle);
          if (input.debugEvents) {
            input.debugEvents.push({ layer: "L0", action: "discard", reason: "high_sensitive_privacy_guard", frameIndex: input.frameIndex });
          }
          return {
            observation: null,
            discarded: true,
            discardReason: postCheck.reason ?? "high_sensitive content discarded by privacy rule",
            warnings,
          };
        }
      } else {
        // 没有 PrivacyGuard 时，保守地丢弃 high_sensitive 内容
        this.deleteBundleScreenshots(captureBundle);
        if (input.debugEvents) {
          input.debugEvents.push({ layer: "L0", action: "discard", reason: "high_sensitive_no_guard", frameIndex: input.frameIndex });
        }
        return {
          observation: null,
          discarded: true,
          discardReason: "high_sensitive content discarded (no privacy guard configured)",
          warnings,
        };
      }
    }

    // 2. 清洗过长字段（不修改语义）
    const cleanedVisionOutput = this.truncateLongFields(visionOutput, warnings);
    const visibleContent = attachLocalOcrEvidence(
      cleanedVisionOutput.visibleContent,
      input.ocrResult
    );

    // 3. 附加 capture metadata + 截图状态
    if (captureBundle.retentionPolicy === "delete_immediately") {
      this.deleteBundleScreenshots(captureBundle);
    }
    const screenshotPaths = captureBundle.retentionPolicy === "delete_immediately"
      ? []
      : this.collectScreenshotPaths(captureBundle);
    const screenshotRetention = this.mapRetentionPolicy(captureBundle.retentionPolicy);

    // 4. 构造 observation 并写入数据库
    //    V2 体验字段（userFacingSummary/likelyWorkPurpose/privacyRisk/reportableSignal）
    //    来自 ObserverExtractorWorker 的 V2 输出，直接落库。
    const observation = this.observationRepo.create({
      captureId: captureBundle.captureId,
      capturedAt: captureBundle.capturedAt,
      appName: captureBundle.appName,
      windowTitle: captureBundle.windowTitle,
      urlOrDomain: captureBundle.urlOrDomain ?? null,
      captureReason: captureBundle.captureReason,
      sceneSummary: cleanedVisionOutput.sceneSummary,
      visibleContent,
      detectedEntities: cleanedVisionOutput.detectedEntities,
      possibleIntent: cleanedVisionOutput.possibleUserIntent,
      possibleTasks: cleanedVisionOutput.possibleTasks,
      possibleDecisions: cleanedVisionOutput.possibleDecisions,
      sensitivity: cleanedVisionOutput.sensitivity,
      confidence: cleanedVisionOutput.confidence,
      uncertainties: cleanedVisionOutput.uncertainties,
      screenshotRetention,
      screenshotPaths,
      // V2 体验字段（来自 ObserverExtractorWorker 的 V2 输出）
      userFacingSummary: cleanedVisionOutput.userFacingSummary,
      likelyWorkPurpose: cleanedVisionOutput.likelyWorkPurpose,
      privacyRisk: cleanedVisionOutput.privacyRisk,
      reportableSignal: cleanedVisionOutput.reportableSignal,
    });

    return {
      observation,
      discarded: false,
      warnings,
    };
  }

  /**
   * 批次 normalize：循环多帧 observation，逐个落库
   *
   * 与单帧 normalize() 的差异：
   * - 输入是 observations 数组（来自批次 ObserverExtractor 返回）
   * - 每帧 observation 对应 batchBundle.frames[i] 的单帧 CaptureBundle
   * - 返回 observationIds 数组（供 MemoryPipeline 回填 facts.sourceObservationIds）
   * - 单帧失败不阻断其他帧
   *
   * @param input.observations 模型返回的多帧 observation（当前默认 6 帧）
   * @param input.batchBundle 批次 CaptureBundle
   */
  normalizeBatch(input: {
    observations: ObserverOutputV2[];
    batchBundle: BatchCaptureBundle;
    debugEvents?: DebugEvent[];
  }): BatchNormalizeResult {
    const { observations, batchBundle } = input;
    const results: NormalizeResult[] = [];
    const observationIds: (string | null)[] = [];
    const frameIndices: Array<number | null> = [];
    let totalWarnings = 0;
    let discardedCount = 0;

    const availableFrameIndices = batchBundle.compressedImagePaths.length === 0
      ? batchBundle.frames.map((_frame, frameIndex) => frameIndex)
      : batchBundle.compressedImagePaths
          .map((imagePath, frameIndex) => imagePath ? frameIndex : -1)
          .filter((frameIndex) => frameIndex >= 0);

    for (let i = 0; i < observations.length; i++) {
      const obs = observations[i];
      // Older batch outputs omitted frameIndex and relied on response order.
      const submittedFrameIndex = obs.frameIndex ?? i + 1;
      const originalFrameIndex = availableFrameIndices[submittedFrameIndex - 1];
      const frameBundle = originalFrameIndex === undefined
        ? undefined
        : batchBundle.frames[originalFrameIndex];

      if (!frameBundle) {
        results.push({
          observation: null,
          discarded: false,
          discardReason: `帧 ${submittedFrameIndex ?? "?"} 无对应截图`,
          warnings: [],
        });
        observationIds.push(null);
        frameIndices.push(null);
        continue;
      }

      frameIndices.push(originalFrameIndex ?? null);

      try {
        const result = this.normalize({
          visionOutput: obs,
          captureBundle: frameBundle,
          debugEvents: input.debugEvents,
          frameIndex: originalFrameIndex,
          ocrResult: batchBundle.ocrResults?.[originalFrameIndex],
        });
        results.push(result);
        observationIds.push(result.observation?.id ?? null);
        totalWarnings += result.warnings.length;
        if (result.discarded) {
          discardedCount++;
        }
      } catch {
        // 单帧 normalize 失败不阻断其他帧
        results.push({
          observation: null,
          discarded: true,
          discardReason: `帧 ${i + 1} normalize 异常`,
          warnings: [],
        });
        observationIds.push(null);
        discardedCount++;
      }
    }

    return {
      observationIds,
      results,
      frameIndices,
      totalWarnings,
      discardedCount,
    };
  }

  /**
   * 清洗过长字段
   * - 按 TEXT_LIMITS 截断超长字段
   * - 不修改语义内容
   * - 截断时记录 warning
   */
  private truncateLongFields(
    output: ObserverOutputV2,
    warnings: string[]
  ): ObserverOutputV2 {
    // sceneSummary: 1000 chars
    const sceneSummary = truncateText(
      output.sceneSummary,
      TEXT_LIMITS.summary,
      "sceneSummary",
      warnings
    );

    // possibleUserIntent: 500 chars（按 factContent 限制）
    const possibleUserIntent = truncateText(
      output.possibleUserIntent,
      TEXT_LIMITS.factContent,
      "possibleUserIntent",
      warnings
    );

    // visibleContent: 只清洗摘要和辅助片段，fullText 作为 L0 原文原样保留
    const visibleContent = output.visibleContent.map((vc, idx) => {
      const summary = truncateText(
        vc.summary,
        TEXT_LIMITS.summary,
        `visibleContent[${idx}].summary`,
        warnings
      );
      const keyTextSnippets = vc.keyTextSnippets.map((snippet, sIdx) =>
        truncateText(
          snippet,
          TEXT_LIMITS.evidenceText,
          `visibleContent[${idx}].keyTextSnippets[${sIdx}]`,
          warnings
        )
      );
      return { ...vc, summary, fullText: vc.fullText, keyTextSnippets };
    });

    // detectedEntities: 清洗 name 和 evidence
    const detectedEntities = output.detectedEntities.map((e, idx) => {
      const name = truncateText(
        e.name,
        TEXT_LIMITS.title,
        `detectedEntities[${idx}].name`,
        warnings
      );
      const evidence = truncateText(
        e.evidence,
        TEXT_LIMITS.evidenceText,
        `detectedEntities[${idx}].evidence`,
        warnings
      );
      return { ...e, name, evidence };
    });

    // possibleTasks: 清洗 text 和 evidence
    const possibleTasks = output.possibleTasks.map((t, idx) => {
      const text = truncateText(
        t.text,
        TEXT_LIMITS.factContent,
        `possibleTasks[${idx}].text`,
        warnings
      );
      const evidence = truncateText(
        t.evidence,
        TEXT_LIMITS.evidenceText,
        `possibleTasks[${idx}].evidence`,
        warnings
      );
      return { ...t, text, evidence };
    });

    // possibleDecisions: 清洗 text 和 evidence
    const possibleDecisions = output.possibleDecisions.map((d, idx) => {
      const text = truncateText(
        d.text,
        TEXT_LIMITS.factContent,
        `possibleDecisions[${idx}].text`,
        warnings
      );
      const evidence = truncateText(
        d.evidence,
        TEXT_LIMITS.evidenceText,
        `possibleDecisions[${idx}].evidence`,
        warnings
      );
      return { ...d, text, evidence };
    });

    // possibleProjectProgress: 清洗 text, projectHint, evidence
    const possibleProjectProgress = output.possibleProjectProgress.map((p, idx) => {
      const text = truncateText(
        p.text,
        TEXT_LIMITS.factContent,
        `possibleProjectProgress[${idx}].text`,
        warnings
      );
      const projectHint = p.projectHint
        ? truncateText(
            p.projectHint,
            TEXT_LIMITS.title,
            `possibleProjectProgress[${idx}].projectHint`,
            warnings
          )
        : undefined;
      const evidence = truncateText(
        p.evidence,
        TEXT_LIMITS.evidenceText,
        `possibleProjectProgress[${idx}].evidence`,
        warnings
      );
      return { ...p, text, projectHint, evidence };
    });

    // V2 体验字段截断
    const userFacingSummary = truncateText(
      output.userFacingSummary,
      TEXT_LIMITS.summary,
      "userFacingSummary",
      warnings
    );
    const likelyWorkPurpose = truncateText(
      output.likelyWorkPurpose,
      TEXT_LIMITS.factContent,
      "likelyWorkPurpose",
      warnings
    );
    const privacyRiskReason = truncateText(
      output.privacyRiskReason,
      TEXT_LIMITS.reason,
      "privacyRiskReason",
      warnings
    );
    const reportableReason = truncateText(
      output.reportableReason,
      TEXT_LIMITS.reason,
      "reportableReason",
      warnings
    );

    // uncertainties: 清洗每条
    const uncertainties = output.uncertainties.map((u, idx) =>
      truncateText(u, TEXT_LIMITS.factContent, `uncertainties[${idx}]`, warnings)
    );

    return {
      ...output,
      sceneSummary,
      possibleUserIntent,
      visibleContent,
      detectedEntities,
      possibleTasks,
      possibleDecisions,
      possibleProjectProgress,
      userFacingSummary,
      likelyWorkPurpose,
      privacyRiskReason,
      reportableReason,
      uncertainties,
    };
  }

  /**
   * 收集截图路径（包含 stitched image 优先）
   */
  private collectScreenshotPaths(bundle: CaptureBundle): string[] {
    const paths: string[] = [];
    if (bundle.stitchedImagePath) {
      paths.push(bundle.stitchedImagePath);
    }
    // 同时保留所有原始帧路径
    for (const p of bundle.imagePaths) {
      if (!paths.includes(p)) {
        paths.push(p);
      }
    }
    return paths;
  }

  private deleteBundleScreenshots(bundle: CaptureBundle): void {
    if (!this.screenshotCache) return;
    for (const filePath of this.collectScreenshotPaths(bundle)) {
      this.screenshotCache.deleteFileSync(filePath);
    }
  }

  /**
   * 将 CaptureBundle.retentionPolicy 映射到 observation 的 screenshotRetention 字段
   *
   * 注意：observation 表 screenshot_retention 字段为 TEXT，存储的值遵循现有类型系统
   * （ScreenshotRetentionPolicy），由 ObservationRepository.updateScreenshotRetention
   * 在截图清理后更新为 "expired" 或 "deleted"。
   *
   * spec.md L0 Observation 定义的 "none" | "cached" | "deleted" | "expired" 是语义状态：
   * - delete_immediately -> 对应 "none"（立即删除，无保留）
   * - 1h/6h/today/3d/7d -> 对应 "cached"（缓存中，由 ScreenshotCache 按策略清理）
   * - 清理后 -> "expired"（过期）或 "deleted"（用户清空）
   *
   * 此处直接保留原始 policy 值，避免与现有 M1 类型系统冲突。
   * 后续可由 ScreenshotCache.cleanupExpired 更新为 "expired"。
   */
  private mapRetentionPolicy(policy: ScreenshotRetentionPolicy): ScreenshotRetentionPolicy {
    return policy;
  }
}

function attachLocalOcrEvidence(
  visibleContent: ObserverOutputV2["visibleContent"],
  ocrResult: BatchFrameOcrResult | undefined
): unknown[] {
  if (!ocrResult) return visibleContent;
  const ocrEvidence = {
    source: "windows_ocr_original_image" as const,
    available: !ocrResult.errorCode,
    language: ocrResult.language,
    text: ocrResult.text,
    lines: ocrResult.lines,
    blocks: ocrResult.blocks ?? [],
    mode: ocrResult.mode,
    reuseFromFrameIndex: ocrResult.reuseFromFrameIndex,
    reusedFromCaptureId: ocrResult.reusedFromCaptureId,
    deltaFromFrameIndex: ocrResult.deltaFromFrameIndex,
    delta: ocrResult.delta,
    screenSignature: ocrResult.screenSignature,
    errorCode: ocrResult.errorCode,
  };
  if (visibleContent.length === 0) {
    return [{
      type: "unknown",
      summary: "",
      fullText: ocrResult.text,
      keyTextSnippets: [],
      ocrEvidence,
    }];
  }
  return visibleContent.map((item, index) => index === 0
    ? { ...item, ocrEvidence }
    : item);
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 截断文本到指定长度
 * - 若超长，截断并追加 "..."（实际存储时不追加，仅记录 warning）
 * - 不修改原文本内容（仅截断）
 */
function truncateText(
  text: string,
  maxLen: number,
  fieldName: string,
  warnings: string[]
): string {
  if (text.length <= maxLen) {
    return text;
  }
  warnings.push(
    `${fieldName} 长度 ${text.length} 超过限制 ${maxLen}，已截断`
  );
  return text.slice(0, maxLen);
}
