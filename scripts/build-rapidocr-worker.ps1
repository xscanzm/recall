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
    --copy-metadata "rapidocr" `
    --copy-metadata "onnxruntime" `
    --hidden-import "onnxruntime.capi._pybind_state" `
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
