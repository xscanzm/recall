-- 030_timeline_blocks_date_key_start_at.sql
-- 复合索引：时间轴片段按 date_key 相等 + start_at 范围查询（findOverlapping）。
-- 单一 date_key 索引只能过滤 date_key，start_at 范围需回表过滤；
-- 复合索引 (date_key, start_at) 让两个条件在一次索引扫描内完成。

CREATE INDEX IF NOT EXISTS idx_timeline_blocks_date_key_start_at
  ON timeline_blocks(date_key, start_at);
