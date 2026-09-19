# Folio integrations

An `Integration` owns a provider connection. Its resources describe ingestion
capabilities; Lark registers `im` and `email`, while Google Gmail registers
`email`. Their `onIngest` hooks declare the corresponding installed Skills,
shared rules, and workflow assets. They do not start an Agent; the harness
mounts these resources for the Task.

## Ownership

- Providers own credentials, business states, translations, available actions,
  connection flows, and background renewal/retry policy.
- `defineIntegration` serializes user operations, revalidates actions, tracks live
  progress, and prevents late callbacks from replacing completed attempts.
- The desktop hosts the catalog, SQLite snapshots, HTTPS navigation, and scoped
  jobs. Its renderer consumes the protocol without branching on provider IDs,
  business states, or action IDs. Provider-specific composition stays in the
  main-process catalog.

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
src/gmail/
  integration.ts          # Gmail connection, resource mount, and workflow
  oauth.ts                # Google OAuth desktop flow and token refresh
  state.ts                # Private credential state
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

Resources may additionally declare the shared `type` category (`im`, `email`, or
`meeting`). The host uses that category for default Routine suggestions while
retaining the provider-owned resource ID as the stable capability reference.

Hooks obtain `IntegrationContext` with `yield* IntegrationContext`:

- `directory`: installation-private storage location.
- `writeState(state, data, actions?)`: atomically commits public state and currently
  available actions before returning. Omitted actions clear the previous list.
  Do not put credentials or SDK diagnostics in public data.
- `registerResource(resource)`: upserts by integration ID + resource ID and keeps
  its shared `type` metadata. Resource registration means installed capability, not
  current authorization.

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
Missing tools are extracted from bundled `lark-cli@1.0.94` (macOS arm64 or Linux
x64). Bundled
skills are `lark-shared`, `lark-im`, and `lark-mail` from `larksuite/cli` commit
`f065bf5b645af381f9b7475ce721451e6ca36a23`, with complete trees and license. An
incomplete existing skills directory is not overwritten. Electron injects packaged
asset paths at the composition boundary.

SDK 1.73.3 handles application registration, app token exchange, and user identity
verification. SDK logging is suppressed to avoid raw credential-bearing transport
diagnostics. `LarkApplication` optionally supplies existing application
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

## Google Gmail behavior

The Gmail integration requests the read-only Gmail scope and keeps the OAuth
client credentials and refresh token in `~/.folio/integrations/gmail/private.json`.
The OAuth client pair is written before starting authorization, so a failed
attempt can be retried without pasting the values again; it is cleared after a
verified token pair is saved.
The connection action starts Google's OAuth authorization-code flow for Desktop
clients. Folio listens on a temporary loopback (`127.0.0.1`) callback, shows the
verified Google URL as an external action, and exchanges the returned code for
offline credentials. Access tokens are refreshed before a Task is prepared.

The `email` resource mounts a small Skill and `extract-window.mjs`. A default
Vault Routine is created after the resource is installed and runs once per day.
It exports the exact Routine window to `raws/gmail/messages/`, then asks the
Agent to classify urgent replies, tasks/deadlines, newsletters, waiting items,
and archive candidates. Email content is treated as untrusted input and the
workflow never sends, deletes, or relabels Gmail messages. OAuth token refresh
and profile verification use Google's official `googleapis`/`google-auth-library`
clients; the tiny mounted extractor intentionally remains a standalone REST
script and only receives the short-lived access token through its process
environment.

### Gmail OAuth client configuration

An OAuth client ID is not a global Google constant: it identifies the Google
Cloud project that owns the app's OAuth consent screen. Each user should create
or select a project in Google Cloud Console, enable the Gmail API, configure the
OAuth consent screen, and create a **Desktop app** OAuth client. Folio uses the
Desktop client's loopback authorization-code flow. The ID ends in
`.apps.googleusercontent.com` and must be entered together with its client
secret in the Gmail connection form. Folio does not bundle either value; the
secret stays in the private state and is used only for the code exchange and
future token refreshes.

The setup links in the connection card are:

- Enable Gmail API: `https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com`
- Configure consent screen and add Test users: `https://console.cloud.google.com/apis/credentials/consent`
- Create/select OAuth client: `https://console.cloud.google.com/auth/clients`

The connection itself is the OAuth authorization: Folio opens Google's verified
consent URL and waits for Google to redirect the browser to Folio's temporary
local callback. There is no account-level “direct OAuth” endpoint that removes
the client registration; Google requires an OAuth client for every supported
flow. Desktop clients are the correct type for a local application and do not
require a fixed public redirect URI. OAuth Playground credentials are tied to
Google's test application and are not a suitable shared production alternative.

Because `gmail.readonly` is a restricted Gmail scope, add your account as an OAuth
consent-screen test user while developing; public distribution may require
Google's app verification.

The Gmail connection action links directly to
`https://console.cloud.google.com/auth/clients` so each user can create or
select their own OAuth client. Submitted values are never copied into public
integration snapshots; the provider keeps them in its private state.

OAuth authorization-code, token, refresh, and profile requests use the official
Google SDK/Gaxios transport. Folio explicitly checks `HTTPS_PROXY` (then
lowercase/`HTTP_PROXY` variants) for every request and passes the selected proxy
to Gaxios; `NO_PROXY` remains respected. The mounted extractor is invoked with
Node's `--use-env-proxy` flag so its native `fetch` follows the same settings.
If Google is unreachable without a proxy, set one before launching the desktop
app (GUI launches may not inherit the shell's environment). When an OAuth call fails, the development terminal prints
`[Folio][Gmail OAuth]` with the endpoint, HTTP status, Google error code and
description, followed by `[Folio][Integration] operation failed` for failures
that escape the provider. These diagnostics are deliberately omitted from the
renderer and never include client secrets or tokens.

## IMAP email behavior

The `imap` integration uses [ImapFlow](https://imapflow.com/) 2.0.5 for the
provider-independent IMAP connection and [MailParser](https://nodemailer.com/extras/mailparser/)
3.9.28 for MIME decoding, character sets, and HTML-to-text conversion. ImapFlow
provides Promise APIs, TypeScript declarations, UID operations, read-only folder
selection, mandatory TLS/STARTTLS, and HTTP CONNECT/SOCKS proxies without a hosted
service. MailParser is a mature parser in maintenance mode (security and critical
fixes); we use its existing MIME/HTML support rather than implementing a parser.
SMTP is not needed: this integration only reads email.

### Connection

Install **IMAP Mail**, then choose **Connect mailbox** and enter the email address
and app password / IMAP authorization code. Gmail/Googlemail, QQ/Foxmail, 163, 126,
Yeah, iCloud, Yahoo.com, AOL, and Fastmail.com infer their IMAP server. Gmail
requires an eligible account with 2-Step Verification and an app password;
QQ/NetEase require IMAP enabled and an authorization code from mailbox settings.
A normal Google account password does not work.

Use **Custom server / proxy** for custom domains, server/port overrides, another
folder, or a proxy. Defaults are TLS on port 993 and the `INBOX` folder. Set
`security` to `starttls` for servers requiring STARTTLS (default port 143).
Certificate validation stays enabled and STARTTLS is mandatory when selected.
Proxy URLs accept HTTP CONNECT or SOCKS, e.g. `http://127.0.0.1:7890` or
`socks5://127.0.0.1:1080`. A blank proxy means a direct connection; HTTP proxy
environment variables are not automatically applied to IMAP.

This version supports one configured IMAP account and one folder, with password
or app-password authentication. Microsoft accounts or organization policies that
require OAuth cannot use this password-based connector. For Gmail All Mail,
enter the server's exact folder path using the custom connection form; INBOX
does not include archived mail. The existing Gmail API connector remains
available and its authorization is not migrated automatically.

### State, extraction, and packaging

Connection details stay in `~/.folio/integrations/imap/private.json` (directory
0700, file 0600), matching the existing integration storage pattern. This is
local permission-restricted storage, not keychain encryption. A failed check
retains the details for an explicit retry; Disconnect removes the saved details.
Neither catalog snapshots nor workspace scripts contain credentials. Task
processes receive connection details through their environment; unlike the
Gmail API access token, an IMAP app password is a long-lived credential and is
not restricted to read-only access by the server.

Installation creates an `imap/email` resource and an idempotent daily review
Routine. Extraction uses a read-only folder and ImapFlow's `BODY.PEEK` fetching,
so messages are not marked read. It searches a covering date range, then filters
`INTERNALDATE` by the exact half-open Routine window. UID metadata is fetched in
batches of 100 with no total-message cap. Filenames include a hash of the server,
account, folder, and UIDVALIDITY plus the UID, preventing collisions after a
folder UID reset or account change. MailParser converts HTML-only messages to
text. Attachments are not exported, and messages larger than 25 MiB fail the
window explicitly rather than being silently skipped.

`raws/imap/_updated.md` is removed before each attempt and published only after
complete extraction. Partial files are not a successful window; callers must
check the exit status before using the summary. SDK diagnostics are not printed
because raw IMAP responses may contain private data. Successful Routine raws
are persisted alongside the existing Gmail and Lark raws.

The desktop app ships `imap-assets` and both runtime SDK dependencies. The
provider resolves SDK entrypoints relative to the app and passes their absolute
unpacked paths to the standalone extractor, so it also works from a Task
worktree outside the repository without installing packages there.
