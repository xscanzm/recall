param(
  [string]$PythonExecutable = "python",
  [switch]$KeepBuildDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$ocrRoot = Join-Path $repoRoot "resources\ocr"
$workerSource = Join-Path $ocrRoot "rapidocr_worker.py"
$requirements = Join-Path $ocrRoot "requirements-build.txt"
$outputDir = Join-Path $ocrRoot "rapidocr-worker"
$legacyOutputPath = Join-Path $ocrRoot "rapidocr-worker.exe"
$tempBase = [IO.Path]::GetFullPath((Join-Path $repoRoot "build\ocr-worker"))
$tempRoot = Join-Path $tempBase ("recall-rapidocr-build-" + [Guid]::NewGuid().ToString("N"))
$tempRoot = [IO.Path]::GetFullPath($tempRoot)

if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create OCR build directory outside the system temp directory."
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:PYINSTALLER_CONFIG_DIR = Join-Path $tempRoot "pyinstaller-cache"

try {
  $venvRoot = Join-Path $tempRoot ".venv"
  & $PythonExecutable -m venv $venvRoot
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the OCR build virtual environment." }

  $venvPython = Join-Path $venvRoot "Scripts\python.exe"
  & $venvPython -m pip install --disable-pip-version-check -r $requirements
  if ($LASTEXITCODE -ne 0) { throw "Failed to install pinned OCR build dependencies." }

  $workPath = Join-Path $tempRoot "work"
  $specPath = Join-Path $tempRoot "spec"
  $distPath = Join-Path $tempRoot "dist"
  & $venvPython -m PyInstaller `
    --noconfirm `
    --clean `
    --onedir `
    --console `
    --noupx `
    --name "rapidocr-worker" `
    --collect-all "rapidocr" `
    --collect-all "tokenizers" `
    --copy-metadata "rapidocr" `
    --copy-metadata "tokenizers" `
    --copy-metadata "onnxruntime" `
    --hidden-import "onnxruntime.capi._pybind_state" `
    --exclude-module "tkinter" `
    --exclude-module "unittest" `
    --exclude-module "pydoc" `
    --exclude-module "doctest" `
    --exclude-module "pdb" `
    --exclude-module "matplotlib" `
    --exclude-module "pytest" `
    --exclude-module "setuptools" `
    --exclude-module "pip" `
    --workpath $workPath `
    --specpath $specPath `
    --distpath $distPath `
    $workerSource
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed to build the RapidOCR worker." }

  $builtWorkerDir = Join-Path $distPath "rapidocr-worker"
  $builtWorker = Join-Path $builtWorkerDir "rapidocr-worker.exe"
  if (-not (Test-Path -LiteralPath $builtWorker -PathType Leaf)) {
    throw "RapidOCR worker output is missing."
  }

  $bundledEmbeddingModel = [IO.Directory]::EnumerateFiles(
    $builtWorkerDir,
    "model_quantized.onnx",
    [IO.SearchOption]::AllDirectories
  ) | Select-Object -First 1
  if ($bundledEmbeddingModel) {
    throw "Embedding model must remain external to the worker: $bundledEmbeddingModel"
  }

  # OpenCV 的视频 I/O 后端：约 30 MB，纯粹用于解码视频流。
  # 我们只对单张静态截图做 OCR，cv2 在这条路径上不会碰 videoio。
  # headless 轮子仍然带着它，所以在这里显式删掉。
  # 注意：requests / tqdm / certifi / urllib3 不能排除——rapidocr 的
  # utils/load_image.py 和 utils/download_file.py 在模块顶层 import 它们，
  # 而这两个模块在主路径上（rapidocr/main.py、onnxruntime 引擎）就会被导入，
  # 排掉会让 worker 一启动就 ImportError。
  Get-ChildItem -LiteralPath (Join-Path $builtWorkerDir "_internal\cv2") -Filter "opencv_videoio_ffmpeg*.dll" -File -ErrorAction SilentlyContinue |
    ForEach-Object {
      $removedMb = [Math]::Round($_.Length / 1MB, 1)
      Remove-Item -LiteralPath $_.FullName -Force
      Write-Host "[rapidocr] Removed unused video backend $($_.Name) ($removedMb MB)"
    }

  if (Test-Path -LiteralPath $outputDir) {
    Remove-Item -LiteralPath $outputDir -Recurse -Force
  }
  Copy-Item -LiteralPath $builtWorkerDir -Destination $outputDir -Recurse -Force
  if (Test-Path -LiteralPath $legacyOutputPath -PathType Leaf) {
    Remove-Item -LiteralPath $legacyOutputPath -Force
  }
  $outputExecutable = Join-Path $outputDir "rapidocr-worker.exe"
  $sizeMb = [Math]::Round((Get-ChildItem -LiteralPath $outputDir -File -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputExecutable).Hash.ToLowerInvariant()
  Write-Host "[rapidocr] Built resources\ocr\rapidocr-worker\ ($sizeMb MB, EXE SHA256 $sha256)"
}
finally {
  if ($KeepBuildDirectory) {
    Write-Host "[rapidocr] Kept build directory: $tempRoot"
  }
  elseif (Test-Path -LiteralPath $tempRoot) {
    if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove OCR build directory outside the system temp directory."
    }
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
