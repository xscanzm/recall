import os
import shutil
import hashlib
import json
from huggingface_hub import hf_hub_download

REPO_ID = "xenova/bge-small-zh-v1.5"
REVISION = "75c43b069aac4d136ba6bc1122f995fedcfd2781"
DEST_DIR = os.path.join(os.path.dirname(__file__), "..", "resources", "embedding", "bge-small-zh-v1.5")
os.makedirs(DEST_DIR, exist_ok=True)

FILES = {
    "onnx/model_quantized.onnx": "model_quantized.onnx",
    "tokenizer.json": "tokenizer.json",
    "tokenizer_config.json": "tokenizer_config.json",
    "special_tokens_map.json": "special_tokens_map.json",
    "vocab.txt": "vocab.txt",
    "config.json": "config.json",
}

manifest_files = {}

for remote_path, local_name in FILES.items():
    src_path = hf_hub_download(repo_id=REPO_ID, filename=remote_path, revision=REVISION)
    dest_path = os.path.join(DEST_DIR, local_name)
    shutil.copy2(src_path, dest_path)
    
    with open(dest_path, "rb") as f:
        sha256 = hashlib.sha256(f.read()).hexdigest()
    
    manifest_files[local_name] = {
        "sha256": sha256,
        "size_bytes": os.path.getsize(dest_path)
    }

manifest = {
    "model_name": "bge-small-zh-v1.5",
    "source_repo": REPO_ID,
    "revision": REVISION,
    "license": "MIT",
    "dimension": 512,
    "max_tokens": 512,
    "query_prefix": "为这个句子生成表示以用于检索相关文章：",
    "files": manifest_files
}

manifest_path = os.path.join(DEST_DIR, "manifest.json")
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)

print("Downloaded and created manifest successfully:")
print(json.dumps(manifest, indent=2, ensure_ascii=False))
