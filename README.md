# Ebbgate

**Agents flow to the cloud when your machine sleeps. Private work waits at the gate.**

<!-- GIF placeholder: laptop lid closes → Telegram “deferred” → lid opens → agent resumes -->
> _Demo GIF coming soon — lid closes → notify → lid opens → deferred work wakes._

[![CI](https://github.com/patilswapnilv/ebbgate/actions/workflows/ci.yml/badge.svg)](https://github.com/patilswapnilv/ebbgate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A presence-aware **task dispatcher** for AI agents orchestrated by [Paperclip](https://paperclip.ing).

## Why

- **Free local inference when you’re on** — Ollama (or your local gateway) while the Mac is available.
- **Agents don’t stop when you’re off** — non-private work moves to a cloud runtime; private work waits and resumes.
- **Private work never silently goes to the cloud** — config and runtime guards; unknown agents fail closed as private.

Model-level fallback (per LLM call) stays with [LiteLLM](https://github.com/BerriAI/litellm). Ebbgate works one level up: per **task**.

## How it works

```
Presence agent (Mac) ──► Dispatcher ──► local / cloud / defer
                              ▲
Paperclip http adapter ───────┘
```

| Task                | available          | busy      | offline   |
| ------------------- | ------------------ | --------- | --------- |
| private             | local              | local-low | **defer** |
| internal            | local              | cloud     | cloud     |
| public              | cloud              | cloud     | cloud     |
| label `local-files` | local              | local-low | defer     |
| unknown agent       | treated as private |           |           |

Details: [`docs/architecture.md`](./docs/architecture.md), [`docs/policy.md`](./docs/policy.md).

## Quickstart (5 minutes)

### Option A — Docker Compose

```bash
git clone https://github.com/patilswapnilv/ebbgate.git && cd ebbgate
cp examples/compose/.env.example examples/compose/.env
# edit .env — every secret must be ≥16 characters

docker compose -f examples/compose/docker-compose.yml up --build
# dispatcher :8790   LiteLLM 127.0.0.1:4000 (requires LITELLM_MASTER_KEY)
```

On your Mac, after `pnpm install && pnpm build`, give the node its own token, and only that:

```bash
mkdir -p ~/.ebbgate
grep '^EG_NODE_MINI_TOKEN=' examples/compose/.env > ~/.ebbgate/.env
chmod 600 ~/.ebbgate/.env

pnpm ebbgate agent install \
  --node mini \
  --dispatcher http://127.0.0.1:8790 \
  --config examples/compose/ebbgate.yaml \
  --env-file ~/.ebbgate/.env \
  --runner-host 0.0.0.0

pnpm ebbgate runner   # :8787 shim (separate terminal)
```

Point Paperclip agents at `http://127.0.0.1:8790/run` with  
`Authorization: Bearer <EG_PAPERCLIP_SECRET>`.

Full compose notes: [`examples/compose/README.md`](./examples/compose/README.md).

### Option B — `ebbgate init`

```bash
pnpm install && pnpm build
pnpm ebbgate init           # runs in the directory you call it from
# or: pnpm ebbgate init --yes   (refuses to overwrite existing files without --force)
```

Writes `ebbgate.yaml`, `.env.example`, and `litellm.config.yaml`, then prints adapter settings and next steps.

### Demo logging

```bash
EG_DEMO=1 node packages/dispatcher/dist/index.js
```

Prints plain-text decision blocks (no secrets) — handy for screen recordings.

## Policy file

Annotated example: [`ebbgate.example.yaml`](./ebbgate.example.yaml). Rules are first-match; private→cloud is rejected at load time and again at runtime. See [`docs/policy.md`](./docs/policy.md).

## Works with

- **Paperclip** — `http` adapter → Ebbgate `/run`
- **LiteLLM** — model aliases (`private-fast`, `internal-smart`, …)
- **Ollama / LM Studio** — local models on the node
- **OpenClaw** — local/cloud gateway behind the runner shim  
  (`TODO(verify-paperclip)`: exact path)
- **Claude Code** (and other agent CLIs) — via Paperclip adapters, not Ebbgate directly

## Ebbgate vs LiteLLM fallbacks

LiteLLM retries the **next model** when a call fails. Ebbgate chooses the **runtime** (this Mac vs cloud vs wait) from presence and tier. Use both; don’t replace one with the other. Longer write-up: [`docs/why-not-litellm-fallbacks.md`](./docs/why-not-litellm-fallbacks.md).

## Privacy model

|                                          | Cloud may see                                      | Cloud never sees (via Ebbgate)                          |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Public / internal tasks routed to cloud  | Paperclip wake payload forwarded to `cloud.runner` | —                                                       |
| Private / deferred / unknown-agent tasks | —                                                  | Payloads stay on disk in the deferred queue until local |

Auth, redaction, and invariants: [`docs/security.md`](./docs/security.md).

## Roadmap

| Milestone                    | Status                                                                  |
| ---------------------------- | ----------------------------------------------------------------------- |
| M1 Core + policy             | done                                                                    |
| M2 Dispatcher                | done                                                                    |
| M3 Presence agent + SwiftBar | done                                                                    |
| M4 Init + compose            | done                                                                    |
| M5 Docs + `EG_DEMO`          | done                                                                    |
| Later                        | Windows/Linux agents, menu-bar app, multi-user auth, more orchestrators |

Source of truth while building: [`BUILD_SPEC.md`](./BUILD_SPEC.md).

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

- One milestone-sized change at a time; keep `@ebbgate/core` free of I/O.
- Never invent Paperclip API shapes — fixtures + `TODO(verify-paperclip)` if unsure.
- No real secrets in git.

## Credits

Built on [Paperclip](https://paperclip.ing), [LiteLLM](https://github.com/BerriAI/litellm), and [Ollama](https://ollama.com). **Not an official Paperclip project.**

## License

MIT
