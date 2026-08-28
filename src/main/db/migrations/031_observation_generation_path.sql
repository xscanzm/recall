-- L0 观察溯源：记录 observation 的生成路径
-- - vision_model:v1   视觉多模态模型生成（默认路径）
-- - ocr_fallback:v1   视觉链路降级时由本地 OCR + 窗口元数据生成
-- - vision_backfill:v1（阶段 2 预留）视觉恢复后回填重跑生成
-- 历史行为 NULL（均由视觉模型生成的时代）。
ALTER TABLE observations ADD COLUMN generation_path TEXT;

CREATE INDEX idx_observations_generation_path
  ON observations(generation_path)
  WHERE generation_path IS NOT NULL;
