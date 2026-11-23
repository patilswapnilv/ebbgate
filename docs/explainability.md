# Why is my task waiting? (explainability)

Every routing and admission decision Ebbgate makes carries a **reason**: a stable
machine code plus one short sentence, for example

```
HELD_PRIVATE_MAC_OFFLINE: held because it's private and your Mac is offline (rule #1)
```

Reasons are returned by `decide()` / `decideAdmission()` in `@ebbgate/core` (`decision.why`),
written to an append-only audit log, and shown by `ebbgate status`, `ebbgate why`,
`ebbgate decisions` and the SwiftBar plugin.

## Reason codes

Codes are stable: match on them in scripts and alerts. The sentence may be reworded.

| Code                          | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `RUN_LOCAL`                   | running on your Mac (node named in the detail)                           |
| `RUN_LOCAL_LOW_MAC_BUSY`      | running on your Mac at low priority because it's busy                    |
| `RUN_CLOUD_POLICY`            | sent to the cloud because the policy allows it                           |
| `RUN_CLOUD_MAC_OFFLINE`       | sent to the cloud because your Mac is offline                            |
| `RUN_CLOUD_MAC_BUSY`          | sent to the cloud because your Mac is busy                               |
| `HELD_PRIVATE_MAC_OFFLINE`    | held because it's private and your Mac is offline                        |
| `HELD_PRIVATE_MAC_BUSY`       | held because it's private and your Mac is busy                           |
| `HELD_PRIVATE_CLOUD_BLOCKED`  | held because private tasks never run in the cloud (runtime guard)        |
| `HELD_MAC_OFFLINE`            | held until your Mac is back, because the policy says to wait             |
| `HELD_MAC_BUSY`               | held until your Mac is free, because the policy says to wait             |
| `HELD_POLICY`                 | held because the policy says to wait                                     |
| `HELD_NO_RULE`                | held because no policy rule matched (safe fallback)                      |
| `HELD_UNKNOWN`                | (status only) deferred before the audit log existed; stored reason shown |
| `ADMIT_NODE` / `ADMIT_REMOTE` | admission granted on this node / remotely                                |
| `REFUSE_UNKNOWN_NODE`         | admission probe named a node that isn't configured                       |
| `REFUSE_PRIVATE_REMOTE`       | private (or unknown) tasks never run remotely                            |
| `REFUSE_ROUTED_ELSEWHERE`     | the policy sends this task somewhere else (named in the detail)          |

An admission refusal for a task that would be held keeps its `HELD_*` code, so
`ebbgate admit` and `ebbgate status` say the same thing.

Every reason also carries the task's `tier`, the overall `presence` state the policy
saw and the matched `rule` (index or `default`).

## Audit log

Table `decision_audit` (migration `006_decision_audit.sql`), separate from the queue.
One row per decision: kind (`route` / `admission`), task (run) id, agent id, issue id,
environment id (admission), decision, target (node id, `cloud`, `queue`, `remote`),
tier, reason code and text, rule, presence state, timestamp.

- **No payloads, prompts or secrets** are ever written to it.
- **Append-only:** a trigger rejects every `UPDATE`.
- **Retention:** rows older than `audit.retentionDays` (default 30) are deleted, and
  the table is capped at `audit.maxRows` (default 100 000, newest kept). Retention runs
  on the dispatcher's presence tick, at most once an hour.

```yaml
audit: # optional
  retentionDays: 30
  maxRows: 100000
```

## HTTP

Both endpoints need `Authorization: Bearer <paperclip.sharedSecret>` (the v0.1 admin credential).

- `GET /status` — `presence` (overall + per node), `queue` counts (`pending`, `waking`,
  `done`, `expired`, `held`), `waiting` (oldest first, up to 100, each with `code` and
  `text`), `heldByReason`, `topReason`. The v0.1 fields (`nodes`, `queueDepth`,
  `inFlight`, `recentDecisions`) are kept; `inFlight` no longer includes payloads.
- `GET /decisions?taskId=&agentId=&kind=route|admission&limit=1..500` — audit entries,
  newest first. With `taskId`, also `waiting` (the task's queue entry, or `null`).
  A run id matches its derived ids (`<run>:redecide`, `<run>:local`, `<run>:cloud`).

## CLI

The secret comes from `EG_PAPERCLIP_SECRET` or `--secret-file` (never argv); the
dispatcher from `--dispatcher` or `EBBGATE_DISPATCHER_URL` (default `http://127.0.0.1:8790`).

```bash
ebbgate status            # presence, queue counts, why each waiting task waits
ebbgate status --json
ebbgate why <taskId>      # exit 0 found, 1 no decisions recorded, 2 error
ebbgate why <taskId> --json
ebbgate decisions --agent agent_inbox --kind route --limit 20 [--json]
```

Without a dispatcher secret, `ebbgate status` shows the node-local view (mode, node,
what the dispatcher sees if this node holds the admin secret).

## SwiftBar

`plugins/swiftbar/ebbgate.30s.sh` shows the held count in the menu bar
(`○ offline · 2 held`), the top reason, and up to five waiting tasks, each with a
**Why?** item that runs `ebbgate why <taskId>`. It needs `EG_PAPERCLIP_SECRET` in
SwiftBar's environment; without it only the local mode is shown.
