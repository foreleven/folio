# Code organization

Organize implementations by capability within their existing process/package
boundary. Keep tests beside their implementation where that is the established
pattern; do not add forwarding files at former paths.

- `apps/desktop/src/main/services/`: capability modules; see the
  [service directory guide](../apps/desktop/src/main/services/README.md).
- `apps/desktop/src/main/{electron,rpc,workers}/`: Electron adapters, RPC adapters
  and worker transport respectively. These small, cohesive directories remain flat.
- `apps/desktop/src/shared/`: cross-process domain contracts, with RPC contracts in
  `rpc/`. Individual domain schema files remain directly accessible; they do not
  need single-file subdirectories.
- `apps/desktop/src/renderer/src/`: existing feature directories such as `tasks/`,
  `routines/`, `vault/`, `welcome/` and `settings/`. Shared RPC clients and hooks
  remain separate. Model and integration settings already have dedicated folders.
- `packages/agent/src/`: existing `acp/`, `codex/`, `pi/`, `config/`, `model/` and
  `runtime/` modules. `tests/` now mirrors these capabilities; `integration/`
  contains CLI, stdio, worktree and Git lifecycle scenarios. Shared fixtures and
  server support remain in `tests/fixtures/` and `tests/support/`.
- `packages/integrations/src/`: existing provider modules (`lark/`, `gmail/`) and
  their shared contract in `base/`; assets stay with their provider.
- `packages/ui/src/`: shared UI primitives, hooks and utilities. Primitives are
  intentionally flat under `components/ui/`, as they have no application domain.

New files should go into the module that owns their behavior. Retain explicit
cross-module imports, stable package exports and process boundaries; a directory
move alone should not alter runtime behavior or public contracts.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm --filter @folio/agent build
pnpm --filter @folio/agent test
pnpm --filter @folio/desktop test
pnpm --filter @folio/desktop test:packaging
```

Build before running desktop tests: Worker integration tests load
`apps/desktop/out/main/agent-worker.js`. On macOS, when `TMPDIR` points through
`/var` or `/tmp` symlinks, run desktop tests with `TMPDIR=/private/tmp` so temporary
Vault paths satisfy the existing canonical-path check in `VaultRuntime`.
