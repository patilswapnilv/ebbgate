# Ebbgate

**Agents flow to the cloud when your machine sleeps. Private work waits at the gate.**

```bash
npx ebbgate demo
```

60 seconds, nothing to set up: no Paperclip, no Docker, no API keys. The real dispatcher runs in-process against a fake Paperclip and shows your Mac going offline, an internal task moving to the cloud, a private task waiting at the gate, and that task running locally the moment the Mac is back.

<!-- GIF placeholder: record `npx ebbgate demo` (asciinema/vhs) and embed it here, e.g. docs/demo.gif -->
> _Demo GIF coming soon: `npx ebbgate demo` in one take._

[![CI](https://github.com/patilswapnilv/ebbgate/actions/workflows/ci.yml/badge.svg)](https://github.com/patilswapnilv/ebbgate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A presence-aware **task dispatcher** for AI agents orchestrated by [Paperclip](https://paperclip.ing).

> **Status: v0.1.0, early.** `npx ebbgate demo` works once the package is published to npm; until then run it from a checkout with `pnpm install && pnpm build && pnpm ebbgate demo`. The Paperclip integration is built against documented adapter shapes; spots still to confirm against a live Paperclip are marked `TODO(verify-paperclip)`.

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

Details: [`docs/architecture.md`](./docs/architecture.md), [`docs/policy.md`](./docs/policy.md), [`docs/durable-queue.md`](./docs/durable-queue.md) (crash recovery, retries, TTL, dead letters).

## Prerequisites

Ebbgate sits in front of [Paperclip](https://paperclip.ing) and talks to a local model runtime. If you are starting from a machine with nothing installed, follow **[Getting started](./docs/getting-started.md)** first — it is the "Before you start: install Paperclip" path, in order:

1. **Node.js 24.11+.** Ebbgate alone accepts Node 22, but Paperclip needs 24.11 or newer, so install that once for both.
2. **A running Paperclip instance and a `PAPERCLIP_API_KEY`.** Use Paperclip's own [installation guide](https://docs.paperclip.ing/guides/getting-started/installation/); Getting started links each official step.
3. **Ollama and a model.** Optional to do by hand: `ebbgate init` offers to install Ollama and pull a small model for you (below).

The demo at the top of this README needs none of that. From a machine that already has the prerequisites, the Quickstart below takes about five minutes. A clean machine is closer to an hour, mostly the model download and Paperclip setup. Those times are estimates; we have not timed a clean-machine run yet.

## Quickstart (5 minutes)

Try it first with `npx ebbgate demo` (above). For a real setup, in an empty folder:

```bash
npx ebbgate init && npx ebbgate doctor
```

`init` asks a few questions (or takes secure defaults with `--yes`) and writes:

| File                                  | What                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ebbgate.yaml`                        | A minimal policy. No cloud runner, so nothing leaves your machines; agents you don't list are private; private work waits for your Mac. A `local:` section records your Ollama URL and model. |
| `.env`                                | Generated `EG_PAPERCLIP_SECRET` and node token, **mode 600**, never printed in full. Add `PAPERCLIP_API_KEY` here (or have it in your environment when you run `init`).                       |
| `.env.example`, `litellm.config.yaml` | Templates for Docker Compose and LiteLLM.                                                                                                                                                     |

No Ollama yet? `init` offers to install and start it (`brew install ollama && brew services start ollama` on macOS, or the [download page](https://ollama.com/download) without Homebrew; on Linux the official install script, which only runs after you type yes yourself) and to pull a small default model, `llama3.2` (about 2 GB; choose another with `--model`). It records the Ollama URL and model in the `local:` section of `ebbgate.yaml`, which `doctor` uses to check that the model is pulled. `--yes` accepts (except the Linux install script), `--no-ollama` skips, and without a terminal (CI) nothing is installed unless you pass `--yes`.

You don't edit any YAML to get started. `doctor` then checks everything and prints one line per check with the fix:

```text
PASS  Node.js             v24.11.0
PASS  Config              ./ebbgate.yaml is valid
PASS  Secrets file        ./.env (mode 600)
FAIL  Dispatcher          http://127.0.0.1:8790 not reachable (ECONNREFUSED)
                          fix: start it: `ebbgate serve` in the folder with ebbgate.yaml (or set EBBGATE_DISPATCHER_URL)
WARN  Presence heartbeat  skipped: dispatcher status unavailable
PASS  Ollama              http://127.0.0.1:11434 (1 model(s))
PASS  Cloud runner        none configured: nothing leaves your machines (work waits for a local node)
PASS  SQLite queue        ./data/ebbgate.db is writable
PASS  Paperclip           http://127.0.0.1:3100 is reachable
```

It also checks dispatcher auth and the Paperclip key. Add `--json` for scripts; it exits non-zero while anything fails. Work through it until it's green:

1. **Start the dispatcher**, in the folder with `ebbgate.yaml` (leave it running in its own terminal):

   ```bash
   npx ebbgate serve       # loads ./ebbgate.yaml and ./.env; Ctrl-C stops it cleanly
   ```

   It prints the URL it listens on and the `/run` URL for Paperclip. Use `--config PATH` / `--env PATH` for files elsewhere.

2. **Install the presence agent on your Mac**, from the same folder. It's one command and runs under launchd:

   ```bash
   npm i -g ebbgate        # a stable path for launchd (npx's cache can be cleared)
   ebbgate agent install   # --node <id> only if ebbgate.yaml has several nodes
   ebbgate runner          # local runner shim on :8787 (separate terminal)
   ```

   It reports to the dispatcher at `server.publicUrl` from `ebbgate.yaml` by default (override with `--dispatcher URL`). `ebbgate agent uninstall` removes it.

3. **Point Paperclip at it.** Set the agent's `http` adapter to the `/run` URL `ebbgate serve` printed (`http://127.0.0.1:8790/run` by default) with `Authorization: Bearer <EG_PAPERCLIP_SECRET from .env>`. Paperclip blocks loopback addresses until you allowlist them; the exact steps are in [Getting started → Point Paperclip's `http` adapter at Ebbgate](./docs/getting-started.md#point-paperclips-http-adapter-at-ebbgate).

4. **Run `ebbgate doctor` again**: all PASS.

Want non-private work to spill over to the cloud when your Mac is away? Re-run `npx ebbgate init --force --cloud-runner https://…`. Existing secrets are kept, and private work still never goes there.

> Until the npm package is published, run the same commands from a checkout: `pnpm install && pnpm build`, then `pnpm ebbgate init`, `pnpm ebbgate doctor`, `pnpm ebbgate serve`, `pnpm ebbgate agent install`.

### Other setups: Docker Compose, more machines

```bash
git clone https://github.com/patilswapnilv/ebbgate.git && cd ebbgate
cp examples/compose/.env.example examples/compose/.env
# edit .env — every secret must be ≥16 characters

docker compose -f examples/compose/docker-compose.yml up --build
# dispatcher :8790   LiteLLM 127.0.0.1:4000 (requires LITELLM_MASTER_KEY)
```

On each Mac, after `pnpm install && pnpm build`, give the node its own token, and only that:

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

Full compose notes: [`examples/compose/README.md`](./examples/compose/README.md).

### Demo logging

```bash
EG_DEMO=1 ebbgate serve
```

Prints plain-text decision blocks (no secrets) — handy for screen recordings.

### Why is my task waiting?

```bash
ebbgate status              # presence, queue counts, and why each held task waits
ebbgate why <taskId>        # every decision for one task (add --json for scripts)
ebbgate decisions --limit 20
```

```
waiting:
  run-42  agent_inbox  private  12m  HELD_PRIVATE_MAC_OFFLINE: held because it's private and your Mac is offline (rule #1)
```

Every decision is recorded in an append-only audit log (reason codes only, never payloads). The SwiftBar plugin shows the held count and top reason. See [`docs/explainability.md`](./docs/explainability.md).

## Policy file

Annotated example: [`ebbgate.example.yaml`](./ebbgate.example.yaml). Rules are first-match; private→cloud is rejected at load time and again at runtime. See [`docs/policy.md`](./docs/policy.md).

## Works with

- **Paperclip** — `http` adapter → Ebbgate `/run`; or `ebbgate admit` as an environment `admissionCommand` ([`docs/paperclip-admission.md`](./docs/paperclip-admission.md), for the proposed fallback environments in [paperclip#17402](https://github.com/paperclipai/paperclip/pull/17402))
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

**The guarantee is tested, not just claimed.** An adversarial suite tries to leak private work: unknown agents, spoofed payloads, broken policy files, stale or skewed heartbeats, crashes mid-route, the cloud as the only target, concurrent load and property-based fuzzing. A mutation check then proves the suite catches every defence being removed. Run it with `pnpm test:privacy`. The exact promise, the threat model and what's out of scope are in [`docs/privacy-guarantee.md`](./docs/privacy-guarantee.md).

Auth, redaction, and invariants: [`docs/security.md`](./docs/security.md).

## Roadmap

| Milestone                    | Status                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| M1 Core + policy             | done                                                                                      |
| M2 Dispatcher                | done                                                                                      |
| M3 Presence agent + SwiftBar | done                                                                                      |
| M4 Init + compose            | done                                                                                      |
| M5 Docs + `EG_DEMO`          | done                                                                                      |
| v0.1.0                       | M1–M5 on `main`, `ebbgate demo`, `ebbgate admit`, npm package `ebbgate` (publish pending) |
| Next                         | Paperclip plugin for held runs, run context for admission (upstream)                      |
| Later                        | Windows/Linux agents, menu-bar app, multi-user auth, more orchestrators                   |

Source of truth while building: [`BUILD_SPEC.md`](./BUILD_SPEC.md).

## Contributing

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

User-visible change? Add a changeset: `pnpm changeset`. Releases are published from the **Release** workflow (tag `v*` or manual run); see [`.changeset/README.md`](./.changeset/README.md).

- One milestone-sized change at a time; keep `@ebbgate/core` free of I/O.
- Never invent Paperclip API shapes — fixtures + `TODO(verify-paperclip)` if unsure.
- No real secrets in git.

## Credits

Built on [Paperclip](https://paperclip.ing), [LiteLLM](https://github.com/BerriAI/litellm), and [Ollama](https://ollama.com). **Not an official Paperclip project.**

## License

MIT
