# Main-process services

Services are grouped by the capability they own. Keep implementation tests beside
the service and import concrete files directly, following the existing project
pattern. Folder boundaries organize code; they do not change Effect service keys,
RPC contracts, layer ownership, or resource lifetimes.

| Directory       | Responsibility                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `agent/`        | Packaged Agent runtime paths and worker pool                                                       |
| `config/`       | Global application configuration                                                                   |
| `execution/`    | Durable execution queue, scheduling, recovery, event sink and run files                            |
| `git/`          | Vault Git operations, change snapshots, journal, application and workspace changes                 |
| `harness/`      | Task/session/run records, Agent sessions, run orchestration and ACP event projections              |
| `integrations/` | Integration catalog, setup/actions and global installation storage                                 |
| `models/`       | Model profiles and provider credentials                                                            |
| `routines/`     | Routine storage and periodic dispatch                                                              |
| `system/`       | Application/system information                                                                     |
| `tasks/`        | Task use cases, resource preparation, worktrees, synchronization and operation lifetime            |
| `vault/`        | Vault registration, workspace initialization, database migrations, context and runtime composition |
| `testing/`      | Shared test-only execution fixtures                                                                |

`program.ts` composes application-scoped services. `vault/vault-runtime.ts`
composes services scoped to a Vault. Cross-module imports are intentional: for
example, task use cases coordinate harness records, executions and Git changes.
Keep those dependencies explicit rather than adding barrel exports or duplicating
services between folders. The database and its migrations stay together under
`vault/` because one Vault database serves several capabilities.

Other main-process boundaries remain separate: `rpc/` adapts contracts to services,
`electron/` owns Electron APIs and windows, and `workers/` owns the worker entry
point and transport. Their files already share a focused responsibility.
