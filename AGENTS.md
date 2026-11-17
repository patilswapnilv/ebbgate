# AGENTS.md

Guidance for coding agents (Cursor, Claude Code, Codex) working on Ebbgate.

1. Read `BUILD_SPEC.md` first. It is the source of truth for scope, architecture and milestones.
2. Current status: **M2 in review** (`packages/dispatcher`, PR #1). Later milestones (M3 agent, M4 cli/compose, M5 docs/`EG_DEMO`) land as stacked PRs — one milestone per PR.
3. Work one milestone at a time and stop with a summary: what was built, test results, open `TODO(verify-paperclip)` items, decisions made.
4. Never break the privacy invariants in spec §1. They are covered by tests in `packages/core/test/privacy.property.test.ts`; add equivalent tests for every new routing path.
5. Do not invent Paperclip API shapes; see spec §7.
6. Checks before you finish: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Branches and pull requests

- **One milestone per PR.** Never push a new milestone onto an open PR. Start a branch named `cursor/m<N>-<topic>` from the previous milestone's branch (or `main` once it is merged) and open a PR against it.
- Review fixes for a milestone go on that milestone's branch. If later milestones are stacked on top, rebase them afterwards.

## Workspace packages

- **Every package must resolve from source for typecheck and tests.** CI runs `pnpm typecheck` and `pnpm test` before `pnpm build`, so `dist/` does not exist yet. Each package's `package.json` `exports["."]` starts with `"ebbgate-source": "./src/index.ts"` (as in `packages/core`), each `tsconfig.build.json` sets `"customConditions": []`, and `vitest.config.ts` aliases every `@ebbgate/*` package to its `src/index.ts`.
- Verify the CI order from a clean tree: `rm -rf packages/*/dist && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

## Patterns that already exist (reuse them, do not reinvent)

- **Entrypoints:** use `isEntrypoint(import.meta.url)` (`packages/dispatcher/src/main.ts`). It compares realpath'd URLs, so bins work through symlinks.
- **Network listeners:** every server takes a configurable `host`. The default is loopback, and docs must say how other machines reach it.
- **Subprocesses and outbound HTTP:** always bounded by a timeout (`execFile` `timeout`, `AbortSignal.timeout`). Release response bodies you do not read.
- **Secrets:** never log or print config contents. Errors describe _where_ something is wrong, not _what_ the value was.
- **Concurrency:** state transitions in SQLite are conditional (`... WHERE status = ?`) and checked via `changes`. Serialized async passes start with `Promise.resolve().then(...)`, so the in-flight promise is assigned before the pass can finish.
- **Writing user files:** never overwrite an existing config without an explicit `--force` or a confirmation.

Toolchain notes: Node 22+, pnpm 10, TypeScript 7 (type declarations are emitted with `tsc -p tsconfig.build.json`, not tsup's dts plugin), Biome 2, Vitest.
