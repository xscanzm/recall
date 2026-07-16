import { spawn } from "node:child_process";
import * as path from "node:path";
import type {
  BatchFrameOcrResult,
  OcrBoundingBox,
  OcrTextBlock,
  OcrWordResult,
} from "../models/types";
import { logger } from "./Logger";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

export interface WindowsOcrBatchResult {
  available: boolean;
  frames: BatchFrameOcrResult[];
  errorCode?: string;
}

export interface WindowsOcrServiceConfig {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runPowerShell?: (imagePaths: string[], timeoutMs: number) => Promise<string>;
}

interface RawOcrResponse {
  available?: unknown;
  language?: unknown;
  errorCode?: unknown;
  results?: unknown;
}

/**
 * Windows.Media.Ocr adapter.
 *
 * The image paths are sent as UTF-8 JSON over stdin. They are never interpolated
 * into the PowerShell command, which keeps arbitrary local paths safe.
 */
export class WindowsOcrService {
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private readonly runPowerShell: (imagePaths: string[], timeoutMs: number) => Promise<string>;

  constructor(config: WindowsOcrServiceConfig = {}) {
    this.platform = config.platform ?? process.platform;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runPowerShell = config.runPowerShell ?? runWindowsPowerShell;
  }

  async recognizeImages(imagePaths: string[]): Promise<WindowsOcrBatchResult> {
    if (imagePaths.length === 0) return { available: true, frames: [] };
    if (this.platform !== "win32") {
      return unavailableResult(imagePaths.length, "windows_ocr_unsupported_platform");
    }

    try {
      const raw = await this.runPowerShell(imagePaths, this.timeoutMs);
      return parseOcrResponse(raw, imagePaths.length);
    } catch (error) {
      logger.warn({
        jobType: "windows_ocr",
        status: "failed",
        errorCode: "windows_ocr_process_failed",
        message: `Windows OCR batch failed: ${error instanceof Error ? error.name : "unknown_error"}`,
      });
      return unavailableResult(imagePaths.length, "windows_ocr_process_failed");
    }
  }
}

function parseOcrResponse(raw: string, frameCount: number): WindowsOcrBatchResult {
  try {
    const parsed = JSON.parse(raw) as RawOcrResponse;
    const language = typeof parsed.language === "string" ? parsed.language : undefined;
    if (parsed.available !== true) {
      const errorCode = typeof parsed.errorCode === "string"
        ? parsed.errorCode
        : "windows_ocr_unavailable";
      return unavailableResult(frameCount, errorCode);
    }

    const items = Array.isArray(parsed.results) ? parsed.results : [];
    const byFrame = new Map<number, BatchFrameOcrResult>();
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      const frameIndex = Number(value.frameIndex);
      if (!Number.isInteger(frameIndex) || frameIndex < 1 || frameIndex > frameCount) continue;
      byFrame.set(frameIndex, {
        frameIndex,
        text: typeof value.text === "string" ? value.text : "",
        lines: Array.isArray(value.lines)
          ? value.lines.filter((line): line is string => typeof line === "string")
          : [],
        blocks: parseBlocks(value.blocks),
        language: typeof value.language === "string" ? value.language : language,
        errorCode: typeof value.errorCode === "string" ? value.errorCode : undefined,
      });
    }

    const frames = Array.from({ length: frameCount }, (_, index) => {
      const frameIndex = index + 1;
      return byFrame.get(frameIndex) ?? emptyFrame(frameIndex, language, "windows_ocr_missing_result");
    });
    return { available: true, frames };
  } catch {
    return unavailableResult(frameCount, "windows_ocr_invalid_output");
  }
}

function parseBlocks(value: unknown): OcrTextBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const blocks: OcrTextBlock[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    const text = typeof block.text === "string" ? block.text : "";
    const boundingBox = parseBoundingBox(block.boundingBox);
    if (!boundingBox) continue;
    const words = parseWords(block.words);
    blocks.push({
      id: typeof block.id === "string" && block.id.length > 0
        ? block.id
        : `line_${index + 1}`,
      text,
      boundingBox,
      words,
      confidence: parseConfidence(block.confidence),
    });
  }
  return blocks;
}

function parseWords(value: unknown): OcrWordResult[] {
  if (!Array.isArray(value)) return [];
  const words: OcrWordResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const word = item as Record<string, unknown>;
    const boundingBox = parseBoundingBox(word.boundingBox);
    if (!boundingBox || typeof word.text !== "string") continue;
    words.push({
      text: word.text,
      boundingBox,
      confidence: parseConfidence(word.confidence),
    });
  }
  return words;
}

function parseBoundingBox(value: unknown): OcrBoundingBox | null {
  if (!value || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
    return null;
  }
  return { x, y, width, height };
}

function parseConfidence(value: unknown): number | undefined {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? confidence
    : undefined;
}

function unavailableResult(frameCount: number, errorCode: string): WindowsOcrBatchResult {
  return {
    available: false,
    errorCode,
    frames: Array.from({ length: frameCount }, (_, index) =>
      emptyFrame(index + 1, undefined, errorCode)
    ),
  };
}

function emptyFrame(
  frameIndex: number,
  language?: string,
  errorCode?: string
): BatchFrameOcrResult {
  return { frameIndex, text: "", lines: [], language, errorCode };
}

function runWindowsPowerShell(imagePaths: string[], timeoutMs: number): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershellPath = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const encodedCommand = Buffer.from(WINDOWS_OCR_SCRIPT, "utf16le").toString("base64");

  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
    );
    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.trim());
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Windows OCR timed out"));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill();
        finish(new Error("Windows OCR output exceeded limit"));
        return;
      }
      stdout += chunk;
    });
    // Windows PowerShell may emit CLIXML progress records on stderr during the
    // first WinRT load. Drain them without logging paths or OCR content.
    child.stderr.resume();
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`Windows OCR exited with code ${String(code)}`));
        return;
      }
      finish();
    });
    child.stdin.on("error", (error) => finish(error));
    child.stdin.end(JSON.stringify({ imagePaths }), "utf8");
  });
}

const WINDOWS_OCR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime] | Out-Null

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
})[0]

function Await-Result($operation, $resultType) {
  $task = $script:asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait()
  return $task.Result
}

$payloadText = [Console]::In.ReadToEnd()
$payload = $payloadText | ConvertFrom-Json
$imagePaths = @($payload.imagePaths)
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  [PSCustomObject]@{
    available = $false
    errorCode = 'windows_ocr_engine_unavailable'
    results = @()
  } | ConvertTo-Json -Compress -Depth 6
  exit 0
}

$language = $engine.RecognizerLanguage.LanguageTag
$results = @()
for ($index = 0; $index -lt $imagePaths.Count; $index++) {
  $stream = $null
  $softwareBitmap = $null
  try {
    $imagePath = [string]$imagePaths[$index]
    if ([string]::IsNullOrWhiteSpace($imagePath) -or -not [System.IO.File]::Exists($imagePath)) {
      throw 'image_not_found'
    }
    $file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $softwareBitmap = Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $ocrResult = Await-Result ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = @($ocrResult.Lines | ForEach-Object { [string]$_.Text })
    $blocks = @()
    $lineIndex = 0
    foreach ($line in $ocrResult.Lines) {
      $words = @()
      $minX = [double]::PositiveInfinity
      $minY = [double]::PositiveInfinity
      $maxX = [double]::NegativeInfinity
      $maxY = [double]::NegativeInfinity
      foreach ($word in $line.Words) {
        $rect = $word.BoundingRect
        $minX = [Math]::Min($minX, $rect.X)
        $minY = [Math]::Min($minY, $rect.Y)
        $maxX = [Math]::Max($maxX, $rect.X + $rect.Width)
        $maxY = [Math]::Max($maxY, $rect.Y + $rect.Height)
        $words += [PSCustomObject]@{
          text = [string]$word.Text
          boundingBox = [PSCustomObject]@{
            x = [double]$rect.X
            y = [double]$rect.Y
            width = [double]$rect.Width
            height = [double]$rect.Height
          }
        }
      }
      if ($words.Count -gt 0) {
        $lineIndex++
        $blocks += [PSCustomObject]@{
          id = "line_$lineIndex"
          text = [string]$line.Text
          boundingBox = [PSCustomObject]@{
            x = $minX
            y = $minY
            width = $maxX - $minX
            height = $maxY - $minY
          }
          words = $words
        }
      }
    }
    $results += [PSCustomObject]@{
      frameIndex = $index + 1
      text = [string]$ocrResult.Text
      lines = $lines
      blocks = $blocks
      language = $language
    }
  } catch {
    $results += [PSCustomObject]@{
      frameIndex = $index + 1
      text = ''
      lines = @()
      language = $language
      errorCode = 'windows_ocr_frame_failed'
    }
  } finally {
    if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

[PSCustomObject]@{
  available = $true
  language = $language
  results = $results
} | ConvertTo-Json -Compress -Depth 10
`;
