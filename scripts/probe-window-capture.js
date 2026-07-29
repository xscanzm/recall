// scripts/probe-window-capture.js
//
// 窗口抓图路径探针 / 复现器。
//
// 存在理由：钉钉白屏这个 bug 的偶发性让"改完之后感觉好了"不构成验收依据。
// 这个脚本把两件事变成可测量的：
//   1. 旧路径（全窗口缩略图）到底会不会打坏第三方 Chromium 窗口 —— 把偶发压成必现
//   2. 新路径（单窗口 getDisplayMedia）到底能不能在隐藏窗口里稳定出帧
//
// 用法（都从仓库根目录跑）：
//
//   # 复现：每 2s 做一次旧式全窗口抓图。开着钉钉，看它多久白屏。
//   npx electron scripts/probe-window-capture.js --sweep-legacy
//
//   # 验收：每 2s 只抓目标窗口。开着钉钉，应长时间不白屏。
//   npx electron scripts/probe-window-capture.js --sweep-new --title 钉钉
//
//   # 因果实验（A/B）：对照组只测量受害窗口，实验组每轮先做一次旧式全窗口抓图，
//   # 比较两组白屏率。这是"旧路径打坏第三方窗口"的客观证据，不靠人眼观察。
//   npx electron scripts/probe-window-capture.js --watch-victim --title 钉钉 --iterations 15
//
//   # 单次能力探测：验证隐藏窗口能否出帧 + 量测耗时 + 报 nearBlackRatio
//   npx electron scripts/probe-window-capture.js --probe --title 钉钉
//
//   # 对照：不启用 WGC。注意 --no-wgc 只是"不加 enable-features"，若 WGC 在本版
//   # Chromium 已默认开启则不构成对照；要真正关掉得直接传给 Electron 二进制：
//   npx electron --disable-features=AllowWgcWindowCapturer,AllowWgcScreenCapturer \
//     scripts/probe-window-capture.js --probe --title 钉钉
//
// 选项：
//   --title <substr>  目标窗口标题子串（缺省取最前面一个非自身窗口）
//   --iterations <n>  sweep 轮数上限（缺省无限，Ctrl+C 结束）
//   --interval <ms>   sweep 间隔（缺省 2000）
//   --no-wgc          不启用 WGC，走 GDI PrintWindow 老路（对照用）
//   --keep-open       跑完不退出，便于继续观察

const path = require("node:path");
const { app, BrowserWindow, desktopCapturer, session } = require("electron");

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1 || index === argv.length - 1) return fallback;
  return argv[index + 1];
}

const MODE = flag("sweep-legacy")
  ? "sweep-legacy"
  : flag("sweep-new")
    ? "sweep-new"
    : flag("watch-victim")
      ? "watch-victim"
      : "probe";
const TITLE_SUBSTRING = option("title", "");
const INTERVAL_MS = Number(option("interval", 2000));
const MAX_ITERATIONS = Number(option("iterations", 0)) || Infinity;
const USE_WGC = !flag("no-wgc");
const KEEP_OPEN = flag("keep-open");

const GRAB_TIMEOUT_MS = 4000;
const HOST_PARTITION = "recall-capture-probe";

// ---------------------------------------------------------------------------
// Chromium feature flags —— 必须在 app ready 之前
//
// 注意 appendSwitch("enable-features", ...) 二次调用会覆盖前值，所以这里也走
// 读取-合并，跟 app.ts 里的实现保持同一套语义。
// ---------------------------------------------------------------------------

function mergeSwitch(switchName, names) {
  const existing = app.commandLine.getSwitchValue(switchName);
  const merged = new Set(existing ? existing.split(",").filter(Boolean) : []);
  for (const name of names) merged.add(name);
  app.commandLine.appendSwitch(switchName, [...merged].join(","));
}

if (process.platform === "win32" && USE_WGC) {
  mergeSwitch("enable-features", ["AllowWgcWindowCapturer", "AllowWgcScreenCapturer"]);
  // zero-Hz 下静止内容不产新帧，单帧抓取会超时 —— 显式关掉，不依赖默认值。
  mergeSwitch("disable-features", ["AllowWgcWindowZeroHz", "AllowWgcScreenZeroHz"]);
}
// 隐藏窗口里的 <video> 需要 play()，避开 autoplay 手势要求。
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

// ---------------------------------------------------------------------------
// 页内抓图逻辑
//
// 探针与真实实现（WindowFrameGrabber）都用 executeJavaScript 注入，原因见
// WindowFrameGrabber.ts 顶部：tsconfig.node.json 没有 DOM lib，为一个 preload
// 给整个主进程放开 DOM 类型会削弱边界。
// ---------------------------------------------------------------------------

const GRAB_IN_PAGE = (timeoutMs) => `
(async () => {
  let stream = null;
  const startedAt = performance.now();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();

    // 等到真有一帧可画。只等 loadedmetadata 会画出空白帧。
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("frame_timeout")), ${timeoutMs});
      const done = () => { clearTimeout(timer); resolve(); };
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback(done);
      } else {
        video.onloadeddata = done;
      }
    });

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("zero_video_size");

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext("2d").drawImage(video, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);

    return {
      ok: true,
      width,
      height,
      bytes: bytes.length,
      elapsedMs: Math.round(performance.now() - startedAt),
      base64: btoa(binary),
    };
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.message) || error),
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    // 不 stop 会留下常驻捕获会话。
    if (stream) for (const track of stream.getTracks()) track.stop();
  }
})()
`;

// ---------------------------------------------------------------------------
// 主进程侧
// ---------------------------------------------------------------------------

let host = null;
let pendingSource = null;

async function createHost() {
  const hostSession = session.fromPartition(HOST_PARTITION);

  hostSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!pendingSource) {
      callback({});
      return;
    }
    callback({ video: { id: pendingSource.id, name: pendingSource.name } });
  });

  host = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      session: hostSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  await host.loadFile(path.join(__dirname, "..", "src", "main", "services", "capture-host.html"));
  return host;
}

/** thumbnailSize:{0,0} 枚举 —— 这一步不应该抓任何窗口。 */
async function enumerateWindows() {
  return desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
}

function pickTarget(sources) {
  const usable = sources.filter(
    (source) => source.name && source.name.trim() && !source.name.includes("recall-capture-host")
  );
  if (TITLE_SUBSTRING) {
    return usable.find((source) => source.name.includes(TITLE_SUBSTRING)) ?? null;
  }
  return usable[0] ?? null;
}

async function grabTarget(target) {
  pendingSource = target;
  try {
    return await host.webContents.executeJavaScript(GRAB_IN_PAGE(GRAB_TIMEOUT_MS), true);
  } finally {
    pendingSource = null;
  }
}

/**
 * 帧内容指标。
 *
 * nearBlack 是 GDI 抓 GPU 合成窗口返回全黑的特征；nearWhite + 低 edgeDensity
 * 则是"钉钉白屏"的特征 —— 一整片白、没有任何 UI 边缘。用后两个指标可以把
 * 白屏从人眼观察变成可自动判定的数字。
 */
async function analyzeFrame(pngBuffer) {
  const sharp = require("sharp");
  const { data, info } = await sharp(pngBuffer)
    .resize(160, 90, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const pixels = info.width * info.height;
  const luminance = new Float32Array(pixels);
  let nearBlack = 0;
  let nearWhite = 0;

  for (let i = 0; i < pixels; i += 1) {
    const offset = i * channels;
    const r = data[offset] ?? 0;
    const g = data[offset + Math.min(1, channels - 1)] ?? r;
    const b = data[offset + Math.min(2, channels - 1)] ?? r;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max <= 8) nearBlack += 1;
    if (min >= 244) nearWhite += 1;
    luminance[i] = r * 0.2126 + g * 0.7152 + b * 0.0722;
  }

  let edges = 0;
  let comparisons = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const index = y * info.width + x;
      if (x + 1 < info.width) {
        comparisons += 1;
        if (Math.abs(luminance[index] - luminance[index + 1]) >= 12) edges += 1;
      }
      if (y + 1 < info.height) {
        comparisons += 1;
        if (Math.abs(luminance[index] - luminance[index + info.width]) >= 12) edges += 1;
      }
    }
  }

  return {
    nearBlackRatio: nearBlack / pixels,
    nearWhiteRatio: nearWhite / pixels,
    edgeDensity: comparisons > 0 ? edges / comparisons : 0,
  };
}

/** 白屏判定：几乎全白 + 几乎没有 UI 边缘。 */
function looksBlank(metrics) {
  return metrics.nearWhiteRatio >= 0.9 && metrics.edgeDensity <= 0.02;
}

// ---------------------------------------------------------------------------
// 三种模式
// ---------------------------------------------------------------------------

async function runProbe() {
  const sources = await enumerateWindows();
  const emptyThumbnails = sources.filter((source) => source.thumbnail.isEmpty()).length;

  console.log(`[probe] WGC: ${USE_WGC ? "on" : "off"}`);
  console.log(`[probe] 窗口数: ${sources.length}`);
  // 这一行是"零抓图枚举"的实测证据：全部为空才说明没碰任何窗口。
  console.log(`[probe] thumbnailSize:{0,0} 空缩略图: ${emptyThumbnails}/${sources.length}`);

  const target = pickTarget(sources);
  if (!target) {
    console.log(`[probe] 找不到目标窗口${TITLE_SUBSTRING ? ` (--title ${TITLE_SUBSTRING})` : ""}`);
    console.log(`[probe] 可选窗口:\n  ${sources.map((s) => s.name).join("\n  ")}`);
    return;
  }
  console.log(`[probe] 目标: ${target.name} (${target.id})`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await grabTarget(target);
    if (!result.ok) {
      console.log(`[probe] #${attempt} 失败: ${result.error} (${result.elapsedMs}ms)`);
      continue;
    }
    const buffer = Buffer.from(result.base64, "base64");
    let metrics = "n/a";
    try {
      const analyzed = await analyzeFrame(buffer);
      metrics = `nearBlack=${analyzed.nearBlackRatio.toFixed(4)} `
        + `nearWhite=${analyzed.nearWhiteRatio.toFixed(4)} `
        + `edges=${analyzed.edgeDensity.toFixed(4)}`;
    } catch (error) {
      metrics = `analyze_failed: ${error.message}`;
    }
    console.log(
      `[probe] #${attempt} 成功: ${result.width}x${result.height}, `
        + `${(result.bytes / 1024).toFixed(0)}KB, ${result.elapsedMs}ms, ${metrics}`
    );
  }
}

/**
 * A/B 实验：旧式全窗口抓图到底会不会把第三方窗口打白。
 *
 * 对照组只测量受害窗口；实验组在每次测量前先做一次旧式全窗口抓图。
 * 测量本身走安全路径（单窗口 getDisplayMedia + WGC），尽量不污染实验。
 */
async function runWatchVictim() {
  const rounds = Number.isFinite(MAX_ITERATIONS) ? MAX_ITERATIONS : 15;

  const measure = async () => {
    const target = pickTarget(await enumerateWindows());
    if (!target) return null;
    const result = await grabTarget(target);
    if (!result.ok) return { error: result.error };
    return analyzeFrame(Buffer.from(result.base64, "base64"));
  };

  const legacySweep = async () => {
    await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
  };

  const phases = [
    { name: "对照组(不做旧式抓图)", sweep: false },
    { name: "实验组(每轮先旧式全窗口抓图)", sweep: true },
  ];

  const summary = [];
  for (const phase of phases) {
    let blank = 0;
    let measured = 0;
    let failed = 0;
    console.log(`\n[watch] === ${phase.name} × ${rounds} 轮 ===`);
    for (let round = 1; round <= rounds; round += 1) {
      if (phase.sweep) await legacySweep();
      const metrics = await measure();
      if (!metrics || metrics.error) {
        failed += 1;
        console.log(`[watch] #${round} 测量失败 ${metrics ? metrics.error : "no_target"}`);
      } else {
        measured += 1;
        const isBlank = looksBlank(metrics);
        if (isBlank) blank += 1;
        console.log(
          `[watch] #${round} nearWhite=${metrics.nearWhiteRatio.toFixed(4)} `
            + `edges=${metrics.edgeDensity.toFixed(4)} `
            + `${isBlank ? "<<< 白屏" : "正常"}`
        );
      }
      await sleep(INTERVAL_MS);
    }
    summary.push({ phase: phase.name, measured, blank, failed });
  }

  console.log("\n[watch] ===== 汇总 =====");
  for (const row of summary) {
    const rate = row.measured > 0 ? ((row.blank / row.measured) * 100).toFixed(1) : "n/a";
    console.log(
      `[watch] ${row.phase}: 白屏 ${row.blank}/${row.measured} (${rate}%), 测量失败 ${row.failed}`
    );
  }
}

async function runSweepLegacy() {
  console.log("[sweep-legacy] 每 " + INTERVAL_MS + "ms 做一次旧式全窗口抓图（1920x1080）。");
  console.log("[sweep-legacy] 开着钉钉观察白屏。Ctrl+C 结束。");

  // 直接量测旧路径自己抓到的目标窗口画面。
  //
  // 这是本脚本里唯一不污染实验的观测方式：被测行为（全窗口 PrintWindow）与观测
  // 手段是同一次调用，不需要额外对目标窗口开捕获会话。GDI PrintWindow 抓不到
  // GPU 合成窗口时返回的就是空白/全黑，与用户肉眼看到的白屏同源。
  let blankTarget = 0;
  let measuredTarget = 0;

  for (let round = 1; round <= MAX_ITERATIONS; round += 1) {
    const startedAt = Date.now();
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
    const blank = sources.filter((source) => source.thumbnail.isEmpty()).length;

    let targetNote = "";
    if (TITLE_SUBSTRING) {
      const target = sources.find((source) => source.name.includes(TITLE_SUBSTRING));
      if (!target) {
        targetNote = " | 目标: 不在枚举里";
      } else if (target.thumbnail.isEmpty()) {
        measuredTarget += 1;
        blankTarget += 1;
        targetNote = " | 目标: 空图 <<<";
      } else {
        try {
          const metrics = await analyzeFrame(target.thumbnail.toPNG());
          measuredTarget += 1;
          const isBlank = looksBlank(metrics) || metrics.nearBlackRatio >= 0.99;
          if (isBlank) blankTarget += 1;
          targetNote =
            ` | 目标 nearWhite=${metrics.nearWhiteRatio.toFixed(4)} `
            + `nearBlack=${metrics.nearBlackRatio.toFixed(4)} `
            + `edges=${metrics.edgeDensity.toFixed(4)} ${isBlank ? "<<< 白/黑屏" : "正常"}`;
        } catch (error) {
          targetNote = ` | 目标分析失败 ${error.message}`;
        }
      }
    }

    console.log(
      `[sweep-legacy] #${round} 抓了 ${sources.length} 个窗口, `
        + `空图 ${blank}, ${Date.now() - startedAt}ms${targetNote}`
    );
    await sleep(INTERVAL_MS);
  }

  if (measuredTarget > 0) {
    const rate = ((blankTarget / measuredTarget) * 100).toFixed(1);
    console.log(`\n[sweep-legacy] 目标窗口白/黑屏 ${blankTarget}/${measuredTarget} (${rate}%)`);
  }
}

async function runSweepNew() {
  const sources = await enumerateWindows();
  const target = pickTarget(sources);
  if (!target) {
    console.log(`[sweep-new] 找不到目标窗口${TITLE_SUBSTRING ? ` (--title ${TITLE_SUBSTRING})` : ""}`);
    return;
  }
  console.log(`[sweep-new] 只抓目标: ${target.name}`);
  console.log("[sweep-new] 开着钉钉观察白屏（应长时间不出现）。Ctrl+C 结束。");

  let ok = 0;
  let failed = 0;
  for (let round = 1; round <= MAX_ITERATIONS; round += 1) {
    // 每轮重新枚举：窗口标题会变（如钉钉未读数），id 也可能失效。
    const fresh = pickTarget(await enumerateWindows()) ?? target;
    const result = await grabTarget(fresh);
    if (result.ok) {
      ok += 1;
      console.log(
        `[sweep-new] #${round} ok ${result.width}x${result.height} ${result.elapsedMs}ms `
          + `(ok=${ok} failed=${failed})`
      );
    } else {
      failed += 1;
      console.log(`[sweep-new] #${round} 失败 ${result.error} (ok=${ok} failed=${failed})`);
    }
    await sleep(INTERVAL_MS);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    if (MODE !== "sweep-legacy") await createHost();

    if (MODE === "probe") await runProbe();
    else if (MODE === "sweep-legacy") await runSweepLegacy();
    else if (MODE === "watch-victim") await runWatchVictim();
    else await runSweepNew();
  } catch (error) {
    console.error("[probe] 未捕获错误:", error);
  } finally {
    if (!KEEP_OPEN) app.quit();
  }
});

app.on("window-all-closed", () => {
  // 隐藏 host 关闭后不要顺带退出，sweep 还在跑。
});
