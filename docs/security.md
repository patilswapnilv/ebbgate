# Security & privacy

## Invariants

1. A `private` task never goes to a cloud runtime.
2. An unknown agent tier is treated as `private`.
3. A deferred task is persisted to SQLite before Ebbgate responds to Paperclip.
4. Secrets (tokens, API keys) never appear in logs or API responses.

The precise guarantee, threat model and the test suite that verifies invariants 1 and 2: [privacy-guarantee.md](./privacy-guarantee.md).

## What the cloud sees

When policy chooses `cloud`, the dispatcher forwards the **original Paperclip wake payload** to `cloud.runner`. That is whatever Paperclip put in the http-adapter body (run id, agent id, issue context, etc.).

Private / deferred work is **not** forwarded. The cloud runner never receives those payloads from Ebbgate.

## Auth surfaces

| Endpoint                                   | Auth                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `POST /run`                                | Bearer = `paperclip.sharedSecret`              |
| `POST /presence`, `POST /nodes/:id/mode`   | Bearer = that node’s `token`                   |
| `GET /status`                              | Bearer = `paperclip.sharedSecret` (v0.1 admin) |
| `POST /admit` (read-only, `ebbgate admit`) | Bearer = `paperclip.sharedSecret` (v0.1 admin) |
| `GET /healthz`                             | none                                           |

Paperclip outbound webhooks today use a shared-secret bearer (no HMAC body signature). See `TODO(verify-paperclip)` markers in the dispatcher.

## Logging

Pino redacts authorization headers, tokens, API keys, and bot tokens. With `EG_DEMO=1`, decision lines are plain text and still omit secrets.

## Local files

Mode and node id live under `~/.ebbgate/` with restrictive file modes. `.env` is gitignored; examples use placeholders only.
