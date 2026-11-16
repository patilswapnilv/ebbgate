# AGENTS.md

Guidance for coding agents (Cursor, Claude Code, Codex) working on Ebbgate.

1. Read `BUILD_SPEC.md` first. It is the source of truth for scope, architecture and milestones.
2. Current status: **M3 done** (`packages/agent`: presence daemon, busy CLI, runner shim, SwiftBar). **Next: M4** (`packages/cli` init wizard + compose quickstart).
3. Work one milestone at a time and stop with a summary: what was built, test results, open `TODO(verify-paperclip)` items, decisions made.
4. Never break the privacy invariants in spec §1. They are covered by tests in `packages/core/test/privacy.property.test.ts`; add equivalent tests for every new routing path.
5. Do not invent Paperclip API shapes; see spec §7.
6. Checks before you finish: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

Toolchain notes: Node 22+, pnpm 10, TypeScript 7 (type declarations are emitted with `tsc -p tsconfig.build.json`, not tsup's dts plugin), Biome 2, Vitest.
