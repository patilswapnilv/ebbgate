# Architecture

Ebbgate sits between [Paperclip](https://paperclip.ing) and your agent runtimes. Paperclip owns orchestration (issues, heartbeats, adapters). Ebbgate owns **where** a heartbeat run executes: local Mac, cloud runtime, or a deferred queue until a local node returns.

```
  Paperclip ──POST /run──► Dispatcher ──decide()──► local runner (:8787)
       ▲                        │                     └─► OpenClaw / local gateway
       │                        ├── cloud runner
       │                        └── defer → SQLite → wakeAgent on return
       │
  Presence agent (Mac) ──POST /presence──► Dispatcher
```

## Packages

| Package                    | Role                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@ebbgate/core`            | Pure types, zod config, `decide()` / `deriveState()` / `resolveTier()`. No I/O.                                                                  |
| `@ebbgate/dispatcher`      | Hono HTTP server, SQLite, Paperclip client, notifier.                                                                                            |
| `@ebbgate/agent`           | macOS collectors, launchd install, `busy` CLI, local runner shim.                                                                                |
| `ebbgate` (`packages/cli`) | Published npm package and `ebbgate` bin: `demo`, `init` wizard, delegates node commands to the agent. Bundles the private `@ebbgate/*` packages. |

## Decision path

1. Paperclip’s `http` adapter POSTs a wake payload to `${publicUrl}/run` with a shared-secret bearer.
2. The dispatcher parses the body into a task context. **Tier comes from `ebbgate.yaml` agents**, never from the payload. Unknown agents are `private`.
3. `decide(task, nodes, config)` returns `local` | `cloud` | `defer`.
4. Local/cloud: forward the original body to the chosen runner and track the run in SQLite.
5. Defer: **persist first**, then optionally comment/label on the issue, then return `202` so Paperclip does not count a failure.

## Presence

Each Mac node runs `@ebbgate/agent`, which POSTs a `PresenceReport` every 30s. The dispatcher derives `available` | `busy` | `offline` (`mode=busy` or `onBattery` → busy; no report past `offlineAfterSeconds` → offline).

Transitions:

- **→ available** — drain the deferred queue (oldest first, deduped per issue) via Paperclip `wakeAgent`.
- **→ offline** with in-flight local runs — mark interrupted, re-`decide`, forward or defer.

## Storage

SQLite file (default `./data/ebbgate.db`): `nodes`, `runs`, `deferred`, `decisions`, and the append-only `decision_audit` log (reason codes, no payloads; retention by age and row cap). Plain, forward-only SQL migrations at startup. WAL mode, `synchronous = FULL`, `busy_timeout = 5000`.

The deferred queue is durable: claims are leases reclaimed after a crash, every task has one idempotency key reused on every retry, failed wakes back off exponentially and are dead-lettered after `queue.maxAttempts`, each task has a TTL with a recorded terminal reason, and shutdown releases claims. Re-submitted runs are deduplicated at `/run`. See [`durable-queue.md`](./durable-queue.md).

## Explainability

`decide()` and `decideAdmission()` return a structured reason (`why`: stable code + short sentence, tier, presence, rule). The dispatcher audits every decision and serves `GET /status` (why each waiting task waits) and `GET /decisions`. See [`explainability.md`](./explainability.md).

## Demo mode

Set `EG_DEMO=1` on the dispatcher to print plain-text decision blocks to stdout (readable in screen recordings). Secrets are never included.
