# RFC: Sandboxed Agent Execution with Electron and sandbox-runtime

- **Status:** Draft
- **Authors:** Folio
- **Date:** 2026-09-09
- **Scope:** Electron desktop agent execution

## Summary

Folio needs to run agent-driven work in a workspace with OS-enforced filesystem and network restrictions. This RFC defines how to combine Electron, a Node runtime, and Anthropic's `sandbox-runtime` without making integrations responsible for process execution or sandbox policy.

`sandbox-runtime` is a sandboxing library and process wrapper. It does not ship Node, npm, or a virtual Node environment. It uses the host operating system's isolation primitives and applies restrictions to a process tree.

## Goals

1. Run agent commands with a controlled working directory and explicit filesystem access.
2. Prevent an agent from reading credentials, unrelated vaults, SSH keys, or the Electron profile by default.
3. Apply restrictions to child processes, including scripts launched by Node.
4. Keep integration providers focused on data acquisition and artifact production.
5. Use the same execution contract in development and packaged Electron builds.
6. Provide actionable diagnostics when a platform prerequisite or runtime is unavailable.

## Non-goals

- Reimplementing OS sandboxing inside JavaScript.
- Giving integrations direct access to sandbox policy details.
- Treating `sandbox-runtime` as a Node distribution.
- Making the Electron main process itself the untrusted agent runtime.
- Guaranteeing identical isolation semantics across operating systems.

## Terminology

- **Agent:** Untrusted or partially trusted code that transforms a workspace.
- **Workspace:** A per-run directory inside a vault, containing only the inputs and outputs required by the run.
- **Runner:** A trusted service that constructs and starts a sandboxed process.
- **Managed Node runtime:** The Node executable selected by Folio for running agent scripts.
- **Policy:** Allow-listed filesystem, network, environment, and process settings.
- **Integration:** A provider such as Lark that fetches source data and writes normalized artifacts. It does not launch agents.

## Proposed architecture

```text
Electron main process
  ├─ IntegrationService
  │    └─ integration provider (credentials + pull/onIngest)
  ├─ SandboxManager.initialize()
  ├─ NodeRuntime
  └─ SandboxRunner
       └─ sandboxed agent process tree
            └─ managed Node runtime
```

The main process remains trusted. `SandboxRunner` is the only boundary that starts agent processes. Integrations write input artifacts into a run workspace, then the runner starts the agent with that workspace as its current directory. Agent output is collected from declared output paths and validated before it is committed to the vault.

A recommended workspace layout is:

```text
~/.folio/vaults/<vault-id>/workspaces/<run-id>/
  input/       # immutable or read-only source artifacts
  work/        # scratch space
  output/      # declared Markdown and metadata outputs
  manifest.json
```

The agent receives the workspace path explicitly. It should not receive the vault root, global Folio directory, integration state, or credential paths unless a future capability explicitly grants them.

## Node runtime decision

`sandbox-runtime` requires a host Node installation (currently Node `>=20.11.0`) and does not bundle one. Folio must therefore provide a `NodeRuntime` abstraction.

### Option A: reuse Electron's executable

Electron can be launched as Node with:

```ts
spawn(process.execPath, [scriptPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
})
```

This reduces distribution size, but it is Electron-specific and must be verified in packaged builds on every supported platform. It also couples agent execution to Electron's embedded Node version and module/runtime behavior.

### Option B: bundle a standalone Node executable (recommended)

Ship a platform/architecture-specific Node binary under application resources and invoke it through the runner. This makes the runtime explicit, independently upgradeable, and easier to test. npm is not required for execution; agent dependencies should be bundled, vendored, or otherwise resolved before the sandboxed run.

The initial implementation should define the abstraction so either option can be selected without changing integrations:

```ts
interface NodeRuntime {
  readonly executablePath: string
  readonly version: string
  readonly kind: "bundled" | "electron"
  verify(): Effect<void, RuntimeUnavailable>
}
```

Use the standalone runtime for production unless cross-platform packaging tests prove Electron reuse is reliable.

## SandboxRunner contract

The runner is an Effect service injected into the application composition root. Integrations and agent code do not construct it directly.

```ts
interface SandboxRunner {
  run(request: SandboxRunRequest): Effect<SandboxRunResult, SandboxRunError>
}

type SandboxRunRequest = {
  command: string
  args: ReadonlyArray<string>
  cwd: string
  workspace: string
  readOnlyPaths: ReadonlyArray<string>
  writablePaths: ReadonlyArray<string>
  network: "none" | { allow: ReadonlyArray<string> }
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
}
```

The implementation should use `SandboxManager.initialize()` once during main-process startup, then use the platform-specific wrapping API (`wrapWithSandbox` or `wrapWithSandboxArgv`) for each process. On Windows, argv wrapping is required; shell-string wrapping is not portable.

The runner must:

- use an allow-list for writable paths;
- default to no network access;
- remove secrets and unrelated home-directory paths from the child environment;
- enforce a timeout and terminate the complete process tree;
- capture stdout, stderr, exit code, and structured failure diagnostics;
- reject paths outside the workspace unless explicitly allowed;
- fail closed when sandbox helpers or platform prerequisites are unavailable.

## Integration cooperation

An integration remains responsible for source-specific concerns:

1. authenticate and retain credentials in integration-owned state;
2. pull source data;
3. normalize it into workspace input artifacts;
4. provide a manifest describing inputs and expected outputs.

It does not know whether the agent is executed by Node, Electron's Node mode, or another runtime. `onIngest` receives an application context that can request an agent run through the generic `SandboxRunner` service.

Credentials must never be copied into the workspace or passed through arbitrary environment variables. If an agent later needs a privileged operation, expose it as a narrow brokered capability rather than widening filesystem access.

## Packaging requirements

- Place sandbox-runtime helper binaries and platform resources outside the ASAR archive, using `asarUnpack` or `extraResources` as required by the package.
- Resolve resource paths from the packaged application directory, not from the source tree.
- Ship the standalone Node executable per platform and architecture if Option B is selected.
- Check macOS Seatbelt availability, Linux bubblewrap/seccomp prerequisites, and Windows helper/ACL requirements during startup.
- Surface a clear `RuntimeUnavailable` state in the UI with a remediation action.
- Test both unpackaged development and signed/packaged artifacts.

## Lifecycle and failure states

Initialization should expose explicit states:

- `uninitialized`
- `ready`
- `runtime-unavailable`
- `sandbox-unavailable`
- `degraded` (only if policy explicitly permits a reduced capability; never silently bypass restrictions)

No agent run may start from an unsuccessful state. Diagnostics should include platform, runtime path/version, missing helper, and suggested remediation, while excluding credentials.

## Security boundaries

The sandbox policy and user approval policy are separate. A command may be approved by the UI and still be restricted by the OS sandbox. The default policy is:

- workspace read/write as declared;
- vault metadata read-only only when explicitly required;
- no global `~/.folio` access;
- no SSH/config/credential-store access;
- no network unless an allow-list is supplied;
- no inherited sensitive environment variables.

The sandbox is a defense boundary, not a substitute for validating generated Markdown, manifests, or file paths before committing them to a vault.

## Rollout plan

1. Add `NodeRuntime` and `SandboxRunner` Effect service definitions with fake implementations for tests.
2. Integrate `sandbox-runtime` initialization and platform diagnostics in Electron main startup.
3. Implement the standalone Node runtime resolver; keep Electron Node mode behind an explicit development flag.
4. Add a minimal agent command that reads `input/` and writes `output/`.
5. Add packaged-build tests on macOS, Linux, and Windows.
6. Connect `onIngest` to the runner only after the boundary and failure behavior are verified.

## Open questions

- Which OS and architecture matrix is supported for the first production release?
- Should agent dependencies be bundled per agent, installed in a trusted preparation step, or restricted to built-in scripts?
- What exact Markdown manifest and output validation rules should precede vault commit?
- Which network domains, if any, are safe defaults for future integrations?
- Is Electron Node reuse needed for development convenience, or can the standalone runtime be used everywhere?
