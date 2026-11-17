# Policy

Policy lives in `ebbgate.yaml`. Rules are **first-match**. The last rule must be `default`.

## Matrix (defaults from the example config)

| Task                | available          | busy      | offline |
| ------------------- | ------------------ | --------- | ------- |
| private             | local              | local-low | defer   |
| internal            | local              | cloud     | cloud   |
| public              | cloud              | cloud     | cloud   |
| label `local-files` | local              | local-low | defer   |
| unknown agent       | treated as private |           |         |

## Actions

| Action      | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `local`     | Run on an `available` node (prefer `prefer: true`, then free RAM). |
| `local-low` | Same, but also accept `busy` nodes.                                |
| `cloud`     | Forward to `cloud.runner`.                                         |
| `defer`     | Persist until a local node is available; never lost.               |

If `local` / `local-low` finds no eligible node, the rule’s `offline` action is used.

## Privacy guards

1. **Load time** — `validatePrivacy()` rejects any rule that could match private work and choose `cloud`.
2. **Runtime** — `decide()` rewrites private→cloud to defer.

Unknown agents resolve to `private` (fail closed).

## Annotated example

See [`ebbgate.example.yaml`](../ebbgate.example.yaml). Match on `tier` and/or `label`. Set `notify: true` on a rule to fire the notifier when that rule defers.
