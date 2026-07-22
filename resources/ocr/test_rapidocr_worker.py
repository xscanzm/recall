import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("rapidocr_worker.py")
SPEC = importlib.util.spec_from_file_location("rapidocr_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)


class RapidOcrWorkerTests(unittest.TestCase):
    def test_engine_params_limit_onnx_threads_and_memory_arena(self):
        params = worker.build_engine_params("ort", "small", "v6")
        self.assertEqual(params["EngineConfig.onnxruntime.intra_op_num_threads"], 2)
        self.assertEqual(params["EngineConfig.onnxruntime.inter_op_num_threads"], 1)
        self.assertFalse(params["EngineConfig.onnxruntime.enable_cpu_mem_arena"])

    def test_polygon_to_axis_aligned_box(self):
        self.assertEqual(
            worker.polygon_to_box([[10, 20], [50, 18], [52, 40], [8, 42]]),
            (8.0, 18.0, 44.0, 24.0),
        )

    def test_adaptive_tiles_target_large_sparse_or_small_text_screens(self):
        confident_large_text = [worker.Detection("large desktop text", 0.98, 0, 0, 100, 30)] * 10
        small_text = [worker.Detection("small", 0.95, 0, 0, 100, 12)] * 10
        self.assertFalse(worker.should_use_tiles(1366, 768, small_text))
        self.assertFalse(worker.should_use_tiles(1920, 1080, confident_large_text))
        self.assertTrue(worker.should_use_tiles(1920, 1080, small_text))
        self.assertTrue(worker.should_use_tiles(1920, 1080, []))

    def test_tiles_cover_the_screen_with_overlap_without_small_edge_tiles(self):
        tiles = worker.generate_tiles(1920, 1080)
        self.assertEqual(tiles, [(0, 0, 1024, 1080), (896, 0, 1920, 1080)])

    def test_merge_prefers_high_confidence_duplicate_and_keeps_distinct_text(self):
        detections = [
            worker.Detection("Recall", 0.80, 10, 10, 100, 20),
            worker.Detection("Recall", 0.96, 12, 10, 100, 20),
            worker.Detection("Report", 0.90, 12, 10, 100, 20),
        ]
        merged = worker.merge_detections(detections)
        self.assertEqual([(item.text, item.confidence) for item in merged], [
            ("Recall", 0.96),
            ("Report", 0.90),
        ])

    def test_block_keeps_original_coordinates_and_confidence(self):
        block = worker.detection_to_block(
            worker.Detection("中英 OCR", 0.91234567, 1.234, 2.345, 30.456, 12.789),
            0,
        )
        self.assertEqual(block["id"], "line_1")
        self.assertEqual(block["text"], "中英 OCR")
        self.assertEqual(block["boundingBox"], {
            "x": 1.23,
            "y": 2.35,
            "width": 30.46,
            "height": 12.79,
        })
        self.assertEqual(block["confidence"], 0.912346)

    def test_stream_request_emits_each_frame_before_complete(self):
        frames = [
            {"frameIndex": 1, "text": "one", "lines": ["one"], "blocks": []},
            {"frameIndex": 2, "text": "two", "lines": ["two"], "blocks": []},
        ]
        with (
            mock.patch.object(worker, "get_engine", return_value=object()),
            mock.patch.object(worker.metadata, "version", return_value="3.9.2"),
            mock.patch.object(worker, "recognize_frame", side_effect=frames),
        ):
            responses = list(worker.stream_request({
                "id": "request-1",
                "responseMode": "frame_stream_v1",
                "imagePaths": ["one.png", "two.png"],
            }))

        self.assertEqual([response["type"] for response in responses], [
            "frame",
            "frame",
            "complete",
        ])
        self.assertEqual([response["frame"]["frameIndex"] for response in responses[:2]], [1, 2])
        self.assertTrue(responses[-1]["available"])

    def test_legacy_request_still_returns_one_batch_response(self):
        frame = {"frameIndex": 1, "text": "one", "lines": ["one"], "blocks": []}
        with (
            mock.patch.object(worker, "get_engine", return_value=object()),
            mock.patch.object(worker.metadata, "version", return_value="3.9.2"),
            mock.patch.object(worker, "recognize_frame", return_value=frame),
        ):
            response = worker.handle_request({"id": "legacy", "imagePaths": ["one.png"]})

        self.assertNotIn("type", response)
        self.assertEqual(response["frames"], [frame])


if __name__ == "__main__":
    unittest.main()
