# Folio integrations

`Integration` represents a channel such as Lark. Its `Resource`s represent ingestion
capabilities: `lark/im` and `lark/email`. Both currently expose an empty `onIngest`.

## Package structure

```text
src/base/
  integration.ts          # Metadata, contexts, resources and lifecycle contracts
  define-integration.ts  # Shared lifecycle implementation
  index.ts               # @folio/integrations/base, without provider SDK imports
src/lark/
  metadata.ts            # Name, description, bundled logo and homepage
  index.ts               # Lark hooks composed with defineIntegration
  ...                    # Lark CLI, skills, registration and authorization
```

Each provider defines `id`, `name`, `description`, `logo`, and `homepage`, alongside
its static actions/resources and three lifecycle hooks. `id` is a stable storage
key. `logo` is a bundled image data URI so the desktop can display it offline; do
not use main-process filesystem paths or remote image URLs. Metadata is code-owned
catalog content, not installation state, and does not require a database migration.

`defineIntegration` composes those hooks with the common lifecycle. It serializes
installation/actions per provider, checks action availability after acquiring the
lock, forwards opaque callback payloads, tracks persisted progress by directory,
and publishes a checked state after a successful operation. During a running
operation, `check` immediately returns its live progress. Unknown failures are
sanitized; failure/cancellation clears live state even if persistence fails. Late
state callbacks from finished attempts are ignored. Providers own their resource
registration, credentials, state names, and setup work.

New providers import the base directly and export one definition:

```ts
import { defineIntegration } from '@folio/integrations/base'

export const provider = defineIntegration({
  id: 'provider', name: 'Provider', description: 'Provider description',
  logo: bundledLogoDataUri, homepage: 'https://provider.example',
  actions, resources,
  install: installDependenciesAndRegisterResources,
  check: inspectProviderFacts,
  onActionCallback: handleProviderAction,
})
```

Hooks receive the same host context. They do not need a second lifecycle wrapper,
lock, live-state map, or final check. Optional provider context fields can be typed
with `defineIntegration<ProviderContext>(...)`, as Lark does for a supplied app.
Register the resulting integration in the desktop's `IntegrationCatalog`; the
generic card reads its metadata and action labels. Provider-specific setup steps
and authorization UI remain separate concerns (currently supplied only for Lark).

## Protocol

- `actions` statically defines IDs, labels, and descriptions for UI rendering.
- `check(context)` inspects current facts and returns `{ state, actionIds }`.
  Only the exported `readyState` (`"ready"`) indicates success. Checks do not install,
  register, authorize, or write state. Operational errors fail with `IntegrationError`.
- `onActionCallback(context, actionId, payload?)` executes a user-selected action.
  It rejects unknown or stale actions, writes progress, and publishes the next checked
  state. It never automatically executes the next action. Lark's device flows await
  SDK/HTTP polling internally; their completion does not use the optional payload.
- `install(context)` installs dependencies and registers resources after confirmation.
  The `install` action delegates to the same implementation.

The host supplies `directory`, `writeState(state: string, data: unknown)`, and
`registerResource(resource)`. State data is opaque to the framework. A Lark-specific
view can display `url` and the SDK registration `expiresAt` or OAuth `expiresIn` in waiting states. Credential files never enter
these UI updates. The host must persist each state before completing `writeState`.

`registerResource` must upsert by integration ID + resource ID. The static `resources`
list provides runtime implementations to rebind persisted records after restart;
functions are not persisted. Resource registration means a capability is installed,
not that it is authorized. Installation records completion only after both upserts
succeed, so partial registration can be retried.

## Lark flow

| Checked state | Available action | Progress states |
| --- | --- | --- |
| `install_required` | `install` | `installing` |
| `app_required` | `create_app` | `creating_app`, `waiting_for_app` |
| `app_authorization_required` | `verify_app` | `verifying_app` |
| `login_required` | `refresh_auth` (when refreshable), `authorize` | `refreshing_auth`, `authorizing`, `waiting_for_user` |
| `ready` | none | none |

The host renders the available actions, confirms the selected action, and awaits
`onActionCallback`. Progress arrives through `writeState`. On failure it displays the
error and checks again. On cancellation or app restart it checks facts again rather
than trusting a persisted waiting state. In-process actions are serialized; `check` returns live progress immediately while
action callbacks wait for authorization. Failed and interrupted actions write
`action_failed` and `cancelled`, respectively, and clear their live state. Late SDK
callbacks cannot resurrect a completed attempt. Avoid multiple processes operating
on the same directory.

Lark reuses PATH `lark-cli` first, then its managed CLI. Only a missing executable
triggers local npm installation of `@larksuite/cli@1.0.94`; a broken CLI is an error.
Skills `lark-shared`, `lark-im`, and `lark-mail` are copied with their complete trees
and license from official `larksuite/cli` commit
`f065bf5b645af381f9b7475ce721451e6ca36a23` (v1.0.94). Downloads are staged before
publication. An incomplete existing skills directory is not overwritten; move it
aside and retry. Installation requires npm and Git as applicable.

Application registration uses `@larksuiteoapi/node-sdk@1.73.3` `registerApp`, following
kb-wiki's `app-registration.ts`; user verification uses SDK `authen.userInfo.get`.
The SDK does not expose device OAuth, so authorization uses the official device and
token HTTP endpoints as in kb-wiki. Registration forwards the verification URL,
forwards polling/slow-down/domain-switch status, and saves application credentials
before exchanging the app access token. A failed exchange can be retried with
`verify_app` without creating another app. Token exchange uses SDK `Client.request`
and validates the actual top-level response shape, following the reference file.
Only then does setup move on to user OAuth. IM and Email read permissions
are requested together; resource selection is not implemented yet. A host-provided
`app: { clientId, clientSecret, brand }` skips application registration.

```text
~/.folio/integrations/lark/
  installed.json   # Written after dependencies and resource registration complete
  app.json         # App credentials
  app-auth.json    # App/tenant tokens and expiry
  state.json       # Live test host: persisted UI state
  resources.json   # Live test host: resource metadata
  auth.json        # User tokens, expiry, scope, and identity
  cli/             # Only when no system CLI is available
  skills/
    lark-shared/
    lark-im/
    lark-mail/
    LICENSE
```

The host chooses `directory`. The live tests use this default layout and honor
`FOLIO_CONFIG_DIR`. Private state is atomically written with mode `0600` under a `0700`
directory. Tokens are not encrypted. Expired app tokens offer `verify_app`; expired user tokens offer `refresh_auth`
when a usable refresh token exists, as well as explicit reauthorization. Refresh
rotates and atomically saves the token pair before identity verification; readiness
requires that the verified identity still matches the saved user. A failed verification
keeps the rotated pair for retry. No automatic background refresh, vault
links, or ingestion is implemented; both Resource `onIngest` hooks remain empty. The previous `lark-im` state directory is not automatically migrated.

## Host example

```ts
import { lark, readyState } from '@folio/integrations'

// Inside Effect.gen, with platform services supplied by the host:
const context = {
  directory: integrationDirectory,
  writeState: (state: string, data: unknown) => store.writeState(state, data),
  registerResource: (resource) => store.upsertResource(lark.id, resource),
}
const result = yield* lark.check(context)
yield* context.writeState(result.state, { actionIds: result.actionIds })
// Render lark.actions filtered by result.actionIds.
// After a user selects an action:
yield* lark.onActionCallback(context, selectedActionId)
// Only a subsequent check returning readyState authorizes ingestion.
```

The explicit live installation test confirms each action, persists UI state and resource
metadata, and displays authorization URLs. It passes only after reaching `ready` and
registering both resources; declining an action fails the test rather than reporting
an incomplete installation as success:

```sh
npm run test:lark:install --workspace=@folio/integrations
```

## Verification

```sh
npm run typecheck --workspace=@folio/integrations
npm run test --workspace=@folio/integrations
# After real setup: performs one read-only CLI listing per Resource, prints counts only.
npm run test:lark:verify --workspace=@folio/integrations
```

Tests use temporary directories, simulated processes, SDK fixtures, and mocked HTTP
responses. They cover explicit progression, dependency failure/reuse, resource upsert
recovery, stale/duplicate callbacks, state-write failure, cancellation, OAuth
pending/denial/expiry, app token exchange/retry/expiry, refresh token rotation,
nonblocking checks, registration status ordering, credential privacy, and empty
ingestion hooks.
No real account registration or OAuth is performed by tests.

The two live cases live in `tests/install-lark.test.ts` and
`tests/verify-lark.test.ts`. They are skipped by the default `npm test` run. The
explicit commands use `vitest.live.config.ts` to enable them, serialize test files,
and show interactive prompts. Run installation in a terminal; its timeout is 15
minutes, while verification has a 90-second timeout. Test cancellation interrupts
Effect operations, child processes, and pending authorization. Use `FOLIO_CONFIG_DIR`
to select another configuration directory. Normal fixture tests remain offline.
