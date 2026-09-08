# Folio

Electron desktop monorepo powered by npm workspaces.

## Requirements

- Node.js 22.12 or newer
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
const config = yield* ConfigService
const current = yield* config.get
const updated = yield* config.update({ theme: 'dark' })
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

## Vaults

A vault is an existing directory containing personal wiki files. The welcome page's
**Open Folder** button or **Cmd/Ctrl+O** opens a native directory picker (which also
allows creating a folder). If the source window is at welcome, the selected vault
loads in that window. If it already has a vault, the selection opens in a new
window. Opening the same vault again restores and focuses its existing window.
**Cmd/Ctrl+Shift+N** opens another welcome window.
Closing a window does not delete its files or registration. Startup shows the
welcome page; restoring the previous session is not implemented yet.

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

Registration and preference updates share the global config write lock and atomic
replacement, so simultaneous operations preserve both. The index is committed
before initializing vault settings; if initialization fails, reopening retries
with the saved ID. Existing vault settings are never reset by opening a vault.
The former folder-name registry is no longer read and is not automatically
migrated or deleted. User content stays in the selected directory. This first
increment establishes vault registration and window context; file browsing and
editing are not implemented yet.
