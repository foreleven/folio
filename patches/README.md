# electron-builder dependency collection

`app-builder-lib@26.15.3` loses production dependencies when reading pnpm 10's
dependency tree. Repeated package occurrences may expand different descendants;
skipping a previously visited package also skips the only full description of
some descendants. npm aliases can additionally refer to the same physical
package under different names, so their deduped references need path-based
resolution while preserving each requested alias.

The pnpm patch fixes these two collection cases without changing installation
layout or adding indirect packages as application dependencies. Keep it until an
upstream release passes both the collector regressions and the relocated package
check. The tests deliberately use the patched builder implementation.

```sh
pnpm --filter @folio/desktop test:packaging
pnpm --filter @folio/desktop build
pnpm --filter @folio/desktop exec electron-builder --dir --publish never --config.mac.identity=null
pnpm --filter @folio/desktop package:smoke dist/mac-arm64/Folio.app
```

The last command currently checks macOS builds. It copies the application into a
temporary directory, loads the Lark and Gmail SDKs with its own Electron runtime,
then starts and disposes the packaged Agent Worker. It does not test GUI behavior,
authorization or real model execution. Running only from the repository can hide
missing dependencies through Node's ancestor `node_modules` lookup.

# Pi search process ownership

`@earendil-works/pi-coding-agent@0.85.1` exposes filesystem operations for find
and grep, but creates their native processes internally. Folio needs the same
process registration, cancellation and exit receipts as its bash tool. The patch
adds an optional asynchronous `spawn` hook to those two SDK tool factories and
their declarations. Search arguments, parsing, truncation and output remain SDK
owned; Folio requires the hook when constructing its host executor.

The desktop host registers a waiting bash process, then uses `exec` to replace it
with fd/rg without changing its PID or process group. It fences late startup and
joins registration, native exit and the persisted cleanup receipt even when the
SDK's own cancellation Promise settles early. Failed receipts stay owned for
retry. There is no shell interpolation of the search executable or arguments.

Remove this patch when an upstream API provides equivalent process ownership.
`pi-tool-host.test.ts` exercises the actual SDK factories with local fixture
binaries, including cancellation before preparation, during registration and
during search, plus registration failure and cleanup receipt retry. These native
process tests currently run on macOS/Linux; Windows remains a separate validation
requirement.
