# BUILD_SPEC.md — Ebbgate v0.1

> Working name: **ebbgate**. Name decided 2026-11-16.
> Tagline: _Agents flow to the cloud when your machine sleeps. Private work waits at the gate._

This file is the source of truth for building v0.1. Read it fully before writing code. Follow the milestones in order and stop at the end of each one.

---

## 1. What we are building

A presence-aware **task dispatcher** for AI agents orchestrated by **Paperclip** (paperclip.ing, MIT).

- When a user's local machine (Mac) is **available**, agent tasks run on it (local models via Ollama, local files).
- When it is **busy** (user needs the machine), only private work runs locally, at low priority; other work goes to the cloud.
- When it is **offline**, non-private work runs on a cloud runtime; **private work is deferred** and runs automatically when the machine returns.
- Model-level fallback (per LLM call) is delegated to **LiteLLM**. Ebbgate operates at the **task** level.

### Invariants (must never break — enforce with tests)

1. A task whose tier is `private` is **never** dispatched to a cloud runtime.
2. A task with an **unknown tier** is treated as `private` (fail closed).
3. A deferred task is never lost: it is persisted before Ebbgate responds to Paperclip.
4. Secrets (tokens, keys) never appear in logs or API responses.

### Non-goals for v0.1

Windows/Linux presence agents, native menu-bar app, web dashboard, multi-user/auth beyond tokens, orchestrators other than Paperclip, model routing (that is LiteLLM's job).

---

## 2. Tech stack (do not add dependencies outside this list without asking)

- Node.js 22, TypeScript (strict), ESM
- pnpm workspaces, changesets
- Hono (HTTP), zod (schemas), yaml (config parsing)
- better-sqlite3 (deferred queue + run state)
- pino (logging, with redaction)
- vitest (tests), tsup (builds)
- biome (lint + format)
- @clack/prompts (CLI wizard)

---

## 3. Repo layout

```
ebbgate/
├─ packages/
│  ├─ core/            # types, zod schemas, policy engine (pure, no I/O)
│  ├─ dispatcher/      # Hono server: /run, /presence, /status, queue, notifier, Paperclip client
│  ├─ agent/           # presence daemon for macOS + `ebbgate` local CLI (busy on|off|auto, install)
│  └─ cli/             # `npx ebbgate init` wizard + LiteLLM config generator
├─ plugins/
│  └─ swiftbar/        # SwiftBar/xbar plugin script: shows state, toggles busy
├─ examples/
│  └─ compose/         # docker-compose quickstart: dispatcher + LiteLLM + Paperclip demo
├─ fixtures/
│  └─ paperclip/       # recorded/assumed Paperclip payloads used in tests
├─ docs/
│  ├─ architecture.md
│  ├─ policy.md
│  ├─ security.md
│  └─ why-not-litellm-fallbacks.md
├─ ebbgate.example.yaml
├─ README.md
└─ BUILD_SPEC.md
```

---

## 4. Domain model (packages/core)

```ts
type NodeId = string;

type PresenceState = "available" | "busy" | "offline";

interface PresenceReport {
  node: NodeId;
  mode: "auto" | "busy" | "available"; // user override
  freeRamGb: number;
  onBattery: boolean;
  userIdleSeconds: number;
  modelsLoaded: string[]; // Ollama /api/ps
  modelsInstalled: string[]; // Ollama /api/tags
  agentVersion: string;
  sentAt: string; // ISO
}

interface NodeStatus {
  node: NodeId;
  state: PresenceState; // derived by dispatcher
  lastSeenAt: string | null;
  report: PresenceReport | null;
}

type Tier = "private" | "internal" | "public";

interface TaskContext {
  runId: string;
  agentId: string;
  companyId: string;
  issueId?: string;
  wakeReason?: string;
  tier: Tier; // resolved from config (see §6), never trusted from the payload
  labels: string[];
}

type Decision =
  | { action: "local"; node: NodeId; priority: "normal" | "low"; reason: string }
  | { action: "cloud"; reason: string }
  | { action: "defer"; reason: string; notify: boolean };
```

`decide(task, nodes, policy): Decision` must be a **pure function**.

---

## 5. Config file: `ebbgate.yaml`

```yaml
server:
  port: 8790
  host: 127.0.0.1          # bind address; 0.0.0.0 inside a container
  publicUrl: http://cloud:8790
  maxBodyBytes: 1048576    # larger request bodies get HTTP 413

nodes:
  mini: { runner: http://mini:8787, token: ${EG_NODE_MINI_TOKEN} }
  mbp:  { runner: http://mbp:8787,  token: ${EG_NODE_MBP_TOKEN}, prefer: true }

cloud:
  runner: http://openclaw:18789/paperclip   # cloud runtime target (verify path, §7)

paperclip:
  apiUrl: http://paperclip:3100
  apiKey: ${PAPERCLIP_API_KEY}
  sharedSecret: ${EG_PAPERCLIP_SECRET}        # used to verify /run calls

agents:                                       # tier is decided HERE, not by the caller
  agent_inbox:    { tier: private }
  agent_finance:  { tier: private }
  agent_ops:      { tier: internal }
  agent_research: { tier: public }

policies:                                     # first match wins
  - match: { label: local-files }
    available: local
    busy: local-low
    offline: defer
    notify: true
  - match: { tier: private }
    available: local
    busy: local-low
    offline: defer
  - match: { tier: internal }
    available: local
    busy: cloud
    offline: cloud
  - default:
      available: cloud
      busy: cloud
      offline: cloud

presence:
  offlineAfterSeconds: 90
  drainConcurrency: 2
  deferredMaxAgeHours: 72

notify:
  telegram: { botToken: ${TG_BOT_TOKEN}, chatId: ${TG_CHAT_ID} }
  webhook:  { url: ${EG_NOTIFY_WEBHOOK} }
```

Rules:

- `${VAR}` interpolation from env; fail on startup if a referenced var is missing.
- Validate with zod; print a human-readable error with the path of the bad key.
- A policy action of `cloud` on a rule that can match `tier: private` is a **config error** (reject at load time).

Node selection when `local`: prefer nodes marked `prefer: true` that are `available`, else any `available`; for `local-low`, also accept `busy`. If none, fall through to the `offline` action of that rule.

---

## 6. Dispatcher (packages/dispatcher)

### Endpoints

| Method | Path              | Auth                                        | Purpose                                                                  |
| ------ | ----------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/run`            | HMAC or bearer shared secret from Paperclip | Paperclip `http` adapter target. Resolve tier → decide → forward / defer |
| POST   | `/presence`       | per-node bearer token                       | Presence heartbeat from a node                                           |
| POST   | `/nodes/:id/mode` | per-node token                              | Set busy/available/auto                                                  |
| GET    | `/status`         | admin token                                 | Nodes, queue depth, in-flight runs, last decisions                       |
| GET    | `/healthz`        | none                                        | Liveness                                                                 |

### /run flow

1. Verify auth. Parse the Paperclip payload through the adapter layer (§7) into `TaskContext`. Tier comes from `agents` config; unknown agent → `private`.
2. `decide()`.
3. `local` / `cloud`: forward the original payload to the chosen runner and record the in-flight run (`runs` table: runId, issueId, agentId, target, node, startedAt, status). Return the runner's response to Paperclip, or the async acknowledgement Paperclip expects (verify, §7).
4. `defer`: persist to the `deferred` table **first**, optionally post a comment on the issue and add the label `waiting-for-local` via the Paperclip API, notify, then return a **success** response so Paperclip does not count a failure.

### Presence handling

- Each report updates the node's `lastSeenAt` and derives state: `mode=busy` or `onBattery` → `busy`; else `available`.
- A background ticker marks a node `offline` after `offlineAfterSeconds` with no report.
- On the transition **offline/busy → available**: drain the deferred queue (oldest first, `drainConcurrency` at a time) by waking each deferred issue's agent via the Paperclip API. Dedupe per issue. Drop and notify for items older than `deferredMaxAgeHours`.
- On the transition **available → offline** with in-flight runs on that node: mark them `interrupted`. Re-decide each one with the node offline (internal → cloud, private → defer) and wake accordingly.

### Notifier

Events: `node_offline`, `node_online`, `task_deferred`, `queue_drained`, `run_interrupted`, `deferred_expired`. Telegram + generic webhook. Coalesce bursts: at most 1 message per event type per node per 60 s.

### Storage

SQLite file (default `./data/ebbgate.db`), tables `nodes`, `runs`, `deferred`, `decisions` (audit log of every decision with reason). Migrations as plain SQL files run at startup.

---

## 7. Paperclip integration — VERIFY, DO NOT INVENT

The Paperclip HTTP API is not fully specified here. Before implementing `packages/dispatcher/src/paperclip/`:

1. Read the current docs: `https://docs.paperclip.ing` — adapters overview, the `http` adapter, "Bring your own agent", the OpenClaw adapter, and the issues/heartbeat API.
2. Known from docs (confirm): adapters receive run, agent, company and issue/task identifiers plus a wake reason. Agents call back with `PAPERCLIP_API_KEY`. Heartbeat runs are listable at `/api/companies/:companyId/heartbeat-runs`.
3. Unknown (must confirm and document in `docs/architecture.md`): the exact `http` adapter request body and expected response (sync result vs async ack); the endpoint to **wake/invoke** an agent for an issue; endpoints to comment on and label an issue.
4. Isolate all of this behind an interface:

```ts
interface PaperclipClient {
  parseRun(body: unknown, headers: Headers): TaskContextInput;
  wakeAgent(args: { agentId: string; issueId?: string; reason: string }): Promise<void>;
  commentOnIssue(issueId: string, body: string): Promise<void>;
  addLabel(issueId: string, label: string): Promise<void>;
}
```

5. Put example payloads in `fixtures/paperclip/*.json` and mark any assumption with `// TODO(verify-paperclip): ...`. List all TODOs in your milestone summary.

---

## 8. Presence agent (packages/agent) — macOS

- Runs as a launchd user agent; `ebbgate agent install` writes `~/Library/LaunchAgents/dev.ebbgate.agent.plist` and loads it; `ebbgate agent uninstall` reverses this.
- Every 30 s, build a `PresenceReport`:
  - free RAM: `os.freemem()` (and `vm_stat` if more accurate)
  - battery: parse `pmset -g batt`
  - idle time: parse `HIDIdleTime` from `ioreg -c IOHIDSystem`
  - Ollama: `GET http://127.0.0.1:11434/api/ps` and `/api/tags` (tolerate Ollama being down)
  - mode: read `~/.ebbgate/mode` (`auto|busy|available`)
- POST to `${dispatcher}/presence` with the node token. Exponential backoff on failure; never crash.
- CLI: `ebbgate busy on|off|auto`, `ebbgate status`.
- SwiftBar plugin (`plugins/swiftbar/ebbgate.30s.sh`): shows ● available / ◐ busy / ○ offline and menu items to toggle busy.
- Also ship a tiny **local runner shim** (`ebbgate runner`) on port 8787 that forwards to the local OpenClaw gateway URL from config, so the dispatcher always talks to one stable endpoint per node.

---

## 9. CLI wizard (packages/cli): `npx ebbgate init`

1. Detect: Ollama (`:11434`), LiteLLM (`:4000`), Paperclip (`:3100`); ask for URLs if not found.
2. Ask: node names, which Paperclip agents exist (list them via the API if possible) and their tier.
3. Write `ebbgate.yaml`, `.env.example` (no real secrets) and `litellm.config.yaml` with aliases:
   - `private-fast` / `private-smart` → Ollama on nodes, fallbacks only to other local deployments
   - `internal-smart` → local first, then a cloud model placeholder
   - `cloud-reason`, `cloud-cheap` → provider placeholders
4. Print the exact Paperclip agent settings: adapter `http`, URL `${publicUrl}/run`, secret.
5. Print next steps: install the agent on each node, start the dispatcher.

---

## 10. Testing requirements

- **Policy matrix test** (table-driven) covering every cell of:

| Task              | available | busy      | offline |
| ----------------- | --------- | --------- | ------- |
| private           | local     | local-low | defer   |
| internal          | local     | cloud     | cloud   |
| public            | cloud     | cloud     | cloud   |
| label local-files | local     | local-low | defer   |
| unknown agent     | local     | local-low | defer   |

- **Property test:** for random nodes/states/policies that pass validation, `private` never yields `cloud`.
- **Config test:** a rule that could send `private` to `cloud` is rejected.
- **Integration test:** spin up the dispatcher + fake Paperclip + fake local runner + fake cloud runner (Hono apps on random ports). Script: node available → run goes local; node stops reporting → offline; private run deferred and persisted; node returns → `wakeAgent` called once; in-flight run on a dropped node is re-decided.
- **Log redaction test:** tokens never appear in pino output.
- CI: GitHub Actions — install, lint, typecheck, test on Node 22.

---

## 11. Milestones (stop and summarize after each)

**M1 — Core + policy (no I/O)**
Monorepo scaffold, biome, vitest, CI. `packages/core`: types, zod config schema with env interpolation, `decide()`, policy validation. All §10 policy, property and config tests pass.
_Acceptance:_ `pnpm test` green; `pnpm lint` clean.

**M2 — Dispatcher**
Hono server, SQLite + migrations, `/presence`, `/run`, `/status`, `/healthz`, presence ticker, deferred queue, drain on return, interrupted-run handling, notifier (Telegram + webhook) with coalescing. `PaperclipClient` behind an interface with fixtures and TODO(verify) markers.
_Acceptance:_ integration test from §10 passes.

**M3 — Presence agent + runner shim + SwiftBar plugin**
macOS collectors, launchd install/uninstall, `busy` CLI, runner shim.
_Acceptance:_ on a Mac, `ebbgate agent install` → dispatcher `/status` shows the node available; `ebbgate busy on` → busy within 30 s; stopping the agent → offline after 90 s.

**M4 — CLI wizard + compose quickstart**
`npx ebbgate init`, LiteLLM config generator, `examples/compose` (dispatcher + LiteLLM + Paperclip with a seeded demo company if feasible).
_Acceptance:_ from a clean machine with Docker, the README quickstart works in under 10 minutes.

**M5 — Docs + README**
README per the outline in §12, docs folder, demo-mode flag (`EG_DEMO=1`) that logs decisions in a readable, screen-recording-friendly format.

---

## 12. README outline

1. Name, one-liner, GIF placeholder (lid closes → Telegram → lid opens)
2. Badges (license, CI, npm)
3. Why — three bullets: free local inference when on; agents don't stop when off; private work never silently goes to the cloud
4. How it works — diagram (presence → dispatcher → local / cloud / defer) + the policy matrix
5. Quickstart (5 minutes)
6. Policy file, annotated
7. Works with: Paperclip, LiteLLM, Ollama / LM Studio, OpenClaw, Claude Code
8. Ebbgate vs LiteLLM fallbacks — per-call vs per-task
9. Privacy model — what the cloud sees and never sees
10. Roadmap
11. Contributing
12. Credits — built on Paperclip, LiteLLM, Ollama; not an official Paperclip project

---

## 13. Working rules for the coding agent

- Implement one milestone at a time; at the end, list what was built, test results, open `TODO(verify-paperclip)` items and decisions you made.
- Do not invent external APIs. If unsure, write an interface + fixture + TODO and ask.
- Keep `packages/core` free of I/O.
- Small, focused commits with conventional commit messages.
- Never commit real secrets; `.env` is git-ignored; examples use placeholders.
- Prefer clarity over cleverness; this is an open-source project people will read.
