const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SAMPLE_INTERVAL_MS = 1_000;
const PROFILE_TIMEOUT_MS = 330_000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;

async function main() {
  const workerPath = path.resolve(process.argv[2] ?? "");
  const imagePaths = process.argv.slice(3).map((value) => path.resolve(value));
  if (!fs.existsSync(workerPath) || imagePaths.length === 0 || imagePaths.some((value) => !fs.existsSync(value))) {
    throw new Error("Usage: node scripts/profile-rapidocr-worker.js <worker-exe> <image> [image...]");
  }

  const worker = spawn(workerPath, [], {
    cwd: path.dirname(workerPath),
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const startedAt = Date.now();
  const samples = [];
  let sampling = true;
  const samplingTask = sampleProcessTree(worker.pid, samples, () => sampling);

  try {
    const result = await runStreamRequest(worker, imagePaths, startedAt);
    sampling = false;
    await samplingTask;
    const stats = summarizeSamples(samples);
    console.log(JSON.stringify({
      ...result,
      processTree: stats,
    }));
  } finally {
    sampling = false;
    await terminateProcessTree(worker);
  }
}

function runStreamRequest(worker, imagePaths, startedAt) {
  return new Promise((resolve, reject) => {
    const requestId = `profile-${startedAt}`;
    const frames = [];
    let stdoutBuffer = "";
    const timer = setTimeout(() => reject(new Error("RapidOCR profile timed out")), PROFILE_TIMEOUT_MS);

    worker.once("error", reject);
    worker.once("close", (code) => reject(new Error(`RapidOCR worker exited with code ${String(code)}`)));
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_STDOUT_BYTES) {
        reject(new Error("RapidOCR profile output exceeded limit"));
        return;
      }
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) {
          let response;
          try {
            response = JSON.parse(line);
          } catch {
            reject(new Error("RapidOCR profile received invalid JSON"));
            return;
          }
          if (response.id !== requestId) {
            reject(new Error("RapidOCR profile received an unexpected request id"));
            return;
          }
          if (response.type === "frame") {
            const frame = response.frame ?? {};
            frames.push({
              frameIndex: frame.frameIndex,
              completedAfterMs: Date.now() - startedAt,
              blockCount: Array.isArray(frame.blocks) ? frame.blocks.length : 0,
              errorCode: typeof frame.errorCode === "string" ? frame.errorCode : undefined,
            });
          } else if (response.type === "complete") {
            clearTimeout(timer);
            resolve({
              available: response.available === true,
              engine: response.engine,
              model: response.model,
              engineVersion: response.engineVersion,
              frameCount: imagePaths.length,
              streamedFrameCount: frames.length,
              completedAfterMs: Date.now() - startedAt,
              frames,
              errorCode: typeof response.errorCode === "string" ? response.errorCode : undefined,
            });
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    worker.stdin.write(`${JSON.stringify({
      id: requestId,
      type: "recognize",
      responseMode: "frame_stream_v1",
      imagePaths,
    })}\n`);
  });
}

async function sampleProcessTree(rootProcessId, samples, shouldContinue) {
  while (shouldContinue()) {
    try {
      const processes = await queryProcessTree(rootProcessId);
      if (processes.length > 0) samples.push(processes);
    } catch {
      // A process can exit between the CIM snapshot and Get-Process.
    }
    if (shouldContinue()) await delay(SAMPLE_INTERVAL_MS);
  }
}

function queryProcessTree(rootProcessId) {
  const script = `
$RootProcessId = [int]$env:RECALL_PROFILE_ROOT_PROCESS_ID
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = [System.Collections.Generic.HashSet[int]]::new()
[void]$ids.Add($RootProcessId)
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($item in $all) {
    if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) {
      $changed = $true
    }
  }
}
$stats = foreach ($processId in $ids) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    [pscustomobject]@{
      id = $process.Id
      cpuSeconds = $process.CPU
      workingSetBytes = $process.WorkingSet64
      privateBytes = $process.PrivateMemorySize64
      threadCount = $process.Threads.Count
    }
  }
}
$stats | ConvertTo-Json -Compress
`;
  return new Promise((resolve, reject) => {
    execFile(
      "pwsh",
      ["-NoProfile", "-Command", script],
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          RECALL_PROFILE_ROOT_PROCESS_ID: String(rootProcessId),
        },
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout) : [];
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function summarizeSamples(samples) {
  const totals = samples.map((sample) => sample.reduce((total, process) => ({
    cpuSeconds: total.cpuSeconds + Number(process.cpuSeconds ?? 0),
    workingSetBytes: total.workingSetBytes + Number(process.workingSetBytes ?? 0),
    privateBytes: total.privateBytes + Number(process.privateBytes ?? 0),
    threadCount: total.threadCount + Number(process.threadCount ?? 0),
  }), { cpuSeconds: 0, workingSetBytes: 0, privateBytes: 0, threadCount: 0 }));
  const maximum = (key) => Math.max(0, ...totals.map((item) => item[key]));
  const final = totals.at(-1) ?? { cpuSeconds: 0, workingSetBytes: 0, privateBytes: 0, threadCount: 0 };
  return {
    samples: totals.length,
    cpuSeconds: round(final.cpuSeconds, 2),
    maxWorkingSetMb: bytesToMb(maximum("workingSetBytes")),
    finalWorkingSetMb: bytesToMb(final.workingSetBytes),
    maxPrivateMb: bytesToMb(maximum("privateBytes")),
    finalPrivateMb: bytesToMb(final.privateBytes),
    maxThreadCount: maximum("threadCount"),
    finalThreadCount: final.threadCount,
  };
}

function terminateProcessTree(worker) {
  if (!worker.pid) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(worker.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.once("error", () => {
      worker.kill();
      resolve();
    });
    killer.once("close", () => resolve());
  });
}

function bytesToMb(value) {
  return round(value / 1024 / 1024, 1);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
