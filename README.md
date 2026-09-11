# Folio

Electron desktop monorepo powered by npm workspaces.

## Requirements

- Node.js 24 or newer (required by the Effect SQLite driver's `node:sqlite` APIs)
- npm 11 or newer

## Workspaces

- `apps/desktop`: Electron 43 application built with electron-vite 5
- `packages/ui`: shared React UI components

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run package
```

`npm run package` creates platform installers in `apps/desktop/dist`.

Reloading a renderer resets its Effect RPC session in the main process and
interrupts the old document's subscriptions. Connections follow document
lifetimes even when Electron reuses the same `WebContents`; in-page hash
navigation keeps its session, and other windows keep their own subscriptions.

## Global configuration

Preferences are stored in `~/.folio/config.json`. Override the directory for one
process with an environment variable (relative paths resolve from its working directory):

```bash
FOLIO_CONFIG_DIR=/tmp/folio-dev npm run dev
```

```json
{
  "theme": "system",
  "language": "system",
  "vaults": []
}
```

`theme` accepts `system`, `light`, or `dark`; `language` accepts `system`, `zh-CN`,
or `en`. Both default to `system`, which consumers resolve using OS preferences.
The renderer applies the theme and resolves the interface language in each window.

Main-process Effects access the shared `ConfigService` through `MainLive`:

```ts
const config = yield * ConfigService
const current = yield * config.get
const updated = yield * config.update({ theme: 'dark' })
```

Reads return defaults for missing files/fields without creating files. The first
update creates the directory and file. Invalid JSON, invalid known values, and I/O
failures return `ConfigStoreError` without resetting the file. Updates validate
patches, serialize read/merge/write within the shared service, and replace the
file via a temporary file on the same filesystem. Separate processes are not
coordinated. Reads always consult disk, so later reads see manual file edits.

## Settings window and UI components

Open the independent settings window with **Cmd+,** on macOS or **Ctrl+,** on
Windows/Linux, or choose **Settings…** from the application menu. Repeating the
shortcut closes the existing settings window; pressing it again opens a fresh
window. Changes save automatically through Effect RPC. The main
process broadcasts committed changes to all open windows; failed writes keep the
previous preferences active. Manual file edits are picked up when a subscription
is reopened; no filesystem watcher runs in the background.

`packages/ui` contains shadcn/ui components using Base UI, the Nova style, and
Tailwind CSS v4. Components are owned source files, with neutral light/dark theme
tokens in `src/styles.css`. Add more official components from the repository root:

```bash
npx shadcn@latest add @shadcn/input --cwd packages/ui
```

Import components from `@folio/ui/components/ui/button` (or the package barrel),
and import `@folio/ui/styles.css` once in the renderer entry. Electron Vite's
Tailwind plugin compiles the shared styles and application utilities.
All page layouts, typography, responsive rules, and interaction styles use
Tailwind CSS v4 utility classes in TSX. `packages/ui/src/styles.css` is the single
stylesheet entry for Tailwind imports, shared theme tokens, and base styles;
there is no separate page stylesheet. Tailwind Preflight supplies the CSS reset.

## Vaults

A vault is an existing directory containing personal wiki files. The welcome page's
**Open Vault** button under **Get Started** or **Cmd/Ctrl+O** opens a native directory picker (which also
allows creating a folder). If the source window is at welcome, the selected vault
loads in that window. If it already has a vault, the selection opens in a new
window. Opening the same vault again restores and focuses its existing window.
**Cmd/Ctrl+Shift+N** opens another welcome window.
**Recent Vaults** lists registered vaults, newest registrations first, with names
and full paths available on hover. Selecting one opens it directly without a
folder picker, using its saved ID and path. Missing folders and configuration
errors leave welcome open with a retryable error. The list follows the shared
configuration stream, so vaults registered in other windows appear automatically.
Closing a window does not delete its files or registration. Settings → Vaults
lists registered vaults and can delete a vault; Folio closes the vault window
first when needed, then removes its managed data and linked folder. Startup shows
the welcome page; restoring the previous session is not implemented yet.

The global `~/.folio/config.json` contains the vault index alongside preferences:

```json
{
  "theme": "system",
  "language": "system",
  "vaults": [
    {
      "id": "01941f29-7c00-73e4-a310-744d2167fc5b",
      "name": "My Wiki",
      "path": "/Users/me/Documents/My Wiki"
    }
  ]
}
```

New IDs use UUID v7 and are reused across restarts. Paths are absolute and
canonicalized, so symlinks to the same folder reuse its registration. Different
folders can have the same display name; each has an independent ID. Vault-level
settings live at `~/.folio/vaults/<id>/config.json`, initially `{}`. Identity and
content paths live only in the global index. The whole structure inherits
`FOLIO_CONFIG_DIR`; a missing `vaults` field defaults to an empty array.

Each vault has its own SQLite database at `~/.folio/vaults/<id>/data.db`, created
when the vault is opened, including vaults registered before database support.
The main process uses `@effect/sql-sqlite-node` (backed by `node:sqlite`) and
`effect/unstable/sql`. SQL consumers provide `vaultDatabaseLayer(directory)` with
the vault's configuration directory to access `SqlClient.SqlClient`. Connections
are closed when their Effect scope ends. The driver enables WAL, so SQLite may
also create `data.db-wal` and `data.db-shm` alongside the database while it is open.
No application tables are created yet.

Registration and preference updates share the global config write lock and atomic
replacement, so simultaneous operations preserve both. The index is committed
before initializing vault settings and the database; if initialization fails,
reopening retries with the saved ID. Existing vault settings and database contents
are never reset by opening a vault. Database failures are reported as `VaultError`.
The former folder-name registry is no longer read and is not automatically
migrated or deleted. User content stays in the selected directory. This first
increment establishes vault registration and window context; file browsing and
editing are not implemented yet.
