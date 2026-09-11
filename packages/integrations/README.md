# Folio integrations

An `Integration` owns a provider connection. Its resources describe ingestion
capabilities; Lark registers `im` and `email`. Their `onIngest` hooks declare the
corresponding installed Skills, shared rules, and managed CLI directory. They do
not fetch data or start an Agent; the harness mounts these resources for the Task.

## Ownership

- Providers own credentials, business states, translations, available actions,
  connection flows, and background renewal/retry policy.
- `defineIntegration` serializes user operations, revalidates actions, tracks live
  progress, and prevents late callbacks from replacing completed attempts.
- The desktop hosts the catalog, SQLite snapshots, HTTPS navigation, and scoped
  jobs. Its renderer consumes the protocol without branching on provider IDs,
  business states, or action IDs. Only the composition root imports Lark.

```text
src/base/
  protocol.ts             # Serializable text, state presentation, actions and fields
  integration.ts          # Provider and host capability contracts
  define-integration.ts   # Shared user-operation lifecycle
src/lark/
  metadata.ts             # Provider identity and localized state presentation
  index.ts                # Installation, connection flow and provider lifetime
  connection.ts           # Credential verification, renewal, backoff and coordination
  auth.ts                 # SDK/HTTP authorization transport
  state.ts                # Schemas, consolidated private state and legacy migration
```

## Protocol

Metadata includes `id`, `name`, `description`, `logo`, `homepage`, `states`,
`actions`, and `resources`. IDs are stable opaque keys. Logos are bundled data
URIs. Provider text is either a string or `{ en, 'zh-CN' }`; `integrationText`
selects the current locale. State labels and action labels live with the provider,
not in an App translation table.

`states` maps provider state IDs to `{ kind, label, description? }`. The shared
kinds are `ready`, `working`, `waiting`, `attention`, and `unavailable`. An
operation being busy is separate from connection availability: an external action
can remain usable while a job is waiting for browser approval.

Static action definitions supply `{ id, label, description?, fields? }`.
Available actions returned by inspection reference those definitions:

```ts
{ id: 'configure', type: 'callback', primary: true }
{ id: 'open', type: 'open-url', url: 'https://provider.example/authorize', primary: true }
```

Nominate at most one primary action per snapshot. Other actions appear in the
card's menu; array order does not decide the primary action. The host handles
`open-url` and accepts only HTTPS URLs without embedded credentials. Providers
validate their own authorization domains before publishing URLs.

A callback can declare a form:

```ts
{
  id: 'configure',
  label: { en: 'Configure account', 'zh-CN': '配置账号' },
  fields: [
    { id: 'accessKey', label: 'AccessKey', type: 'text', required: true },
    { id: 'secretKey', label: 'SecretKey', type: 'password', required: true }
  ]
}
```

The desktop displays a modal, checks required fields, and sends
`{ id, actionId, payload }` to the host. Input values are not copied into state
snapshots or static definitions. The provider must validate the payload against
its own credential schema and save it privately. The host acknowledges job
ownership; subsequent success/failure arrives through the watch stream. Forms
clear inputs after acknowledgement, rejection, or dismissal, and stale forms
cannot submit an unavailable action.

## Lifetimes and host context

- `install()` prepares dependencies and upserts resources after an explicit user
  request. It never initiates browser authorization.
- `inspect()` reads facts and returns `{ state, actions }`. It does not install,
  authorize, refresh tokens, or persist provider state. During a user operation,
  the base returns the last published live progress without blocking on OAuth.
- `onActionCallback(actionId, payload?)` handles a currently available callback.
  One action can orchestrate all provider-specific steps, including waiting for
  browser approval. The base publishes a final inspection on success.
- Optional `run()` owns the provider's background lifetime. The desktop starts it
  once for an installed integration, including after restart, and interrupts it
  when the main-process scope closes. Browsing an uninstalled catalog entry never
  starts it. Closing a settings window does not stop it. Providers serialize
  background credential mutations with their own foreground connection flow.

No `reconcile` hook or scheduler is added. A future `IntegrationContext.scheduler`
can replace provider-owned timing; currently Lark controls its own sleeps and retries.

Hooks obtain `IntegrationContext` with `yield* IntegrationContext`:

- `directory`: installation-private storage location.
- `writeState(state, data, actions?)`: atomically commits public state and currently
  available actions before returning. Omitted actions clear the previous list.
  Do not put credentials or SDK diagnostics in public data.
- `registerResource(resource)`: upserts by integration ID + resource ID. Resource
  registration means installed capability, not current authorization.

Other platform services remain in the Effect environment. Hosts must preserve
those requirements when supplying the per-installation context. Static resource
implementations rebind persisted metadata after restart; functions are not stored.
Old SQLite records and private credential files are reused. Restart checks rebuild
current actions, so legacy action IDs and expired OAuth URLs are never replayed.

## Lark behavior

Installation prepares the CLI and skills, registers resources, and verifies any
existing credentials. The `connect` action resumes saved progress: create an app
if absent, exchange app credentials, and request user OAuth when necessary. The
only other actions are installation recovery and opening a live authorization URL.
Verification and refresh are internal operations, not user-facing action IDs.

Lark renews app/user credentials before expiry. A failed proactive renewal leaves
a still-valid verified connection ready. Temporary failures after expiry show
`recovering` with no reauthorization action; permanent rejection or a missing grant
makes `connect` available. Network failures use bounded exponential backoff. The
provider's work stops on full application exit and resumes from private files on
restart. There is no separately installed background daemon.

Refresh tokens may rotate. Save the new pair atomically **before** checking user
identity, with `verified: false`. Only a matching identity marks that pair verified;
a network failure preserves it for retry, including after restart. Legacy records
without `verified` are previously verified records. Neither unknown responses nor
a different user identity can publish a newly rotated pair as ready.

Lark uses the Folio-managed `lark-cli`; it never executes a global PATH copy.
Missing tools are extracted from bundled `lark-cli@1.0.94` (macOS arm64). Bundled
skills are `lark-shared`, `lark-im`, and `lark-mail` from `larksuite/cli` commit
`f065bf5b645af381f9b7475ce721451e6ca36a23`, with complete trees and license. An
incomplete existing skills directory is not overwritten. Electron injects packaged
asset paths at the composition boundary.

SDK 1.73.3 handles application registration, app token exchange, and user identity
verification. Device OAuth uses the official HTTP endpoints because the SDK does
not expose that flow. SDK logging is suppressed to avoid raw credential-bearing
transport diagnostics. `LarkApplication` optionally supplies existing application
credentials; otherwise Lark reads its private consolidated state.

```text
~/.folio/integrations/lark/
  private.json     # Versioned installation, application and token state
  cli/
  skills/
```

The former `installed.json`, `app.json`, `app-auth.json`, and `auth.json` layout is
read-compatible and migrates atomically to `private.json` when the provider runtime
starts or state next changes. Files use atomic replacement with mode `0600` inside a
`0700` directory. They are not encrypted. Vault linkage and ingestion are outside
this change. The historical `lark-im` directory is not automatically migrated.

## Verification

```sh
npm run typecheck
npm run test --workspace=@folio/integrations
npm run test --workspace=@folio/desktop
npm run build
```

Fixture tests use temporary directories, mocked SDK/HTTP responses, and Effect's
TestClock. They cover installation reuse/failure, partial resource registration,
OAuth approval/denial/expiry/slow-down, stale and duplicate actions, token rotation,
expiry-driven renewal, transient failures, identity mismatch, restart recovery,
background shutdown, payload privacy, and generic non-Lark UI forms.

Opt-in live tests perform real setup or read-only IM/Email verification:

```sh
npm run test:lark:install --workspace=@folio/integrations
npm run test:lark:verify --workspace=@folio/integrations
```

They are skipped in default tests. Installation requires an interactive terminal
and explicit browser approval. `FOLIO_CONFIG_DIR` selects a separate private state
directory. Historical live results are recorded in `VERIFICATION.md`; they do not
constitute live verification of subsequent refactors.
