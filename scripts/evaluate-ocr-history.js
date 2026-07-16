const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { WindowsOcrService } = require("../dist/main/services/WindowsOcrService.js");

const SCREENSHOT_ROOT = String.raw`C:\Users\Administrator\AppData\Roaming\recall\cache\screenshots\2026-07-16`;
const OUTPUT_ROOT = path.join(os.tmpdir(), "recall-ocr-eval-20260716");

const samples = [
  sample("chrome_toknex", "Google Chrome", "capture_1784162968417_4pceqaaz.png"),
  sample("codex_dense", "Codex", "capture_1784162853257_brbailfz.png"),
  sample("weixin_chat", "Weixin", "capture_1784162853398_2ldswz1x.png"),
  sample("trae_dense", "TRAE SOLO CN", "capture_1784160845420_z6h6kst9.png"),
  sample("zcode_document", "ZCode", "capture_1784160434647_l9mrg4ym.png"),
  sample("terminal_dark", "Windows Terminal Host", "capture_1784132440796_oh2l448d.png"),
  sample("tabbit_github", "Tabbit Browser", "capture_1784160229380_fnf2qj6u.png"),
  sample("hubstudio_modal", "hubstudio", "capture_1784156639321_8rf1yoij.png"),
];

const sequences = [
  sequence("codex_exact_duplicate", [
    "capture_1784162848256_efu7ccrm.png",
    "capture_1784162848397_1is7ey1l.png",
    "capture_1784162853257_brbailfz.png",
  ]),
  sequence("weixin_five_seconds", [
    "capture_1784162848397_rdmv0d81.png",
    "capture_1784162853398_2ldswz1x.png",
  ]),
  sequence("trae_five_seconds", [
    "capture_1784160840248_l92ts3a4.png",
    "capture_1784160845420_z6h6kst9.png",
  ]),
  sequence("terminal_history", [
    "capture_1784132385682_t5v9vg16.png",
    "capture_1784132390717_ic6qhxgd.png",
    "capture_1784132440796_oh2l448d.png",
  ]),
];

const variants = [
  { id: "raw", create: null },
  { id: "upscale_1920", create: (image) => resizeToMinWidth(image) },
  { id: "gray_upscale", create: (image) => resizeToMinWidth(image).grayscale() },
  {
    id: "gray_sharp_contrast_125",
    create: (image) => resizeToMinWidth(image).grayscale().sharpen({ sigma: 1 }).linear(1.25, -32),
  },
  {
    id: "adaptive_screenmind",
    create: async (image, metadata) => {
      let pipeline = resizeToMinWidth(image).grayscale();
      if (metadata.meanLuminance < 128) pipeline = pipeline.negate();
      return pipeline.sharpen({ sigma: 1 }).linear(1.5, -64);
    },
  },
  {
    id: "compressed_color_800_q45",
    jpeg: true,
    create: (image) => image.resize({ width: 800 }),
  },
  {
    id: "compressed_gray_800_q45",
    jpeg: true,
    create: (image) => image.resize({ width: 800 }).grayscale(),
  },
];

async function main() {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });

  const preparedSamples = [];
  for (const item of samples) {
    assertFile(item.path);
    const imageMetadata = await readImageMetadata(item.path);
    const prepared = { ...item, ...imageMetadata, variants: {} };

    for (const variant of variants) {
      if (!variant.create) {
        prepared.variants[variant.id] = item.path;
        continue;
      }
      const outputPath = path.join(
        OUTPUT_ROOT,
        `${item.id}__${variant.id}.${variant.jpeg ? "jpg" : "png"}`
      );
      const image = sharp(item.path, { failOn: "error" });
      const transformed = await variant.create(image, imageMetadata);
      if (variant.jpeg) {
        await transformed.jpeg({
          quality: 45,
          chromaSubsampling: "4:2:0",
          mozjpeg: true,
        }).toFile(outputPath);
      } else {
        await transformed.png({ compressionLevel: 9 }).toFile(outputPath);
      }
      prepared.variants[variant.id] = outputPath;
    }
    preparedSamples.push(prepared);
  }

  const ocrService = new WindowsOcrService({ timeoutMs: 180_000 });
  const ocrByVariant = {};
  for (const variant of variants) {
    const paths = preparedSamples.map((item) => item.variants[variant.id]);
    const startedAt = performance.now();
    const result = await ocrService.recognizeImages(paths);
    const elapsedMs = Math.round(performance.now() - startedAt);
    ocrByVariant[variant.id] = {
      available: result.available,
      errorCode: result.errorCode,
      elapsedMs,
      frames: result.frames.map((frame, index) => ({
        sampleId: preparedSamples[index].id,
        appName: preparedSamples[index].appName,
        lineCount: frame.lines.length,
        characterCount: frame.text.length,
        language: frame.language,
        errorCode: frame.errorCode,
        text: frame.text,
        lines: frame.lines,
      })),
    };
  }

  const sequencePaths = Array.from(new Set(sequences.flatMap((item) => item.paths)));
  const sequenceOcrStartedAt = performance.now();
  const sequenceOcrResult = await ocrService.recognizeImages(sequencePaths);
  const sequenceOcrByPath = new Map(
    sequencePaths.map((imagePath, index) => [imagePath, sequenceOcrResult.frames[index]])
  );

  const sequenceResults = [];
  for (const item of sequences) {
    for (const imagePath of item.paths) assertFile(imagePath);
    const frames = [];
    for (const imagePath of item.paths) {
      frames.push(await readSimilarityFeatures(imagePath));
    }
    const pairs = [];
    for (let index = 1; index < frames.length; index += 1) {
      const comparison = compareFrames(frames[index - 1], frames[index]);
      const previousOcr = sequenceOcrByPath.get(frames[index - 1].path)?.text ?? "";
      const currentOcr = sequenceOcrByPath.get(frames[index].path)?.text ?? "";
      comparison.ocrTextSimilarity = textSimilarity(previousOcr, currentOcr);
      pairs.push(comparison);
    }
    sequenceResults.push({ id: item.id, paths: item.paths, pairs });
  }

  const result = {
    generatedAt: new Date().toISOString(),
    outputRoot: OUTPUT_ROOT,
    samples: preparedSamples,
    variants: variants.map(({ id }) => id),
    ocrByVariant,
    sequenceOcr: {
      available: sequenceOcrResult.available,
      errorCode: sequenceOcrResult.errorCode,
      elapsedMs: Math.round(performance.now() - sequenceOcrStartedAt),
      frames: sequencePaths.map((imagePath, index) => ({
        path: imagePath,
        text: sequenceOcrResult.frames[index]?.text ?? "",
        lines: sequenceOcrResult.frames[index]?.lines ?? [],
      })),
    },
    sequences: sequenceResults,
  };
  fs.writeFileSync(path.join(OUTPUT_ROOT, "results.json"), JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(path.join(OUTPUT_ROOT, "results.md"), renderMarkdown(result), "utf8");
  process.stdout.write(`${path.join(OUTPUT_ROOT, "results.json")}\n`);
}

function sample(id, appName, fileName) {
  return { id, appName, path: path.join(SCREENSHOT_ROOT, fileName) };
}

function sequence(id, fileNames) {
  return { id, paths: fileNames.map((fileName) => path.join(SCREENSHOT_ROOT, fileName)) };
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing historical screenshot: ${filePath}`);
}

function resizeToMinWidth(image) {
  return image.resize({ width: 1920, withoutEnlargement: false, fit: "inside", kernel: sharp.kernel.lanczos3 });
}

async function readImageMetadata(filePath) {
  const image = sharp(filePath, { failOn: "error" });
  const metadata = await image.metadata();
  const stats = await image.grayscale().stats();
  return {
    width: metadata.width,
    height: metadata.height,
    fileBytes: fs.statSync(filePath).size,
    meanLuminance: Number(stats.channels[0].mean.toFixed(2)),
  };
}

async function readSimilarityFeatures(filePath) {
  const bytes = fs.readFileSync(filePath);
  const { data: lowRes } = await sharp(bytes)
    .grayscale()
    .resize(64, 64, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: dHashPixels } = await sharp(bytes)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let dHash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      dHash <<= 1n;
      const offset = y * 9 + x;
      if (dHashPixels[offset] > dHashPixels[offset + 1]) dHash |= 1n;
    }
  }
  return {
    path: filePath,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    lowRes: Array.from(lowRes),
    dHash: dHash.toString(16).padStart(16, "0"),
  };
}

function compareFrames(previous, current) {
  let absoluteDifference = 0;
  let changedPixels = 0;
  for (let index = 0; index < previous.lowRes.length; index += 1) {
    const difference = Math.abs(previous.lowRes[index] - current.lowRes[index]);
    absoluteDifference += difference;
    if (difference >= 8) changedPixels += 1;
  }
  const normalizedMae = absoluteDifference / previous.lowRes.length / 255;
  return {
    previousPath: previous.path,
    currentPath: current.path,
    exactMatch: previous.sha256 === current.sha256,
    normalizedMae: Number(normalizedMae.toFixed(6)),
    lowResSimilarity: Number((1 - normalizedMae).toFixed(6)),
    changedPixelRatioAt8: Number((changedPixels / previous.lowRes.length).toFixed(6)),
    dHashHammingDistance: hammingDistance(previous.dHash, current.dHash),
  };
}

function hammingDistance(leftHex, rightHex) {
  let value = BigInt(`0x${leftHex}`) ^ BigInt(`0x${rightHex}`);
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function textSimilarity(left, right) {
  const normalizedLeft = normalizeOcrText(left);
  const normalizedRight = normalizeOcrText(right);
  const longest = Math.max(normalizedLeft.length, normalizedRight.length);
  if (longest === 0) return 1;
  return Number((1 - levenshteinDistance(normalizedLeft, normalizedRight) / longest).toFixed(6));
}

function normalizeOcrText(value) {
  return Array.from(value.toLowerCase()).filter((character) => /[\p{L}\p{N}]/u.test(character)).join("");
}

function levenshteinDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function renderMarkdown(result) {
  const lines = [
    "# Recall historical screenshot OCR evaluation",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    "## Samples",
    "",
    "| Sample | App | Size | Mean luminance |",
    "| --- | --- | ---: | ---: |",
  ];
  for (const sampleItem of result.samples) {
    lines.push(`| ${sampleItem.id} | ${sampleItem.appName} | ${sampleItem.width}x${sampleItem.height} | ${sampleItem.meanLuminance} |`);
  }
  lines.push("", "## OCR output size", "", "| Variant | Time ms | Sample | Lines | Characters |", "| --- | ---: | --- | ---: | ---: |");
  for (const [variantId, output] of Object.entries(result.ocrByVariant)) {
    for (const frame of output.frames) {
      lines.push(`| ${variantId} | ${output.elapsedMs} | ${frame.sampleId} | ${frame.lineCount} | ${frame.characterCount} |`);
    }
  }
  lines.push("", "## Sequence similarity", "", "| Sequence | Pair | Exact | Similarity | Changed ratio | dHash distance | OCR text similarity |", "| --- | ---: | --- | ---: | ---: | ---: | ---: |");
  for (const sequenceItem of result.sequences) {
    sequenceItem.pairs.forEach((pair, index) => {
      lines.push(`| ${sequenceItem.id} | ${index + 1} | ${pair.exactMatch} | ${pair.lowResSimilarity} | ${pair.changedPixelRatioAt8} | ${pair.dHashHammingDistance} | ${pair.ocrTextSimilarity} |`);
    });
  }
  lines.push("");
  return lines.join("\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
