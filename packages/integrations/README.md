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

Hooks obtain host capabilities with `yield* IntegrationContext`, an Effect
`Context.Service`. They do not need a second lifecycle wrapper, lock, live-state
map, or final inspect. `Integration<R>` and `defineIntegration` preserve additional
service requirements in the Effect environment. Providers inject their own services
through Effect DI rather than extending the host context. The base overrides only
`IntegrationContext.writeState` for progress tracking and preserves other services.
Register the resulting integration in the desktop's `IntegrationCatalog`; the
generic card reads its metadata and action labels. Provider-specific setup steps
and authorization UI remain separate concerns (currently supplied only for Lark).

## Protocol

- `actions` statically defines IDs, labels, and descriptions for UI rendering.
- `inspect()` inspects current facts and returns `{ state, actions }`.
  Only the exported `readyState` (`"ready"`) indicates success. Checks do not install,
  register, authorize, or write state. Operational errors fail with `IntegrationError`.
- `onActionCallback(actionId, payload?)` executes a user-selected action.
  It rejects unknown or stale actions, writes progress, and publishes the next checked
  state. It never automatically executes the next action. Lark's device flows await
  SDK/HTTP polling internally; their completion does not use the optional payload.
- `install()` installs dependencies and registers resources after confirmation.
  The `install` action delegates to the same implementation.

The host provides `IntegrationContext` through a Layer or `Effect.provideService`,
with `directory`, `writeState(state: string, data: unknown, actions?: IntegrationAction[])`, and
`registerResource(resource)`. State data is opaque to the framework. A Lark-specific
view can display `url` and the SDK registration `expiresAt` or OAuth `expiresIn` in waiting states. Credential files never enter
these UI updates. The host must persist each state before completing `writeState`.

`registerResource` must upsert by integration ID + resource ID. The static `resources`
list provides runtime implementations to rebind persisted records after restart;
functions are not persisted. Resource registration means a capability is installed,
not that it is authorized. Installation records completion only after both upserts
succeed, so partial registration can be retried.

### Action protocol

Static `integration.actions` supplies labels and descriptions by ID. Each check returns
currently available actions using one of two protocols:

```ts
{ id: 'authorize', type: 'callback' }
{ id: 'open_authorization', type: 'open-url', url: 'https://provider.example/authorize' }
```

`callback` invokes `onActionCallback`; `open-url` opens the provider-supplied URL in the
system browser. Pending operations publish actions with `writeState(state, data, actions)`.
Omitting `actions` clears previous actions. `data` remains opaque; the host never extracts
URLs or interprets provider states from it. Providers validate their own authorization
domains before offering a URL. The desktop permits HTTPS URLs without embedded credentials.

The renderer sends only the integration and action IDs through `integrations.action`.
Main checks the static ID, rechecks current availability, validates the protocol, and
executes it. External actions remain available while a callback is waiting. Completed,
failed, cancelled, or restarted attempts are rechecked rather than restoring old links.
The base rejects attempts to invoke `open-url` actions as provider callbacks.

Desktop state stores action descriptors in the `actions` column. Existing databases gain
this column without losing state or resources; legacy action IDs are rebuilt by the normal
startup inspect. Bundled providers are registered in the application composition root (`program.ts`);
`integration-catalog.ts` defines only the injected catalog contract. The execution
service depends on that contract rather than importing providers.

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

Lark uses only the Folio-managed `lark-cli`; it never probes or executes a global PATH installation. Only a missing executable
extracts the bundled native `lark-cli@1.0.94` into the integration’s `cli/` directory; a broken CLI is an error. The bundled archive currently supports macOS arm64 only; other platforms require a Folio-managed CLI.
Skills `lark-shared`, `lark-im`, and `lark-mail` are bundled under `src/lark/assets/skills` with their complete trees and license from official `larksuite/cli` commit `f065bf5b645af381f9b7475ce721451e6ca36a23` (v1.0.94). Installation copies these assets into Folio after staging; it does not use Git, Node, or npm. Electron packages the skills as an external `lark-skills` resource and injects its path; an incomplete existing skills directory is not overwritten.

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
`LarkApplication` reference containing `{ clientId, clientSecret, brand }` skips
application registration. Its default is `undefined`, which reads the saved app
file and offers registration when no saved app exists.

```text
~/.folio/integrations/lark/
  installed.json   # Written after dependencies and resource registration complete
  app.json         # App credentials
  app-auth.json    # App/tenant tokens and expiry
  state.json       # Live test host: persisted UI state
  resources.json   # Live test host: resource metadata
  auth.json        # User tokens, expiry, scope, and identity
  cli/             # Only when no Folio-managed CLI is available
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
import { Effect, Layer } from 'effect'
import { IntegrationContext, lark, LarkApplication, readyState } from '@folio/integrations'

// Inside Effect.gen, with platform services supplied by the host:
const host = Layer.succeed(IntegrationContext)({
  directory: integrationDirectory,
  writeState: (state, data, actions = []) => store.writeState(state, data, actions),
  registerResource: (resource) => store.upsertResource(lark.id, resource),
})
const result = yield* lark.inspect().pipe(Effect.provide(host))
yield* store.writeState(result.state, {}, result.actions)
// Join result.actions to lark.actions by ID for display.
// For a callback action selected by the user (open-url is handled by the host):
yield* lark.onActionCallback(selectedActionId).pipe(Effect.provide(host))
// Optionally inject a pre-existing Lark application for a run:
yield* lark.inspect().pipe(
  Effect.provideService(LarkApplication, { clientId, clientSecret, brand: 'feishu' }),
  Effect.provide(host),
)
// Only a subsequent inspect returning readyState authorizes ingestion.
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
