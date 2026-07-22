CREATE TABLE IF NOT EXISTS model_daily_stats (
  date TEXT PRIMARY KEY NOT NULL,
  total_calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  language_calls INTEGER NOT NULL DEFAULT 0,
  multimodal_calls INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS model_daily_tasks (
  date TEXT NOT NULL,
  task TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, task)
);

CREATE TABLE IF NOT EXISTS model_daily_installations (
  date TEXT NOT NULL,
  installation_hash TEXT NOT NULL,
  PRIMARY KEY (date, installation_hash)
);

CREATE TABLE IF NOT EXISTS model_installations (
  installation_hash TEXT PRIMARY KEY NOT NULL,
  total_calls INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  language_calls INTEGER NOT NULL DEFAULT 0,
  multimodal_calls INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  client_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_installation_tasks (
  installation_hash TEXT NOT NULL,
  task TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (installation_hash, task)
);
