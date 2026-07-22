from __future__ import annotations

import contextlib
import gc
import json
import math
import os
import statistics
import sys
from dataclasses import dataclass
from difflib import SequenceMatcher
from importlib import metadata
from pathlib import Path
from typing import Any, Iterable, Sequence


ENGINE_NAME = "rapidocr"
MODEL_NAME = "PP-OCRv6-small"
MAX_NATIVE_SIDE = 2048
TILE_SIZE = 1024
TILE_OVERLAP = 96
TILE_SCALE = 1.5
STREAM_RESPONSE_MODE = "frame_stream_v1"
DEFAULT_ORT_INTRA_OP_THREADS = 2
DEFAULT_ORT_INTER_OP_THREADS = 1


def read_thread_limit(name: str, default: int) -> int:
    raw_value = os.environ.get(name, "").strip()
    try:
        value = int(raw_value) if raw_value else default
    except ValueError:
        value = default
    return max(1, min(value, max(1, os.cpu_count() or 1)))


ORT_INTRA_OP_THREADS = read_thread_limit(
    "RECALL_RAPIDOCR_INTRA_OP_THREADS",
    DEFAULT_ORT_INTRA_OP_THREADS,
)
ORT_INTER_OP_THREADS = read_thread_limit(
    "RECALL_RAPIDOCR_INTER_OP_THREADS",
    DEFAULT_ORT_INTER_OP_THREADS,
)
os.environ.setdefault("OMP_NUM_THREADS", str(ORT_INTRA_OP_THREADS))
os.environ.setdefault("OPENBLAS_NUM_THREADS", str(ORT_INTRA_OP_THREADS))


@dataclass(frozen=True)
class Detection:
    text: str
    confidence: float
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height


class RapidOcrEngine:
    def __init__(self) -> None:
        with contextlib.redirect_stdout(sys.stderr):
            from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR
            import cv2

            cv2.setNumThreads(1)
            params = build_engine_params(
                EngineType.ONNXRUNTIME,
                ModelType.SMALL,
                OCRVersion.PPOCRV6,
            )
            self.engine = RapidOCR(params=params)
            # RapidOCR 3.9.2 initializes the classifier even when use_cls is
            # false. This worker never enables it, so release its unused ONNX
            # session after initialization.
            classifier = getattr(self.engine, "text_cls", None)
            self.engine.text_cls = None
            del classifier
            gc.collect()

    def recognize_path(self, image_path: str) -> tuple[list[Detection], tuple[int, int]]:
        from PIL import Image

        with Image.open(image_path) as image:
            width, height = image.size
        detections = self._recognize(image_path)
        if should_use_tiles(width, height, detections):
            detections.extend(self._recognize_tiles(image_path, width, height))
        return merge_detections(detections), (width, height)

    def _recognize(self, image: Any) -> list[Detection]:
        with contextlib.redirect_stdout(sys.stderr):
            result = self.engine(image, use_cls=False, text_score=0.45)
        return output_to_detections(result)

    def _recognize_tiles(
        self,
        image_path: str,
        width: int,
        height: int,
    ) -> list[Detection]:
        import numpy as np
        from PIL import Image

        output: list[Detection] = []
        with Image.open(image_path) as raw_source:
            with raw_source.convert("RGB") as source:
                for left, top, right, bottom in generate_tiles(width, height):
                    with source.crop((left, top, right, bottom)) as tile:
                        scaled_width = max(1, round(tile.width * TILE_SCALE))
                        scaled_height = max(1, round(tile.height * TILE_SCALE))
                        with tile.resize(
                            (scaled_width, scaled_height),
                            Image.Resampling.LANCZOS,
                        ) as scaled_tile:
                            # RapidOCR consumes contiguous OpenCV-style BGR arrays.
                            array = np.asarray(scaled_tile)[:, :, ::-1].copy()
                    recognized = self._recognize(array)
                    del array
                    for item in recognized:
                        output.append(
                            Detection(
                                text=item.text,
                                confidence=item.confidence,
                                x=left + item.x / TILE_SCALE,
                                y=top + item.y / TILE_SCALE,
                                width=item.width / TILE_SCALE,
                                height=item.height / TILE_SCALE,
                            )
                        )
        return output


def build_engine_params(
    engine_type: Any,
    model_type: Any,
    ocr_version: Any,
    intra_op_threads: int = ORT_INTRA_OP_THREADS,
    inter_op_threads: int = ORT_INTER_OP_THREADS,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "Global.use_cls": False,
        "Global.text_score": 0.45,
        "Global.return_word_box": False,
        "Global.log_level": "warning",
        "EngineConfig.onnxruntime.intra_op_num_threads": intra_op_threads,
        "EngineConfig.onnxruntime.inter_op_num_threads": inter_op_threads,
        "EngineConfig.onnxruntime.enable_cpu_mem_arena": False,
        "EngineConfig.onnxruntime.cpu_ep_cfg.arena_extend_strategy": "kSameAsRequested",
        "Det.engine_type": engine_type,
        "Det.ocr_version": ocr_version,
        "Det.model_type": model_type,
        # PP-OCRv6 Small is one multilingual model. RapidOCR 3.9.2 resolves
        # that model through the supported "ch" route.
        "Det.lang_type": "ch",
        "Det.limit_type": "max",
        "Det.limit_side_len": MAX_NATIVE_SIDE,
        "Rec.engine_type": engine_type,
        "Rec.ocr_version": ocr_version,
        "Rec.model_type": model_type,
        "Rec.lang_type": "ch",
    }
    model_dir = os.environ.get("RECALL_RAPIDOCR_MODEL_DIR", "").strip()
    if model_dir:
        root = Path(model_dir)
        params["Det.model_path"] = str(root / "PP-OCRv6_det_small.onnx")
        params["Rec.model_path"] = str(root / "PP-OCRv6_rec_small.onnx")
    return params


_engine: RapidOcrEngine | None = None


def get_engine() -> RapidOcrEngine:
    global _engine
    if _engine is None:
        _engine = RapidOcrEngine()
    return _engine


def polygon_to_box(polygon: Sequence[Sequence[float]]) -> tuple[float, float, float, float]:
    xs = [float(point[0]) for point in polygon]
    ys = [float(point[1]) for point in polygon]
    if not xs or not ys:
        return 0.0, 0.0, 0.0, 0.0
    left = min(xs)
    top = min(ys)
    return left, top, max(xs) - left, max(ys) - top


def output_to_detections(result: Any) -> list[Detection]:
    boxes = list(result.boxes) if getattr(result, "boxes", None) is not None else []
    texts = list(result.txts) if getattr(result, "txts", None) is not None else []
    scores = list(result.scores) if getattr(result, "scores", None) is not None else []
    detections: list[Detection] = []
    for polygon, text, score in zip(boxes, texts, scores):
        cleaned = str(text).strip()
        if not cleaned:
            continue
        x, y, width, height = polygon_to_box(polygon)
        if width <= 0 or height <= 0:
            continue
        detections.append(
            Detection(
                text=cleaned,
                confidence=max(0.0, min(1.0, float(score))),
                x=x,
                y=y,
                width=width,
                height=height,
            )
        )
    return detections


def should_use_tiles(width: int, height: int, detections: Sequence[Detection]) -> bool:
    if max(width, height) < 1400:
        return False
    if not detections:
        return True
    mean_confidence = statistics.fmean(item.confidence for item in detections)
    median_height = statistics.median(item.height for item in detections)
    character_count = sum(len(item.text) for item in detections)
    return mean_confidence < 0.88 or median_height < 18 or character_count < 100


def generate_tiles(
    width: int,
    height: int,
    tile_size: int = TILE_SIZE,
    overlap: int = TILE_OVERLAP,
) -> list[tuple[int, int, int, int]]:
    x_positions = axis_positions(width, tile_size, overlap)
    y_positions = axis_positions(height, tile_size, overlap)
    single_x = len(x_positions) == 1
    single_y = len(y_positions) == 1
    return [
        (
            left,
            top,
            width if single_x else min(width, left + tile_size),
            height if single_y else min(height, top + tile_size),
        )
        for top in y_positions
        for left in x_positions
    ]


def axis_positions(length: int, tile_size: int, overlap: int) -> list[int]:
    if length <= round(tile_size * 1.2):
        return [0]
    step = max(1, tile_size - overlap)
    positions = list(range(0, max(1, length - tile_size + 1), step))
    final = max(0, length - tile_size)
    if not positions or positions[-1] != final:
        positions.append(final)
    return positions


def merge_detections(detections: Iterable[Detection]) -> list[Detection]:
    selected: list[Detection] = []
    for candidate in sorted(detections, key=lambda item: item.confidence, reverse=True):
        duplicate = False
        for existing in selected:
            overlap = intersection_over_union(candidate, existing)
            if overlap < 0.35:
                continue
            same_text = normalize_text(candidate.text) == normalize_text(existing.text)
            similar_text = SequenceMatcher(
                None,
                normalize_text(candidate.text),
                normalize_text(existing.text),
            ).ratio() >= 0.88
            if same_text or (overlap >= 0.65 and similar_text):
                duplicate = True
                break
        if not duplicate:
            selected.append(candidate)
    return sort_reading_order(selected)


def sort_reading_order(detections: Iterable[Detection]) -> list[Detection]:
    return sorted(detections, key=lambda item: (round(item.y / 8), item.x, item.y))


def intersection_over_union(left: Detection, right: Detection) -> float:
    intersection_width = max(0.0, min(left.right, right.right) - max(left.x, right.x))
    intersection_height = max(0.0, min(left.bottom, right.bottom) - max(left.y, right.y))
    intersection = intersection_width * intersection_height
    if intersection <= 0:
        return 0.0
    union = left.width * left.height + right.width * right.height - intersection
    return intersection / union if union > 0 else 0.0


def normalize_text(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def detection_to_block(item: Detection, index: int) -> dict[str, Any]:
    return {
        "id": f"line_{index + 1}",
        "text": item.text,
        "boundingBox": {
            "x": round(item.x, 2),
            "y": round(item.y, 2),
            "width": round(item.width, 2),
            "height": round(item.height, 2),
        },
        "words": [],
        "confidence": round(item.confidence, 6),
    }


def recognize_frame(engine: RapidOcrEngine, image_path: str, frame_index: int) -> dict[str, Any]:
    try:
        if not image_path or not Path(image_path).is_file():
            raise FileNotFoundError
        detections, _size = engine.recognize_path(image_path)
        lines = [item.text for item in detections]
        return {
            "frameIndex": frame_index,
            "text": "\n".join(lines),
            "lines": lines,
            "blocks": [detection_to_block(item, index) for index, item in enumerate(detections)],
            "language": "multi",
        }
    except FileNotFoundError:
        return empty_frame(frame_index, "rapidocr_image_not_found")
    except Exception:
        return empty_frame(frame_index, "rapidocr_frame_failed")


def empty_frame(frame_index: int, error_code: str) -> dict[str, Any]:
    return {
        "frameIndex": frame_index,
        "text": "",
        "lines": [],
        "blocks": [],
        "language": "multi",
        "errorCode": error_code,
    }


def handle_request(request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    image_paths = request.get("imagePaths")
    if not isinstance(request_id, str) or not isinstance(image_paths, list):
        return {
            "id": request_id if isinstance(request_id, str) else "",
            "available": False,
            "errorCode": "rapidocr_invalid_request",
            "frames": [],
        }
    try:
        engine = get_engine()
        version = metadata.version("rapidocr")
    except Exception:
        return {
            "id": request_id,
            "available": False,
            "errorCode": "rapidocr_initialization_failed",
            "frames": [],
        }
    return {
        "id": request_id,
        "available": True,
        "engine": ENGINE_NAME,
        "model": MODEL_NAME,
        "engineVersion": version,
        "frames": [
            recognize_frame(engine, str(image_path), index + 1)
            for index, image_path in enumerate(image_paths)
        ],
    }


def stream_request(request: dict[str, Any]) -> Iterable[dict[str, Any]]:
    request_id = request.get("id")
    image_paths = request.get("imagePaths")
    if not isinstance(request_id, str) or not isinstance(image_paths, list):
        yield {
            "id": request_id if isinstance(request_id, str) else "",
            "type": "complete",
            "available": False,
            "errorCode": "rapidocr_invalid_request",
            "frameCount": 0,
        }
        return
    try:
        engine = get_engine()
        version = metadata.version("rapidocr")
    except Exception:
        yield {
            "id": request_id,
            "type": "complete",
            "available": False,
            "errorCode": "rapidocr_initialization_failed",
            "frameCount": len(image_paths),
        }
        return

    response_metadata = {
        "id": request_id,
        "available": True,
        "engine": ENGINE_NAME,
        "model": MODEL_NAME,
        "engineVersion": version,
    }
    for index, image_path in enumerate(image_paths):
        yield {
            **response_metadata,
            "type": "frame",
            "frame": recognize_frame(engine, str(image_path), index + 1),
        }
    yield {
        **response_metadata,
        "type": "complete",
        "frameCount": len(image_paths),
    }


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for raw_line in sys.stdin:
        try:
            request = json.loads(raw_line)
            if not isinstance(request, dict):
                raise ValueError
            responses = (
                stream_request(request)
                if request.get("responseMode") == STREAM_RESPONSE_MODE
                else [handle_request(request)]
            )
        except Exception:
            responses = [{
                "id": "",
                "available": False,
                "errorCode": "rapidocr_invalid_json",
                "frames": [],
            }]
        for response in responses:
            print(
                json.dumps(response, ensure_ascii=False, separators=(",", ":")),
                flush=True,
            )


if __name__ == "__main__":
    main()
