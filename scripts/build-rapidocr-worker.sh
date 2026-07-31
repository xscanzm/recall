#!/usr/bin/env bash
set -e

# ==========================================================
#  RapidOCR macOS / Linux Worker PyInstaller 打包脚本
# ==========================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OCR_ROOT="${REPO_ROOT}/resources/ocr"
WORKER_SOURCE="${OCR_ROOT}/rapidocr_worker.py"
REQUIREMENTS="${OCR_ROOT}/requirements-build.txt"
OUTPUT_DIR="${OCR_ROOT}/rapidocr-worker"
TEMP_BASE="${REPO_ROOT}/build/ocr-worker"
TEMP_ROOT="${TEMP_BASE}/recall-rapidocr-build-$(date +%s)"

PYTHON_CMD="${PYTHON_EXECUTABLE:-python3}"

echo "[rapidocr] 开始构建 macOS / Linux 平台 RapidOCR Worker..."
mkdir -p "${TEMP_ROOT}"

VENV_ROOT="${TEMP_ROOT}/.venv"
"${PYTHON_CMD}" -m venv "${VENV_ROOT}"
VENV_PYTHON="${VENV_ROOT}/bin/python"

"${VENV_PYTHON}" -m pip install --disable-pip-version-check -r "${REQUIREMENTS}"

WORK_PATH="${TEMP_ROOT}/work"
SPEC_PATH="${TEMP_ROOT}/spec"
DIST_PATH="${TEMP_ROOT}/dist"

"${VENV_PYTHON}" -m PyInstaller \
  --noconfirm \
  --clean \
  --onedir \
  --console \
  --noupx \
  --name "rapidocr-worker" \
  --collect-all "rapidocr" \
  --collect-all "tokenizers" \
  --copy-metadata "rapidocr" \
  --copy-metadata "tokenizers" \
  --copy-metadata "onnxruntime" \
  --hidden-import "onnxruntime.capi._pybind_state" \
  --exclude-module "tkinter" \
  --exclude-module "unittest" \
  --exclude-module "pydoc" \
  --exclude-module "doctest" \
  --exclude-module "pdb" \
  --exclude-module "matplotlib" \
  --exclude-module "pytest" \
  --exclude-module "setuptools" \
  --exclude-module "pip" \
  --workpath "${WORK_PATH}" \
  --specpath "${SPEC_PATH}" \
  --distpath "${DIST_PATH}" \
  "${WORKER_SOURCE}"

BUILT_WORKER_DIR="${DIST_PATH}/rapidocr-worker"
if [ ! -d "${BUILT_WORKER_DIR}" ]; then
    echo "❌ PyInstaller 构建输出缺失！"
    exit 1
fi

rm -rf "${OUTPUT_DIR}"
cp -R "${BUILT_WORKER_DIR}" "${OUTPUT_DIR}"
rm -rf "${TEMP_ROOT}"

# ==========================================================
#  macOS ad-hoc 签名（Apple Silicon 必须，与开发者账号无关）
#
#  未签名的二进制在 arm64 上会被 dyld 拒绝加载（不是 Gatekeeper，
#  是更底层的 AMFI 限制），即使内测用户右键打开也跑不起来。
#  ad-hoc 签名（-s -）不需要任何证书，仅给二进制一个身份让 dyld 放行。
#  Linux 上 codesign 不存在，跳过。
# ==========================================================
if [ "$(uname)" = "Darwin" ]; then
  echo "[rapidocr] 对 worker 及其所有动态库执行 ad-hoc 签名..."
  # --deep 递归签名 .dylib / .so / 框架；--force 覆盖 PyInstaller 可能已打的占位签名
  codesign --force --deep --sign - "${OUTPUT_DIR}" 2>/dev/null || {
    echo "⚠️  codesign --deep 失败，尝试只签主二进制"
    codesign --force --sign - "${OUTPUT_DIR}/rapidocr-worker" 2>/dev/null || echo "⚠️  ad-hoc 签名失败，arm64 Mac 可能无法运行"
  }
  # 验证签名
  if codesign --verify "${OUTPUT_DIR}/rapidocr-worker" 2>/dev/null; then
    echo "✅ ad-hoc 签名验证通过"
  else
    echo "⚠️  ad-hoc 签名验证失败"
  fi
fi

echo "✅ [rapidocr] macOS / Linux RapidOCR Worker 构建成功：${OUTPUT_DIR}"
