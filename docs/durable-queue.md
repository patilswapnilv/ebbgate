# The durable defer queue

Ebbgate's promise is that a private task never leaves your machine and never silently disappears. When no local node can take a task, Ebbgate stores it in SQLite (`deferred` table) before answering Paperclip. This page covers what happens after that.

## Lifecycle

```
pending --claim--> waking --wake ok------------------> done      (terminal_reason: woken)
   ^                  |
   |  wake failed,    |  attempts >= queue.maxAttempts
   |  lease expired   +----------------------------------> dead      (terminal_reason: last error)
   +------------------+
pending --past its TTL--------------------------------> expired   (terminal_reason: which TTL)
```

`done`, `expired` and `dead` are terminal. Every terminal row records `terminal_reason` and `finished_at`, so `SELECT run_id, status, terminal_reason FROM deferred` always explains where a task went.

Draining a row only asks Paperclip to **wake the agent**. The run Paperclip then sends goes through the policy engine again. No queue transition (retry, expiry, dead-letter, crash recovery) routes a task anywhere, so a private task can wait, expire or be dead-lettered, but it never falls back to the cloud.

## Guarantees

| Failure                                                                  | What happens                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatcher killed while a wake is in flight                              | The row stays `waking` with a lease (`lease_owner`, `lease_expires_at`). On the next start, `reconcileAfterRestart()` hands every claim held by another (dead) process back to `pending`, and the next drain re-sends it. While running, any claim whose lease runs out (`queue.leaseSeconds`) is reclaimed the same way.                                                     |
| Killed after Paperclip accepted the wake but before success was recorded | The wake is re-sent with the **same** `Idempotency-Key` (`ebbgate-defer-<runId>`, one per task, stored with the row and unique). Delivery is at-least-once; Paperclip deduplicates by key.                                                                                                                                                                                    |
| Two drains at once (same process, or two connections to one file)        | Each row is claimed with a conditional `pending → waking` update, so only one drainer ever wakes it.                                                                                                                                                                                                                                                                          |
| Paperclip re-sends a run Ebbgate already holds                           | `/run` answers from stored state: `202 {duplicate: true}` while it is queued, `409` once it is done, expired, dead, running or completed. A run that previously `failed` (for example after a dispatcher restart) is retried in place. Nothing is queued or dispatched twice.                                                                                                 |
| Paperclip is down when the node returns                                  | Each claim counts an attempt. A failed wake goes back to `pending` with exponential backoff (`retryBaseSeconds × 2^(attempt−1)`, capped at `retryMaxSeconds`). After `maxAttempts` the row is `dead` with the last error as its reason, and a `deferred_dead` notification is sent. A wake that hangs every time is dead-lettered the same way when its lease keeps expiring. |
| A task waits too long                                                    | Each task has an expiry: the agent's `deferTtlHours`, or `presence.deferredMaxAgeHours` by default. Past it, the row becomes `expired` (with a `deferred_expired` notification). It is not re-routed.                                                                                                                                                                         |
| Graceful shutdown (`SIGTERM` / `SIGINT`)                                 | The ticker and new connections stop, in-flight drains and requests get `queue.shutdownGraceSeconds` to finish, claims still held are returned to `pending`, then the database is closed.                                                                                                                                                                                      |
| Power loss                                                               | SQLite runs in WAL mode with `synchronous = FULL`, so a deferral acknowledged to Paperclip is on disk. `busy_timeout = 5000` lets a second connection wait for the lock instead of failing.                                                                                                                                                                                   |

Ebbgate expects **one dispatcher per database file**. Startup reclaims all foreign claims immediately rather than waiting out their lease, which is only safe because any other holder is a previous, dead process (and the wake key makes a duplicate harmless anyway).

## Configuration

```yaml
agents:
  agent_inbox: { tier: private, deferTtlHours: 24 } # optional per-agent TTL

presence:
  deferredMaxAgeHours: 72 # default TTL for deferred tasks

queue: # all optional; defaults shown
  maxAttempts: 10 # wake attempts before a task is dead-lettered
  retryBaseSeconds: 5 # first retry delay, doubles per attempt
  retryMaxSeconds: 900 # retry delay cap
  leaseSeconds: 300 # a claim not confirmed within this is reclaimed
  shutdownGraceSeconds: 10 # how long shutdown waits for in-flight work
```

## Schema

Migration `005_durable_queue.sql` rebuilds `deferred` (SQLite cannot change a `CHECK` in place) and adds `lease_owner`, `lease_expires_at`, `attempts`, `next_attempt_at`, `last_error`, `expires_at`, `terminal_reason` and `finished_at`, the `dead` status, and a unique index on `wake_idempotency_key`. Existing rows are kept; pre-005 claims (with only `claimed_at`) are still reclaimed by age. Migrations are forward-only and each is applied once inside an `IMMEDIATE` transaction.

## Inspecting the queue

```sql
SELECT status, COUNT(*) FROM deferred GROUP BY status;
SELECT run_id, attempts, last_error, next_attempt_at FROM deferred WHERE status = 'pending';
SELECT run_id, terminal_reason, finished_at FROM deferred WHERE status IN ('dead', 'expired');
```

In code: `countDeferredByStatus()` and `listDeadLetters()` in `packages/dispatcher/src/services/queue.ts`.
