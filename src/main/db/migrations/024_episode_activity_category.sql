-- Persist activity semantics on rule-built Episodes (stored in scenes).
-- Existing history intentionally stays unknown; new batches are classified by Episode+Fact extraction.

ALTER TABLE scenes ADD COLUMN activity_category TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE scenes ADD COLUMN activity_confidence REAL NOT NULL DEFAULT 0;
