# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


class VerificationError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_external_model(model_dir: Path) -> None:
    manifest_path = model_dir / "manifest.json"
    if not manifest_path.is_file():
        raise VerificationError(f"Model manifest is missing: {manifest_path}")

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"Cannot read model manifest: {exc}") from exc

    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise VerificationError("Model manifest does not declare any files")

    for relative_name, expected in files.items():
        if not isinstance(relative_name, str) or not isinstance(expected, dict):
            raise VerificationError("Model manifest has an invalid file entry")
        file_path = model_dir / relative_name
        if not file_path.is_file():
            raise VerificationError(f"Declared model file is missing: {file_path}")

        actual_size = file_path.stat().st_size
        expected_size = expected.get("size_bytes")
        if actual_size != expected_size:
            raise VerificationError(
                f"Model file size mismatch for {relative_name}: "
                f"expected {expected_size}, got {actual_size}"
            )

        actual_sha256 = sha256_file(file_path)
        expected_sha256 = expected.get("sha256")
        if actual_sha256 != expected_sha256:
            raise VerificationError(
                f"Model SHA-256 mismatch for {relative_name}: "
                f"expected {expected_sha256}, got {actual_sha256}"
            )

    for legal_file in ("LICENSE", "NOTICE"):
        legal_path = model_dir / legal_file
        if not legal_path.is_file() or legal_path.stat().st_size == 0:
            raise VerificationError(f"Model legal notice is missing or empty: {legal_path}")

    print(f"SUCCESS: External model manifest and legal notices verified: {model_dir}")


def assert_model_not_bundled(worker_dir: Path) -> None:
    bundled_models = list(worker_dir.rglob("model_quantized.onnx"))
    if bundled_models:
        raise VerificationError(
            f"Embedding model must remain external to the worker: {bundled_models[0]}"
        )
    print(f"SUCCESS: Worker contains no duplicate embedding model: {worker_dir}")


def verify_worker(cmd: list[str], label: str) -> None:
    print(f"Testing {label} with command: {cmd}")
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8"
    )

    req = {
        "id": "smoke-test-1",
        "type": "query",
        "texts": ["测试为这个句子生成表示", "数据仓库结算争议"]
    }

    stdin_data = json.dumps(req, ensure_ascii=False) + "\n"
    stdout_data, stderr_data = proc.communicate(input=stdin_data, timeout=15)

    if proc.returncode != 0:
        print(f"[{label}] Worker exited with code {proc.returncode}")
        print("STDERR:", stderr_data)
        raise VerificationError(f"[{label}] Worker exited with code {proc.returncode}: {stderr_data}")

    lines = [line.strip() for line in stdout_data.splitlines() if line.strip()]
    if not lines:
        print(f"[{label}] No output from worker")
        print("STDERR:", stderr_data)
        raise VerificationError(f"[{label}] No output from worker. STDERR: {stderr_data}")

    try:
        res = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise VerificationError(f"[{label}] Invalid JSON output: {lines[0]}") from exc
    if not res.get("available"):
        raise VerificationError(
            f"[{label}] Worker reported unavailable: {res.get('errorCode')}"
        )

    vectors = res.get("vectors", [])
    if len(vectors) != 2:
        print(f"[{label}] Expected 2 vectors, got {len(vectors)}")
        raise VerificationError(f"[{label}] Expected 2 vectors, got {len(vectors)}")

    for vec in vectors:
        if len(vec) != 512:
            print(f"[{label}] Expected dimension 512, got {len(vec)}")
            raise VerificationError(f"[{label}] Expected dimension 512, got {len(vec)}")
        norm = sum(x * x for x in vec) ** 0.5
        if abs(norm - 1.0) > 0.01:
            print(f"[{label}] L2 norm {norm} is not normalized")
            raise VerificationError(f"[{label}] L2 norm {norm} is not normalized")

    print(f"SUCCESS: [{label}] smoke test passed! Dimension: 512, Batch Count: {len(vectors)}, L2 Norm: ~1.0")

def main() -> None:
    parser = argparse.ArgumentParser(description="Verify embedding worker smoke test")
    parser.add_argument("--target", choices=["py", "exe", "auto"], default="auto")
    packaged_group = parser.add_mutually_exclusive_group()
    packaged_group.add_argument(
        "--win-unpacked",
        "--packaged-root",
        dest="packaged_root",
        type=Path,
        help="Path to an electron-builder win-unpacked directory",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent.parent
    py_worker = repo_root / "resources" / "ocr" / "rapidocr_worker.py"
    exe_name = "rapidocr-worker.exe" if sys.platform == "win32" else "rapidocr-worker"
    if args.packaged_root:
        packaged_root = args.packaged_root.resolve()
        resources_dir = packaged_root / "resources"
        exe_worker = resources_dir / "ocr" / "rapidocr-worker" / exe_name
        model_dir = resources_dir / "embedding" / "bge-small-zh-v1.5"
        worker_dir = exe_worker.parent
        if not packaged_root.is_dir():
            raise VerificationError(f"Packaged root does not exist: {packaged_root}")
    else:
        exe_worker = repo_root / "resources" / "ocr" / "rapidocr-worker" / exe_name
        model_dir = repo_root / "resources" / "embedding" / "bge-small-zh-v1.5"
        worker_dir = exe_worker.parent

    verify_external_model(model_dir)

    if args.target == "py" and args.packaged_root:
        raise VerificationError("--target py cannot be combined with a packaged root")

    if args.target == "py" or (args.target == "auto" and not args.packaged_root):
        cmd_py = [sys.executable, str(py_worker), "--mode", "embedding", "--model-dir", str(model_dir)]
        verify_worker(cmd_py, "Source Python Worker")

    if args.target in ("exe", "auto"):
        if exe_worker.exists():
            assert_model_not_bundled(worker_dir)
            cmd_exe = [str(exe_worker), "--mode", "embedding", "--model-dir", str(model_dir)]
            label = "Packaged PyInstaller EXE Worker" if args.packaged_root else "Built PyInstaller EXE Worker"
            verify_worker(cmd_exe, label)
        elif args.target == "exe":
            raise VerificationError(f"Worker executable does not exist: {exe_worker}")

if __name__ == "__main__":
    try:
        main()
    except (VerificationError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
