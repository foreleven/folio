# Desktop integrations

Settings → Integrations lists the static integration catalog. Browsing creates no
installation records. Clicking Install inserts the first row, starts the integration's
installation, and calls `check` to store its current state and available actions.
Only `ready` represents success. Buttons dispatch the integration's static actions
through `onActionCallback`; progress is published through `writeState(state, data)`.

Device-wide installation state lives in `integration_states` in `~/.folio/data.db`
(`FOLIO_CONFIG_DIR/data.db` when overridden). Integration-owned files remain in
`~/.folio/integrations/{id}/`. This is separate from each vault's content database.
The table stores opaque JSON data, available action IDs, registered resource metadata,
timestamps, and safe failure diagnostics.

The main process owns setup jobs and streams committed SQLite snapshots over Effect
RPC. Closing a settings window or disconnecting its subscription does not cancel a
job. Application startup checks existing records without reinstalling them or
reopening stale authorization links. External authorization links are resolved and
validated in the main process.

## Verification — 2026-09-09

- Workspace typecheck and production build passed; desktop suite: 25 files, 96 tests.
- Development startup regression: the workspace TypeScript is bundled, while the
  Lark SDK stays external so Node preserves `ws`'s optional native dependency
  fallback. Build tests execute development and production integration bundles in
  a fresh Node process; removing the fix reproduces the `bufferutil` startup error.
  The actual `npm run dev` Electron window was also verified after this fix.
- Real SQLite tests cover explicit first insertion, retries, duplicate actions,
  opaque data, resource persistence, interrupted subscriptions, restart recovery,
  and rejected authorization destinations.
- Component tests cover initial install, available actions, waiting for authorization,
  localized success, errors, and retry controls.
- Electron QA used an isolated config/database and the existing authorized Lark
  installation. Browsing left zero rows; Install produced one `ready` row containing
  IM and Email resources. State arrived without manual reload.
- Settings refresh, window close/reopen, and process restart restored Connected.
  Dark Chinese and light English layouts were inspected, including a 562 px window.
- Automation initially observed stale/blank background window frames. Repeating QA
  with `--disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
  resolved the drawing issue; these flags were not added to application code.
- New application registration/OAuth was not repeated in desktop QA. Waiting and
  callback behavior is covered by fixtures; the integration package records its
  earlier live authorization verification separately.
