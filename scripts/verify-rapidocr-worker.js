const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath || !fs.existsSync(imagePath)) {
    throw new Error("Usage: node scripts/verify-rapidocr-worker.js <existing-image-path>");
  }

  const workerPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, "../resources/ocr/rapidocr-worker/rapidocr-worker.exe");
  if (!fs.existsSync(workerPath)) {
    throw new Error("Build the worker first with npm run build:ocr-worker");
  }

  const { RapidOcrService } = require("../dist/main/services/RapidOcrService");
  const service = new RapidOcrService({ workerPath, timeoutMs: 180_000 });
  try {
    const result = await service.recognizeImages([path.resolve(imagePath)]);
    const frame = result.frames[0];
    if (!result.available || !frame || frame.errorCode) {
      throw new Error(`OCR verification failed: ${frame?.errorCode ?? result.errorCode ?? "unavailable"}`);
    }
    const blocks = frame.blocks ?? [];
    if (frame.engine !== "rapidocr" || frame.model !== "PP-OCRv6-small") {
      throw new Error("OCR verification returned unexpected engine metadata");
    }
    if (blocks.some((block) =>
      block.confidence === undefined
      || block.boundingBox.width <= 0
      || block.boundingBox.height <= 0
    )) {
      throw new Error("OCR verification returned invalid confidence or coordinates");
    }

    const confidences = blocks.flatMap((block) =>
      block.confidence === undefined ? [] : [block.confidence]
    );
    const meanConfidence = confidences.length > 0
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null;
    console.log(JSON.stringify({
      available: result.available,
      engine: frame.engine,
      model: frame.model,
      engineVersion: frame.engineVersion,
      lineCount: frame.lines.length,
      blockCount: blocks.length,
      meanConfidence: meanConfidence === null ? null : Number(meanConfidence.toFixed(4)),
      coordinatesValid: true,
    }));
  } finally {
    await service.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
