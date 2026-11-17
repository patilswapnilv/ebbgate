-- Wake claims expire, so a claim left behind by a crash is retried after restart.
ALTER TABLE deferred ADD COLUMN claimed_at TEXT;

-- Each deferred row carries its own wake idempotency key (one per deferral).
UPDATE deferred SET wake_idempotency_key = 'ebbgate-defer-' || run_id;
