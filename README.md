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
  "language": "system"
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
