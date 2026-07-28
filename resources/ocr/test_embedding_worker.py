# -*- coding: utf-8 -*-
from __future__ import annotations

import unittest
from pathlib import Path

from rapidocr_worker import BgeEmbeddingEngine, get_embedding_model_dir


class TestEmbeddingWorker(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        model_dir = get_embedding_model_dir()
        cls.engine = BgeEmbeddingEngine(model_dir=model_dir)

    def test_dimension_and_norm(self) -> None:
        texts = ["测试查询文本", "回声Recall桌面记忆助理"]
        vectors = self.engine.embed(texts, is_query=True)
        self.assertEqual(len(vectors), 2)
        for vec in vectors:
            self.assertEqual(len(vec), 512)
            # L2 norm should be ~1.0
            norm = sum(x * x for x in vec) ** 0.5
            self.assertAlmostEqual(norm, 1.0, places=4)

    def test_query_vs_document_prefix(self) -> None:
        text = "数据仓库与流处理争议"
        vec_query = self.engine.embed([text], is_query=True)[0]
        vec_doc = self.engine.embed([text], is_query=False)[0]
        self.assertEqual(len(vec_query), 512)
        self.assertEqual(len(vec_doc), 512)
        # Query prefix produces different vector representation than document
        self.assertNotEqual(vec_query, vec_doc)

    def test_batch_limit(self) -> None:
        excessive = [f"文本{i}" for i in range(35)]
        with self.assertRaises(ValueError):
            self.engine.embed(excessive)


if __name__ == "__main__":
    unittest.main()
