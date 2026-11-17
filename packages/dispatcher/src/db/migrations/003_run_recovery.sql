-- An interrupted run is recovered when its re-decision (a deferred row or a
-- replacement run) has been written. Runs with recovered_at IS NULL are picked
-- up again at startup, so a crash mid-recovery cannot lose them.
ALTER TABLE runs ADD COLUMN recovered_at TEXT;

-- Interruptions recorded before this migration were handled inline by the
-- previous version; do not replay them.
UPDATE runs SET recovered_at = finished_at WHERE status = 'interrupted';
