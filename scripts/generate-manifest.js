const fs = require("node:fs");
const path = require("node:path");

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function validateVersion(value) {
  const version = requireString(value, "version");
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  for (const component of match.slice(1, 4)) {
    if (!Number.isSafeInteger(Number(component))) {
      throw new Error(`Semantic version component exceeds the safe integer range: ${version}`);
    }
  }
  return version;
}

function validatePublishedAt(value) {
  const publishedAt = requireString(value, "publishedAt");
  if (!UTC_ISO_PATTERN.test(publishedAt)) {
    throw new Error(`publishedAt must be a UTC ISO-8601 timestamp: ${publishedAt}`);
  }

  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid publishedAt timestamp: ${publishedAt}`);
  }
  const canonicalInput = publishedAt.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_match, fraction) => `.${String(fraction ?? "").padEnd(3, "0")}Z`,
  );
  const canonicalTimestamp = parsed.toISOString();
  if (canonicalTimestamp !== canonicalInput) {
    throw new Error(`Invalid publishedAt timestamp: ${publishedAt}`);
  }
  return canonicalTimestamp;
}

function readPackageVersion(packagePath) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`package.json not found: ${packagePath}`);
  }

  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read package.json at ${packagePath}: ${error.message}`);
  }
  return validateVersion(packageJson.version);
}

function generateManifest(options = {}) {
  const version = validateVersion(options.version ?? process.env.VERSION);
  const sha256 = requireString(options.sha256 ?? process.env.SHA256, "sha256");
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error("sha256 must contain exactly 64 hexadecimal characters");
  }

  const packagePath = path.resolve(
    options.packagePath ?? process.env.PACKAGE_PATH ?? path.join(__dirname, "..", "package.json"),
  );
  const packageVersion = readPackageVersion(packagePath);
  if (packageVersion !== version) {
    throw new Error(`Release version ${version} does not match package.json version ${packageVersion}`);
  }

  const releaseTag = options.releaseTag ?? process.env.RELEASE_TAG;
  if (releaseTag !== undefined && releaseTag !== `v${version}`) {
    throw new Error(`Release tag ${releaseTag} does not match version v${version}`);
  }

  const notesPath = path.resolve(
    options.notesPath ?? process.env.NOTES_PATH ?? "cloudflare/worker/release-notes.md",
  );
  if (!fs.existsSync(notesPath)) {
    throw new Error(`Release notes file not found: ${notesPath}`);
  }
  const releaseNotes = fs.readFileSync(notesPath, "utf8");
  if (releaseNotes.trim().length === 0) {
    throw new Error(`Release notes file is empty: ${notesPath}`);
  }

  const publishedAt = validatePublishedAt(
    options.publishedAt ?? process.env.PUBLISHED_AT ?? new Date().toISOString(),
  );
  const outputPath = path.resolve(
    options.outputPath ?? process.env.OUTPUT_PATH ?? "cloudflare/worker/manifest.release.json",
  );

  // Windows 产物（顶层字段，兼容旧客户端）
  const winDownloadUrl = `/download/Recall-${version}-setup.exe`;

  // macOS 产物（可选，通过 MAC_SHA256 / MAC_FILENAME 环境变量传入）
  // 支持 universal（单一文件）或分架构（arm64/x64）两种打包模式
  const macSha256 = options.macSha256 ?? process.env.MAC_SHA256;
  const macFilename = options.macFilename ?? process.env.MAC_FILENAME;
  const macArm64Sha256 = options.macArm64Sha256 ?? process.env.MAC_ARM64_SHA256;
  const macArm64Filename = options.macArm64Filename ?? process.env.MAC_ARM64_FILENAME;
  const macX64Sha256 = options.macX64Sha256 ?? process.env.MAC_X64_SHA256;
  const macX64Filename = options.macX64Filename ?? process.env.MAC_X64_FILENAME;

  const manifest = {
    version,
    downloadUrl: winDownloadUrl,
    sha256: sha256.toLowerCase(),
    releaseNotes,
    publishedAt,
  };

  // 按 platforms 字段补充 mac 产物（新版客户端按 platform=darwin 读取）
  // 优先级：universal 单文件 > 分架构
  const platforms = {};
  platforms.win = { downloadUrl: winDownloadUrl, sha256: sha256.toLowerCase() };

  if (macSha256 && macFilename) {
    if (!SHA256_PATTERN.test(macSha256)) {
      throw new Error("macSha256 must contain exactly 64 hexadecimal characters");
    }
    platforms.mac = {
      downloadUrl: `/download/${macFilename}`,
      sha256: macSha256.toLowerCase(),
    };
  } else if (macArm64Sha256 || macArm64Filename || macX64Sha256 || macX64Filename) {
    if (!macArm64Sha256 || !macArm64Filename || !macX64Sha256 || !macX64Filename) {
      throw new Error("mac arm64 and x64 artifacts must provide both filename and sha256");
    }
    if (!SHA256_PATTERN.test(macArm64Sha256) || !SHA256_PATTERN.test(macX64Sha256)) {
      throw new Error("mac arm64 and x64 sha256 values must contain exactly 64 hexadecimal characters");
    }
    // mac 是旧客户端未携带 arch 时的兼容回退，默认使用 arm64。
    platforms.mac = {
      downloadUrl: `/download/${macArm64Filename}`,
      sha256: macArm64Sha256.toLowerCase(),
    };
    platforms.macArm64 = platforms.mac;
    platforms.macX64 = {
      downloadUrl: `/download/${macX64Filename}`,
      sha256: macX64Sha256.toLowerCase(),
    };
  }

  manifest.platforms = platforms;

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  try {
    const manifest = generateManifest();
    console.log(JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error(`Failed to generate manifest: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  generateManifest,
  validatePublishedAt,
  validateVersion,
};
