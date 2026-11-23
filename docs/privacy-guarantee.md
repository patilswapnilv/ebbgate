# The privacy guarantee

Ebbgate makes one promise, and this repo tests it on every CI run:

> **A task whose agent is not explicitly configured as `internal` or `public` is never sent to the cloud runner. Unknown means private.**

Everything else Ebbgate does (presence, queueing, waking, admission) is allowed to fail, retry, or wait. None of it is allowed to break that sentence.

## The guarantee, precisely

Let `cloud.runner` be the URL in your `ebbgate.yaml` and let `tier(agent)` be the tier the **config file** gives that agent id (an exact, case-sensitive, own-key match in `agents:`).

1. **No private payload reaches the cloud runner.** The dispatcher never sends an HTTP request to `cloud.runner` for a run whose agent has `tier(agent) = private`, or whose agent is not listed. This holds on every path that can send work: ingress (`POST /run`), re-dispatch after a node drops, and recovery after a dispatcher restart.
2. **Unknown means private.** Any agent id not in `agents:` is `private`. That includes near-misses (`AGENT_X`, trailing spaces, homoglyphs) and names that exist on every JavaScript object (`constructor`, `__proto__`, `toString`). A tier value that isn't exactly `internal` or `public` also counts as private.
3. **The caller cannot lower the tier.** The tier comes only from the config. Fields in the Paperclip payload (`tier`, `private`, labels such as `public`) can't change it. Labels can make a task stricter (a `local-files` rule) but never let a private task reach the cloud.
4. **No admission into a remote environment for private work.** `decideAdmission()`, `POST /admit` and `ebbgate admit --remote` never admit a run whose tier is private, whose agent is unknown or missing, or whose issue is flagged private. `ebbgate admit` re-checks the dispatcher's answer itself, so even a buggy or spoofed dispatcher can't get a private run admitted remotely.
5. **Configs that could break the promise don't load.** The dispatcher refuses to start if any policy rule that can see private tasks uses `cloud`, or if a node's runner is the cloud runner (which would make "local" mean cloud).
6. **The dispatcher's credential stays home.** Cloud forwards never carry the dispatcher's shared secret. A cloud runner holding it could otherwise call `/status` and read in-flight private payloads.

What "private work" may do instead: run on one of your own nodes, or wait in the SQLite defer queue until one is available. Waiting is always allowed. Leaking is not.

## Defences, in layers

| Layer             | Where                                                                          | What it does                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config validation | `validatePrivacy`, `validateRunnerSeparation` in `packages/core/src/config.ts` | Rejects any first-match rule that can see private tasks and uses `cloud`, and any node whose runner is the cloud runner.                                                                        |
| Tier resolution   | `resolveTier` in `packages/core/src/policy.ts`                                 | Own-key lookup only. Unknown, missing or non-tier values resolve to `private`.                                                                                                                  |
| Runtime guard     | `guard` / `mayRunInCloud` in `packages/core/src/policy.ts`                     | Every `decide()` result passes through it. A cloud decision for anything not `internal`/`public` becomes `defer`.                                                                               |
| Dispatch checks   | `routes/run.ts`, `services/presence.ts` (recovery)                             | Re-check `mayRunInCloud` right before a cloud forward.                                                                                                                                          |
| Recovery          | `recoveryTask` in `services/presence.ts`                                       | A stored payload that can't be re-parsed is treated as private.                                                                                                                                 |
| Admission         | `decideAdmission` in `packages/core/src/admission.ts`, `ebbgate admit`         | Missing agent or `issuePrivate` means private. Unknown labels are evaluated under every label rule (stricter only). The CLI refuses a remote admit for any tier other than `internal`/`public`. |
| Presence          | `deriveState`                                                                  | Freshness uses the dispatcher's own clock, never the Mac's `sentAt`. A heartbeat from too far in the future reads as offline. Presence decides local versus wait, never private versus cloud.   |

Each layer is tested on its own. The property tests check that validated configs never even _need_ the runtime guard, and separately that the guard alone holds for configs that skipped validation.

## Threat model

**In scope.** These are what the suite tries to break.

- **Unknown or unlisted agents**, including Object-prototype names and near-miss ids.
- **Hostile or malformed payloads** from an authenticated caller: a missing or wrong-type `runId`, `agentId`, `context` or `labels`; spoofed `tier` or `private` fields; very large label sets.
- **Policy file problems**: missing, empty, invalid YAML, unresolved `${VAR}`, wrong-case or unknown tiers, unknown keys, rules that can route private work to the cloud, or a node runner that equals the cloud runner.
- **Presence problems**: missing, stale, future-dated or tampered heartbeats; the dispatcher's clock jumping backwards; a skewed Mac clock; flapping between available, busy and offline; presence from unknown nodes or with bad tokens.
- **Crashes**:
  - A crash between `decide()` and dispatch.
  - A crash mid-forward.
  - Crash loops.
  - A node dropping while a private run is in flight.
  - A corrupted stored payload.
  - An agent removed from the config across a restart.
- **The cloud as the only reachable target**: no node has ever reported, or every node is offline or busy.
- **Admission with the Mac offline**, through all three surfaces: `decideAdmission`, `POST /admit` and `ebbgate admit`. This includes a dispatcher that lies, times out, or returns malformed answers.
- **Concurrency**: hundreds of concurrent runs while presence, the clock and recovery all move. This includes duplicate run ids and recovery passes racing in-flight forwards.

**Out of scope.** These are documented, not defended.

- **Misclassification by the operator.** If you set `agent_inbox: { tier: public }`, Ebbgate will send its work to the cloud. The guarantee is about honouring the config, not judging it.
- **A compromised Paperclip or a leaked shared secret.** An authenticated caller can claim any `agentId`, so it can pass a private agent's work off under a public agent's id. Ebbgate trusts the `agentId` that Paperclip, the authenticated orchestrator, sends.
- **What runs on your nodes.** A local runner, or a local model that makes its own cloud calls, is outside Ebbgate's reach.
- **Paths that don't go through Ebbgate**, such as Paperclip environments with no `admissionCommand`, or agents that call the cloud directly.
- **Network-level attackers** between the dispatcher and the runners. Use TLS, a VPN or Tailscale. See [security.md](./security.md).
- **Metadata.** Paperclip issue comments and the `waiting-for-local` label say that a task was deferred, never what it contains.
- **Config changes.** If you make an agent `public`, its queued and recovered runs follow the new config after a restart. This is by design: the config is the source of truth.

## How the suite verifies it

The suite lives in `packages/*/test/privacy-guarantee/` and runs with:

```sh
pnpm test:privacy          # the adversarial suite (+ the original core property test)
pnpm test:privacy:mutants  # break each defence on purpose; the suite must catch every one
```

CI runs both on Linux, and `test:privacy` again on macOS.

- **The oracle is the network, not the code.** Dispatcher tests swap `fetch` for a recorder. After every test, `assertNoPrivateLeak` checks three things. Every request that reached the cloud runner URL belongs to an explicitly `internal` or `public` agent and carries no shared secret. Every recorded `cloud` decision has such a tier. Every `runs` row targeting the cloud belongs to such an agent. Tests that expect cloud traffic also assert that some actually happened, so a suite that sends nothing can't pass vacuously.
- **Real restarts.** The harness uses a file-backed SQLite database and rebuilds the app on the same file, so restart and crash tests go through the real migration and recovery code.
- **Property-based fuzzing ([fast-check](https://fast-check.dev)).**
  - Random policy sets: 5,000 runs per property.
  - Random agent ids, labels and node states.
  - Non-tier values.
  - Random admission bodies over HTTP.
  - Random sequences of `/run` requests, presence reports, clock jumps (backwards too) and restarts against the full dispatcher.
  - Failures shrink to a minimal counterexample, and the seed is printed so it can be replayed.
- **Mutation check.** `scripts/privacy-mutants.mjs` disables each defence in turn and fails if the suite still passes: the runtime guard, config validation, runner separation, unknown-means-private, clock-skew handling, `issuePrivate`, the missing-agent rule, the CLI re-check, recovery fail-closed, and keeping the secret off cloud forwards. If you add a defence, add a mutant for it.

| File                                 | Covers                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/.../config.test.ts`            | Missing, empty or invalid policy files; leaky rule shapes; tier typos; runner separation; `__proto__` agent keys                                             |
| `core/.../policy-fuzz.test.ts`       | Validation soundness; the guard on its own; ghost nodes; admission invariants                                                                                |
| `core/.../presence.test.ts`          | Missing, garbage or future heartbeats; freshness window property                                                                                             |
| `dispatcher/.../ingress.test.ts`     | Unknown agents, cloud as the only target, spoofed fields, labels, malformed payloads, auth, a busy Mac, a failing local runner, the credential not forwarded |
| `dispatcher/.../presence.test.ts`    | Stale, skewed or tampered heartbeats, unknown nodes, 300-step flapping                                                                                       |
| `dispatcher/.../restart.test.ts`     | Crash before or after dispatch, mid-forward, node drops, corrupted payloads, config changes, crash loops                                                     |
| `dispatcher/.../concurrency.test.ts` | 400 concurrent runs with flapping; duplicate ids; racing recoveries                                                                                          |
| `dispatcher/.../admission.test.ts`   | `POST /admit` with the Mac offline, `issuePrivate`, ghost nodes, malformed bodies, an HTTP property test                                                     |
| `dispatcher/.../fuzz.test.ts`        | End-to-end random sequences with restarts                                                                                                                    |
| `cli/.../admit.test.ts`              | `ebbgate admit` with the Mac offline, `--private`, a lying, hanging or unreachable dispatcher, usage errors                                                  |

## Found and fixed while building the suite

- **The runtime guard only matched the literal string `"private"`.** A `TaskContext` whose tier was missing or misspelled, which an untyped caller of the exported `decide()` could produce, fell through to a `cloud` default. The guard now allows the cloud only for `internal` and `public`.
- **A node's runner could be the cloud runner.** That config loaded, and then "local" private work went to the cloud. It is now rejected at startup.
- **Cloud forwards carried the dispatcher's shared secret** in `Authorization`. With it, the cloud runner could call `/status`, whose `inFlight` list includes payloads of private runs on your Mac, or `/admit` and `/run`. Cloud forwards no longer carry it. Local runners still do.
- **Remote admission trusted the dispatcher completely.** `ebbgate admit` now refuses a remote admit unless the tier is `internal`/`public` and `--private` isn't set.
- **Lookups used inherited keys.** Node and agent lookups now check own keys only. `/presence` with `node: "constructor"` used to crash with a 500 instead of returning 404. It failed closed, but by accident.
- **Future-dated heartbeats.** After the dispatcher's clock jumped backwards, a node stayed "fresh" for as long as the jump lasted. It now reads as offline. This never leaked to the cloud, but it was a hole in the "presence is honest" assumption.
