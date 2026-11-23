# Changesets

Only the `ebbgate` npm package (`packages/cli`) is published; the `@ebbgate/*`
workspace packages are private and bundled into it.

- Add a changeset with every user-visible change: `pnpm changeset` (pick `ebbgate`).
- To cut a release: `pnpm version-packages` in a PR, merge it, then tag `vX.Y.Z`
  (or run the **Release** workflow manually). The workflow publishes to npm with the
  `NPM_TOKEN` repository secret.
