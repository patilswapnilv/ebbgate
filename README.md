# Ebbgate

**Agents flow to the cloud when your machine sleeps. Private work waits at the gate.**

Ebbgate is a presence-aware task dispatcher for AI agents orchestrated by [Paperclip](https://paperclip.ing).

- When your machine is **available**, agent tasks run on it: local models, local files, zero token cost.
- When you're **busy** on it, only private work stays local, at low priority. Everything else moves to the cloud.
- When it's **offline**, non-private work runs on a cloud runtime. **Private work waits** and resumes automatically when your machine comes back.

Model-level fallback (per LLM call) stays with [LiteLLM](https://github.com/BerriAI/litellm). Ebbgate works one level up: per **task**.

> **Status: pre-alpha.** Milestone 1 (the policy engine) is done. The dispatcher, presence agent and CLI are next. See [`BUILD_SPEC.md`](./BUILD_SPEC.md).

## How it decides

| Task              | Machine available  | Machine busy        | Machine offline |
| ----------------- | ------------------ | ------------------- | --------------- |
| Private           | Local              | Local, low priority | **Wait**        |
| Internal          | Local              | Cloud               | Cloud           |
| Public            | Cloud              | Cloud               | Cloud           |
| Needs local files | Local              | Local, low priority | Wait + notify   |
| Unknown agent     | treated as private |                     |                 |

The rules live in one file, `ebbgate.yaml` ([example](./ebbgate.example.yaml)). Two independent safeguards keep private work local:

1. **At startup**, any rule that could send a private task to the cloud is rejected, with the exact path of the offending setting.
2. **At runtime**, every decision passes a final guard that turns a private→cloud decision into a wait.

Both are covered by tests, including a randomized test over thousands of generated policies.

## Packages

| Package               | Purpose                                                            | Milestone |
| --------------------- | ------------------------------------------------------------------ | --------- |
| `@ebbgate/core`       | Config schema and the pure policy engine                           | ✅ M1     |
| `@ebbgate/dispatcher` | HTTP service: Paperclip adapter endpoint, presence, deferred queue | M2        |
| `@ebbgate/agent`      | macOS presence agent, busy toggle, runner shim                     | M3        |
| `@ebbgate/cli`        | `npx ebbgate init` wizard, LiteLLM config generator                | M4        |

## Development

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm test        # vitest
pnpm lint        # biome
pnpm typecheck
pnpm build
```

## License

MIT. Built on Paperclip, LiteLLM and Ollama. Not an official Paperclip project.
