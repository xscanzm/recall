-- 015_memory_edges.sql
-- 记忆系统重构基础设施：轻量关系层
--
-- memory_edges 不是新的 L4，而是贯穿 Capture/L0/L1/L2/L3/Report 的关系账本。
-- 第一版只建表和索引，不接管现有 pipeline。

CREATE TABLE memory_edges (
  id TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL DEFAULT 'system',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_memory_edges_from ON memory_edges(from_type, from_id);
CREATE INDEX idx_memory_edges_to ON memory_edges(to_type, to_id);
CREATE INDEX idx_memory_edges_relation ON memory_edges(relation_type, status);
