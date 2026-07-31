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

echo "✅ [rapidocr] macOS / Linux RapidOCR Worker 构建成功：${OUTPUT_DIR}"
