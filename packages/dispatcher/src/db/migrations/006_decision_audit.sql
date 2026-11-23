-- Append-only audit log of routing and admission decisions, so every decision is
-- explainable after the fact ("why is this task waiting?").
--
-- Deliberately separate from `decisions` and `deferred`: no existing table changes.
-- Holds ids, codes and states only: never task payloads, prompts or secrets.
--   kind:        'route' (POST /run, recovery re-decisions) or 'admission' (POST /admit)
--   task_id:     the Paperclip run id; NULL for admission probes (no run context)
--   decision:    'local' | 'cloud' | 'defer' | 'admit' | 'refuse'
--   target:      node id, 'cloud', 'queue' or 'remote'
--   reason_code: stable machine code (REASON_CODES in @ebbgate/core)
--   rule_ref:    matched policy rule index, or 'default'
--   presence:    overall presence state the policy saw
-- Rows are never updated. Retention (age and row cap) deletes the oldest rows.
CREATE TABLE IF NOT EXISTS decision_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('route', 'admission')),
  task_id TEXT,
  agent_id TEXT,
  issue_id TEXT,
  environment_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('local', 'cloud', 'defer', 'admit', 'refuse')),
  target TEXT,
  tier TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_text TEXT NOT NULL,
  rule_ref TEXT NOT NULL,
  presence TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS decision_audit_task ON decision_audit (task_id, id);
CREATE INDEX IF NOT EXISTS decision_audit_decided_at ON decision_audit (decided_at);

CREATE TRIGGER IF NOT EXISTS decision_audit_append_only
BEFORE UPDATE ON decision_audit
BEGIN
  SELECT RAISE(ABORT, 'decision_audit is append-only');
END;
