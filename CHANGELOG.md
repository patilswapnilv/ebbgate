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

### Known gaps

- Not yet published to npm; run from a source checkout.
- Paperclip handshake details marked `TODO(verify-paperclip)` are untested against a live Paperclip.

[0.1.0]: https://github.com/patilswapnilv/ebbgate/compare/8959091...v0.1.0
