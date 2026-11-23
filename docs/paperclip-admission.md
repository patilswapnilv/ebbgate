# Paperclip admission: `ebbgate admit`

`ebbgate admit` is a ready-made **admission command** for Paperclip's environment
overflow proposal, [paperclipai/paperclip#17402](https://github.com/paperclipai/paperclip/pull/17402).
It lets Paperclip ask Ebbgate, before it places a run, "may this run start in this
environment right now?" and get the same answer the Ebbgate dispatcher would give.

> **Status:** #17402 is an open, unmerged community PR. Field names below follow that
> PR as of 23 Nov 2026 and may change. Everything Paperclip-side is
> `TODO(verify-paperclip)` until it lands.

## How Paperclip uses it (per #17402)

- An agent declares ordered fallbacks: `runtimeConfig.fallbackEnvironmentIds` (max 8).
- Each local or SSH environment may declare `capacity.admissionCommand`: an argv run
  **on the controller host** (where Paperclip runs). **Exit 0 admits**; a non-zero exit,
  a spawn error or a **10 s timeout refuses**. The probe reserves nothing.
- Paperclip tries the primary environment, then each fallback, and places the run in
  the first one that has capacity and admits it.
- If **every** candidate refuses, the run **waits** on Paperclip's `workspace_busy`
  retry ladder and is retried later. For private work this is exactly the behaviour we
  want: it holds instead of leaking or failing.

## What `ebbgate admit` decides

It calls the dispatcher's `POST /admit`, which runs the core policy engine
(`decideAdmission` → `decide`) against **live presence** and the dispatcher's own config:

| Environment flag | Admitted when                                              |
| ---------------- | ---------------------------------------------------------- |
| `--node <id>`    | the policy would run the task locally **on that node** now |
| `--remote`       | the policy would send the task to the **cloud** now        |

Consequences:

- **Private + Mac offline:** refused on every remote environment, and on the Mac
  environment too (it is offline), so Paperclip holds the run until the Mac is back.
- **Private + Mac available:** the Mac environment admits; remote environments refuse.
- **Internal + Mac offline:** the Mac refuses, the remote environment admits.
- **Unknown or missing agent id → private.** An issue privacy flag (`--private`) can
  only make the task stricter. Unknown labels are evaluated against every label rule
  and must pass all of them.
- **Fails closed:** missing flags, missing secret, unreachable dispatcher, non-2xx,
  malformed answer or timeout (default 3 s, max 8 s, below Paperclip's 10 s) all refuse.
- **Fast:** one HTTP call; ~150 ms end to end on a laptop.

Exit codes: `0` admit, `1` refuse (policy), `2` refuse (error). Paperclip treats every
non-zero code as a refusal; the split is for humans and logs. One line goes to stderr,
with the reason code, e.g. `ebbgate admit: refuse node mini (tier=private; HELD_PRIVATE_MAC_OFFLINE: held because it's private and your Mac is offline (rule #1))`.
`--json` adds `code` and `text`. Every answer is appended to the decision audit log
(`ebbgate decisions --kind admission`); see [`explainability.md`](./explainability.md).

## Usage

```bash
ebbgate admit (--node <id> | --remote)
  [--agent <id>] [--environment <id>] [--private] [--labels a,b]
  [--dispatcher http://127.0.0.1:8790] [--secret-file <path>] [--timeout-ms 3000] [--json]
```

| Flag            | Env var                   | Notes                                              |
| --------------- | ------------------------- | -------------------------------------------------- |
| `--node <id>`   | `EBBGATE_NODE`            | this environment runs on Ebbgate node `<id>`       |
| `--remote`      | `EBBGATE_REMOTE=1`        | this environment is not one of your nodes          |
| `--agent <id>`  | `EBBGATE_AGENT_ID`        | tier comes from `agents:` in the dispatcher config |
| `--environment` | `EBBGATE_ENVIRONMENT_ID`  | logged only                                        |
| `--private`     | `EBBGATE_ISSUE_PRIVATE=1` | stricter only                                      |
| `--labels a,b`  | `EBBGATE_LABELS`          | omit when unknown; `--labels=` means "no labels"   |
| `--dispatcher`  | `EBBGATE_DISPATCHER_URL`  | default `http://127.0.0.1:8790`                    |
| `--secret-file` | `EBBGATE_SECRET_FILE`     | or `EG_PAPERCLIP_SECRET`; never pass it in argv    |

The secret is the dispatcher's `paperclip.sharedSecret` (the same admin credential as
`/status` in v0.1). Keep the file `chmod 600`, readable by the Paperclip process only.

## Example: Mac first, VPS as overflow

Paperclip and the Ebbgate dispatcher run on the VPS. `mac` is an SSH environment
pointing at your Mac (Ebbgate node `mini`); `vps` is the local environment.

```jsonc
// environment "mac" (driver: ssh)
{ "capacity": { "admissionCommand": [
  "ebbgate", "admit", "--node", "mini", "--environment", "mac",
  "--secret-file", "/etc/ebbgate/admit.secret"
] } }

// environment "vps-ops" (driver: local), used only by internal/public agents
{ "capacity": { "admissionCommand": [
  "ebbgate", "admit", "--remote", "--environment", "vps-ops", "--agent", "agent_ops",
  "--secret-file", "/etc/ebbgate/admit.secret"
] } }

// agent "agent_ops": default environment "mac"
{ "runtimeConfig": { "fallbackEnvironmentIds": ["vps-ops"] } }
```

## Limits today (and what we are proposing upstream)

1. **No run context.** #17402 runs a static argv per environment with the controller's
   inherited environment: the probe is not told which agent, issue or run it is
   judging. So `ebbgate admit` cannot know the agent unless the argv says so, and a
   bare `--remote` probe treats every run as private (refuses). Workaround: give each
   non-private agent its own fallback environment with `--agent <id>` in the argv, as
   in `vps-ops` above. Proposal: pass non-secret run context (agent id, issue id,
   environment id, run id) to the probe as env vars.
2. **No distinct "hold".** Refusing everywhere already makes Paperclip wait, but the
   run shows up as `workspace_busy` ("Waiting for a free environment run slot"), not
   "waiting for your Mac". Proposal: a distinct exit code meaning _hold_ with a reason
   shown to the operator.
3. **Single-environment agents skip admission.** If an agent has no fallbacks,
   #17402 returns the primary environment without running the probe. Add at least one
   fallback for the check to apply.
4. **Session affinity.** Paperclip tries the host that ran the same session first;
   if it refuses, the next host starts a fresh session.

Ebbgate never reads `PAPERCLIP_*` variables for admission: until Paperclip defines
them, an inherited variable from the controller's own environment could misidentify
the agent.
