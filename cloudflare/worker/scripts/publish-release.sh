#!/usr/bin/env bash
# Recall 新版本发布脚本
# 用法：
#   ./scripts/publish-release.sh <version> <installerPath> <releaseNotesPath>
# 例：
#   ./scripts/publish-release.sh 0.1.2 ./Recall-0.1.2-setup.exe ./release-notes.md
#
# 在 Git Bash / WSL 下运行。
set -euo pipefail

# ─── 1. 校验参数 ─────────────────────────────────────────────
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <version> <installerPath> <releaseNotesPath>" >&2
  echo "例: $0 0.1.2 ./Recall-0.1.2-setup.exe ./release-notes.md" >&2
  exit 1
fi

VERSION="$1"
INSTALLER_PATH="$2"
RELEASE_NOTES_PATH="$3"

# 简单校验版本号格式（x.y.z）
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "错误：版本号格式不正确，应为 x.y.z，当前为 '$VERSION'" >&2
  exit 1
fi

if [ ! -f "$INSTALLER_PATH" ]; then
  echo "错误：安装包文件不存在：$INSTALLER_PATH" >&2
  exit 1
fi

if [ ! -f "$RELEASE_NOTES_PATH" ]; then
  echo "错误：更新日志文件不存在：$RELEASE_NOTES_PATH" >&2
  exit 1
fi

# R2 中安装包的 key 与下载文件名
FILENAME="Recall-${VERSION}-setup.exe"
DOWNLOAD_URL="/download/${FILENAME}"
BUCKET="recall-releases"

# 脚本所在目录的上级即为项目根
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ─── 2. 计算 SHA256 ──────────────────────────────────────────
# 优先用 shasum（Git Bash / WSL / macOS 均有）
SHA256=""
if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$INSTALLER_PATH" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$INSTALLER_PATH" | awk '{print $1}')"
elif command -v certutil >/dev/null 2>&1; then
  # Windows certutil 兜底
  # 输出形如：SHA256 of file.exe:\n<hash>\n  CertUtil: -hashfile command completed successfully.
  SHA256="$(certutil -hashfile "$INSTALLER_PATH" SHA256 | sed -n '2p' | tr -d ' ')"
else
  echo "错误：未找到 shasum / sha256sum / certutil 工具用于计算 SHA256" >&2
  exit 1
fi

# 转为小写
SHA256="$(echo "$SHA256" | tr '[:upper:]' '[:lower:]')"
if [ -z "$SHA256" ]; then
  echo "错误：SHA256 计算失败" >&2
  exit 1
fi
echo "✓ SHA256: $SHA256"

# ─── 3. 上传安装包到 R2 ────────────────────────────────────────
echo "→ 上传安装包到 R2: ${BUCKET}/${FILENAME}"
npx wrangler r2 object put "${BUCKET}/${FILENAME}" --file="${INSTALLER_PATH}"
echo "✓ 安装包已上传"

# ─── 4. 生成 manifest.json 临时文件 ──────────────────────────
RELEASE_NOTES="$(cat "$RELEASE_NOTES_PATH")"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMP_MANIFEST="${PROJECT_ROOT}/manifest.tmp.json"

# 用 node 安全转义 JSON，避免手写转义出错
node -e '
  const fs = require("fs");
  const data = {
    version: process.env.RECALL_VERSION,
    downloadUrl: process.env.RECALL_DOWNLOAD_URL,
    sha256: process.env.RECALL_SHA256,
    releaseNotes: fs.readFileSync(process.env.RECALL_NOTES_PATH, "utf8"),
    publishedAt: process.env.RECALL_PUBLISHED_AT
  };
  fs.writeFileSync(process.argv[1], JSON.stringify(data, null, 2) + "\n");
' "$TMP_MANIFEST"

echo "✓ 已生成临时 manifest.json："
cat "$TMP_MANIFEST"

# ─── 5. 上传 manifest.json 到 R2 ───────────────────────────────
echo "→ 上传 manifest.json 到 R2: ${BUCKET}/manifest.json"
npx wrangler r2 object put "${BUCKET}/manifest.json" --file="${TMP_MANIFEST}"
echo "✓ manifest 已上传"

# ─── 6. 输出成功提示 ───────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "  发布成功！版本：$VERSION"
echo "──────────────────────────────────────────────"
echo "  downloadUrl:    $DOWNLOAD_URL"
echo "  sha256:         $SHA256"
echo "  publishedAt:    $PUBLISHED_AT"
echo "════════════════════════════════════════════"
echo ""
echo "请将以下完整下载 URL 提供给客户端使用："
echo "  （部署后 Worker 域名）${DOWNLOAD_URL}"
