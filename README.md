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

