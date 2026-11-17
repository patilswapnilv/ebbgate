-- Durable dispatch tracking, so a restart can tell what happened to every run.
--   origin:              'ingress' (a Paperclip request waits on it) or
--                        'replacement' (created by recovery; nobody waits on it)
--   dispatched_at:       set immediately before the request to the runner is sent
--   interrupted_reason:  'node_offline' or 'dispatcher_restart'
ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'ingress';
ALTER TABLE runs ADD COLUMN dispatched_at TEXT;
ALTER TABLE runs ADD COLUMN interrupted_reason TEXT;

UPDATE runs SET origin = 'replacement' WHERE run_id LIKE '%:%';
UPDATE runs SET dispatched_at = started_at;
UPDATE runs SET interrupted_reason = 'node_offline' WHERE status = 'interrupted';
