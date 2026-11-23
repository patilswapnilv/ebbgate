-- Durable deferred queue: leases, bounded retries with backoff, a dead-letter
-- state, per-task expiry and a recorded terminal reason for every row.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt
-- (the documented 12-step pattern; nothing references `deferred` by key).
--
--   wake_idempotency_key  one key per task, now NOT NULL and UNIQUE; reused on every retry
--   lease_owner           dispatcher instance holding the `waking` claim
--   lease_expires_at      claim is reclaimable after this instant (crash recovery)
--   attempts              wakes claimed so far (incremented when a claim is taken)
--   next_attempt_at       earliest time of the next attempt (backoff); NULL = now
--   last_error            most recent wake failure
--   expires_at            per-task TTL; NULL = created_at + presence.deferredMaxAgeHours
--   terminal_reason       why the row reached done / expired / dead
--   finished_at           when it reached that terminal state
CREATE TABLE deferred_v5 (
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
    CHECK (status IN ('pending', 'waking', 'done', 'expired', 'dead')),
  wake_idempotency_key TEXT NOT NULL,
  claimed_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  expires_at TEXT,
  terminal_reason TEXT,
  finished_at TEXT
);

INSERT INTO deferred_v5 (
  id, run_id, issue_id, agent_id, company_id, tier, reason, payload_json, created_at,
  status, wake_idempotency_key, claimed_at, terminal_reason
)
SELECT
  id, run_id, issue_id, agent_id, company_id, tier, reason, payload_json, created_at,
  status, COALESCE(wake_idempotency_key, 'ebbgate-defer-' || run_id), claimed_at,
  CASE status
    WHEN 'done' THEN 'woken (recorded before migration 005)'
    WHEN 'expired' THEN 'expired (recorded before migration 005)'
  END
FROM deferred;

DROP TABLE deferred;
ALTER TABLE deferred_v5 RENAME TO deferred;

CREATE INDEX deferred_pending_created ON deferred (status, created_at);
CREATE INDEX deferred_status_lease ON deferred (status, lease_expires_at);
CREATE UNIQUE INDEX deferred_wake_idempotency_key ON deferred (wake_idempotency_key);
