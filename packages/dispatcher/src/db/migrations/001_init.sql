CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('available', 'busy', 'offline')),
  mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'busy', 'available')),
  last_seen_at TEXT,
  report_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  issue_id TEXT,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('local', 'cloud')),
  node_id TEXT,
  priority TEXT CHECK (priority IN ('normal', 'low')),
  status TEXT NOT NULL CHECK (status IN ('running', 'interrupted', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deferred (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  issue_id TEXT,
  agent_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'waking', 'done', 'expired')),
  wake_idempotency_key TEXT
);

CREATE INDEX IF NOT EXISTS deferred_pending_created ON deferred (status, created_at);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  issue_id TEXT,
  tier TEXT NOT NULL,
  action TEXT NOT NULL,
  node_id TEXT,
  reason TEXT NOT NULL,
  rule_ref TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
