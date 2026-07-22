-- Persist provider usage and request-level diagnostics for model jobs.
-- Values remain NULL when the provider does not report them.

ALTER TABLE model_jobs ADD COLUMN prompt_tokens INTEGER;
ALTER TABLE model_jobs ADD COLUMN completion_tokens INTEGER;
ALTER TABLE model_jobs ADD COLUMN cached_prompt_tokens INTEGER;
ALTER TABLE model_jobs ADD COLUMN request_count INTEGER;
ALTER TABLE model_jobs ADD COLUMN latency_ms INTEGER;
