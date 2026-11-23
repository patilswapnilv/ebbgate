# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

First usable release: M1–M5 from `BUILD_SPEC.md`.

### Added

- **Core + policy (M1)** — `@ebbgate/core`: YAML policy loader, first-match routing rules, privacy tiers (`private`, `internal`, `public`), unknown agents treated as private, private→cloud rejected at load time and at runtime, property tests for the privacy invariants.
- **Dispatcher (M2)** — `@ebbgate/dispatcher`: Paperclip `http` adapter endpoint (`/run`), presence endpoint, local / cloud / defer routing, SQLite deferred queue that drains when the node returns, constant-time token checks, log redaction, bounded forwards, crash-safe dispatch.
- **Presence agent (M3)** — `@ebbgate/agent`: macOS daemon reporting available / busy / offline (idle, battery, RAM, Ollama, limits collectors), `busy` CLI, runner shim, launchd install with per-node token env files; SwiftBar plugin under `plugins/swiftbar`.
- **CLI + compose (M4)** — `@ebbgate/cli`: `ebbgate init` wizard (never overwrites without `--force`), `agent install`, `runner`; Docker Compose quickstart in `examples/compose` (dispatcher + LiteLLM, local-first model aliases).
- **Docs + demo logging (M5)** — README, `docs/architecture.md`, `docs/policy.md`, `docs/security.md`, `docs/why-not-litellm-fallbacks.md`; `EG_DEMO=1` plain-text decision blocks.

- **`ebbgate demo`** — 60-second, zero-setup simulation (real dispatcher in-process, fake Paperclip and runners): local routing, cloud for non-private work, a private task deferred while offline and drained on return.
- **npm package `ebbgate`** — publishable CLI bundling the workspace packages; changesets; tag/manual Release workflow (uses the `NPM_TOKEN` secret); macOS CI job.
- **`ebbgate admit`** — admission probe for Paperclip's proposed per-environment `admissionCommand` (paperclip#17402): exit 0 admits, non-zero refuses; private + node offline refuses everywhere so Paperclip holds the run; fails closed on any error or timeout. Backed by a read-only dispatcher `POST /admit` and `decideAdmission()` in `@ebbgate/core`. Docs: `docs/paperclip-admission.md`.
- **Explainable decisions** — every `decide()` / `decideAdmission()` result carries `why`: a stable reason code plus a short sentence (e.g. `HELD_PRIVATE_MAC_OFFLINE`: "held because it's private and your Mac is offline"), with tier, presence and matched rule. Append-only `decision_audit` table (no payloads; retention via optional `audit.retentionDays` / `audit.maxRows`); `GET /status` lists why each waiting task waits; new `GET /decisions`; `ebbgate status [--json]`, `ebbgate why <taskId>`, `ebbgate decisions`; SwiftBar shows held count and top reason. Docs: `docs/explainability.md`.

### Known gaps

- npm publish has not happened yet.
- `ebbgate admit` targets an unmerged Paperclip PR; Paperclip passes no run context to admission commands yet.
- Paperclip handshake details marked `TODO(verify-paperclip)` are untested against a live Paperclip.

[0.1.0]: https://github.com/patilswapnilv/ebbgate/compare/8959091...v0.1.0
