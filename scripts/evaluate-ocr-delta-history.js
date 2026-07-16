const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { WindowsOcrService } = require("../dist/main/services/WindowsOcrService.js");
const { OcrFrameProcessor } = require("../dist/main/services/OcrFrameProcessor.js");
const { buildBatchOcrEvidenceJson } = require("../dist/main/services/BatchOcrEvidence.js");
const { buildObserverBatchFramePlan } = require("../dist/main/services/ObserverBatchFrames.js");

const ROOT = String.raw`C:\Users\Administrator\AppData\Roaming\recall\cache\screenshots\2026-07-16`;
const OUTPUT_DIR = path.join(os.tmpdir(), "recall-ocr-eval-20260716");

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const sequences = await buildSequences();
  const reports = [];
  for (const item of sequences) reports.push(await evaluateSequence(item));
  const report = {
    generatedAt: new Date().toISOString(),
    sequences: reports,
    totals: reports.reduce((totals, item) => ({
      originalFrames: totals.originalFrames + item.originalFrames,
      ocrFrames: totals.ocrFrames + item.ocrFrames,
      submittedModelFrames: totals.submittedModelFrames + item.submittedModelFrames,
      oldEvidenceBytes: totals.oldEvidenceBytes + item.oldEvidenceBytes,
      newEvidenceBytes: totals.newEvidenceBytes + item.newEvidenceBytes,
    }), {
      originalFrames: 0,
      ocrFrames: 0,
      submittedModelFrames: 0,
      oldEvidenceBytes: 0,
      newEvidenceBytes: 0,
    }),
  };
  report.totals.ocrSkipPercent = percentSaved(report.totals.originalFrames, report.totals.ocrFrames);
  report.totals.modelFrameSkipPercent = percentSaved(
    report.totals.originalFrames,
    report.totals.submittedModelFrames
  );
  report.totals.evidenceByteChangePercent = Number(
    ((report.totals.newEvidenceBytes / report.totals.oldEvidenceBytes - 1) * 100).toFixed(2)
  );

  const jsonPath = path.join(OUTPUT_DIR, "ocr-delta-history.json");
  const markdownPath = path.join(OUTPUT_DIR, "ocr-delta-history.md");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8");
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log(markdownPath);
}

async function evaluateSequence(item) {
  let ocrFrames = 0;
  const windowsOcr = new WindowsOcrService({ timeoutMs: 180_000 });
  const processor = new OcrFrameProcessor({
    ocrService: {
      recognizeImages: async (imagePaths) => {
        ocrFrames += imagePaths.length;
        return windowsOcr.recognizeImages(imagePaths);
      },
    },
  });
  const frames = item.paths.map((imagePath, index) => capture(item, imagePath, index));
  const prepared = await processor.prepareBatch(frames);
  const bundle = {
    batchId: `history-${item.id}`,
    frames,
    capturedAtStart: frames[0].capturedAt,
    capturedAtEnd: frames[frames.length - 1].capturedAt,
    timezone: "Asia/Shanghai",
    appName: item.appName,
    windowTitle: item.windowTitle,
    captureReason: "batch_flush",
    imagePaths: item.paths,
    compressedImagePaths: item.paths,
    ocrResults: prepared.results,
    retentionPolicy: "today",
  };
  const framePlan = buildObserverBatchFramePlan(bundle);
  const submittedOriginalIndices = framePlan.submittedFrames.map(
    (frame) => frame.originalFrameIndex
  );
  const newEvidence = buildBatchOcrEvidenceJson(
    prepared.results,
    submittedOriginalIndices
  );
  const oldEvidence = JSON.stringify(prepared.results.map((result) => ({
    frameIndex: result.frameIndex,
    source: "windows_ocr_original_image",
    available: !result.errorCode,
    language: result.language,
    text: result.lines.filter(Boolean).join("\n") || result.text,
  })), null, 2);

  return {
    id: item.id,
    sourceKind: item.sourceKind,
    originalFrames: frames.length,
    ocrFrames,
    submittedModelFrames: framePlan.submittedFrames.length,
    oldEvidenceBytes: Buffer.byteLength(oldEvidence),
    newEvidenceBytes: Buffer.byteLength(newEvidence),
    evidenceByteChangePercent: Number(
      ((Buffer.byteLength(newEvidence) / Buffer.byteLength(oldEvidence) - 1) * 100).toFixed(2)
    ),
    fullTextAvailableForEveryFrame: prepared.results.every(
      (result) => result.text.length > 0 || !!result.errorCode
    ),
    frames: prepared.results.map((result) => ({
      frameIndex: result.frameIndex,
      mode: result.mode,
      reuseFromFrameIndex: result.reuseFromFrameIndex,
      deltaFromFrameIndex: result.deltaFromFrameIndex,
      blockCount: result.blocks?.length ?? 0,
      unchangedBlocks: result.delta?.unchangedBlockIds.length ?? 0,
      addedBlocks: result.delta?.addedBlocks.length ?? 0,
      changedBlocks: result.delta?.changedBlocks.length ?? 0,
      removedBlocks: result.delta?.removedBlocks.length ?? 0,
    })),
  };
}

function sequence(id, appName, windowTitle, fileNames, sourceKind = "historical_original") {
  return {
    id,
    appName,
    windowTitle,
    sourceKind,
    paths: fileNames.map((fileName) => path.join(ROOT, fileName)),
  };
}

async function buildSequences() {
  const originals = [
    sequence("codex_input_change", "Codex", "ChatGPT", [
      "capture_1784162848256_efu7ccrm.png",
      "capture_1784162848397_1is7ey1l.png",
      "capture_1784162853257_brbailfz.png",
    ]),
    sequence("weixin_color_drift", "Weixin", "微信", [
      "capture_1784162848397_rdmv0d81.png",
      "capture_1784162853398_2ldswz1x.png",
    ]),
    sequence("trae_input_state", "TRAE SOLO CN", "TRAE Work CN", [
      "capture_1784160840248_l92ts3a4.png",
      "capture_1784160845420_z6h6kst9.png",
    ]),
    sequence("terminal_cursor", "Windows Terminal Host", String.raw`C:\WINDOWS\system32\cmd.exe`, [
      "capture_1784132385682_t5v9vg16.png",
      "capture_1784132390717_ic6qhxgd.png",
      "capture_1784132440796_oh2l448d.png",
    ]),
  ];
  if (originals.every((item) => item.paths.every((imagePath) => fs.existsSync(imagePath)))) {
    return originals;
  }

  const codex = path.join(OUTPUT_DIR, "codex_dense__upscale_1920.png");
  const controlledCodex = path.join(OUTPUT_DIR, "codex_dense__controlled_input_change.png");
  await createControlledCodexChange(codex, controlledCodex);
  return [
    {
      id: "codex_exact_then_controlled_input_change",
      appName: "Codex",
      windowTitle: "ChatGPT",
      sourceKind: "historical_derived_plus_controlled_change",
      paths: [codex, codex, controlledCodex],
    },
    {
      id: "weixin_same_content_preprocess_drift",
      appName: "Weixin",
      windowTitle: "微信",
      sourceKind: "historical_derived_same_content",
      paths: [
        path.join(OUTPUT_DIR, "weixin_chat__upscale_1920.png"),
        path.join(OUTPUT_DIR, "weixin_chat__gray_upscale.png"),
      ],
    },
    {
      id: "trae_same_content_preprocess_drift",
      appName: "TRAE SOLO CN",
      windowTitle: "TRAE Work CN",
      sourceKind: "historical_derived_same_content",
      paths: [
        path.join(OUTPUT_DIR, "trae_dense__upscale_1920.png"),
        path.join(OUTPUT_DIR, "trae_dense__gray_sharp_contrast_125.png"),
      ],
    },
    {
      id: "terminal_exact_duplicate",
      appName: "Windows Terminal Host",
      windowTitle: String.raw`C:\WINDOWS\system32\cmd.exe`,
      sourceKind: "historical_derived_exact_duplicate",
      paths: [
        path.join(OUTPUT_DIR, "terminal_dark__upscale_1920.png"),
        path.join(OUTPUT_DIR, "terminal_dark__upscale_1920.png"),
      ],
    },
  ];
}

async function createControlledCodexChange(sourcePath, outputPath) {
  if (!fs.existsSync(sourcePath)) throw new Error(`Missing historical derivative: ${sourcePath}`);
  const metadata = await sharp(sourcePath).metadata();
  const width = metadata.width ?? 1920;
  const height = metadata.height ?? 923;
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
      + `<rect x="570" y="790" width="760" height="92" rx="8" fill="#ffffff"/>`
      + `<text x="600" y="850" font-family="Microsoft YaHei, Arial" font-size="34" fill="#111111">用户输入：测试跨帧文字变化</text>`
      + `</svg>`
  );
  await sharp(sourcePath).composite([{ input: overlay }]).png().toFile(outputPath);
}

function capture(item, imagePath, index) {
  if (!fs.existsSync(imagePath)) throw new Error(`Missing historical screenshot: ${imagePath}`);
  return {
    captureId: `${item.id}-${index + 1}`,
    capturedAt: `2026-07-16T00:00:0${index}.000Z`,
    timezone: "Asia/Shanghai",
    appName: item.appName,
    windowTitle: item.windowTitle,
    captureReason: "content_changed",
    activitySignals: {
      keyboardActive: index > 0,
      mouseActive: false,
      idleSeconds: 0,
      activeWindowStableSeconds: 60,
    },
    imagePaths: [imagePath],
    retentionPolicy: "today",
  };
}

function percentSaved(original, remaining) {
  return Number(((1 - remaining / original) * 100).toFixed(2));
}

function renderMarkdown(report) {
  const lines = [
    "# OCR delta historical regression",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Sequence | Frames | OCR frames | Model frames | Old evidence bytes | New evidence bytes | Change |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const item of report.sequences) {
    lines.push(`| ${item.id} (${item.sourceKind}) | ${item.originalFrames} | ${item.ocrFrames} | ${item.submittedModelFrames} | ${item.oldEvidenceBytes} | ${item.newEvidenceBytes} | ${item.evidenceByteChangePercent}% |`);
  }
  lines.push(
    "",
    `Total OCR frames skipped: ${report.totals.ocrSkipPercent}%`,
    `Total model frames skipped: ${report.totals.modelFrameSkipPercent}%`,
    `Total evidence byte change: ${report.totals.evidenceByteChangePercent}%`,
    "",
    "## Frame modes",
    ""
  );
  for (const item of report.sequences) {
    lines.push(`### ${item.id}`, "", "```json", JSON.stringify(item.frames, null, 2), "```", "");
  }
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
