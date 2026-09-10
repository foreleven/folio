# M0 dependency and protocol spike

Recorded on 2026-09-10 for the versions resolved in `package-lock.json`.

| Package | Version | Engine | License | Installed footprint |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-coding-agent` | `0.85.1` | Node `>=22.19.0` | MIT | 438 MiB |
| `@agentclientprotocol/sdk` | `1.4.0` | Node `>=18.0.0` | Apache-2.0 | 5.7 MiB |

## Compatibility conclusions

- Folio requires Node `>=24`, satisfying both dependency engines.
- Both packages are ESM and compile under the package's `NodeNext` TypeScript settings.
- `@folio/agent` imports ACP only from `@agentclientprotocol/sdk/experimental/v2`; it contains no v1 fallback or third-party ACP adapter.
- The spike advertises only the stable v2 session capability marker (`session: {}`); it does not advertise providers, NES, position encoding, usage, or other unstable capabilities.
- Pi is referenced only from `packages/agent`; the desktop workspace does not depend on it directly.
- `npm run build --workspace=@folio/agent` validates packaging into `dist`, including the `folio-agent` bin target.

## ACP v2 schema audit

The SDK publishes the draft schema as `schema/v2/schema.unstable.json`; Folio does not import this JSON at runtime or advertise unstable feature fields. The checksum is recorded to make SDK/schema drift auditable:

```text
sha256 bbdf4ad0e4a07751860afbaf3de800a5c7f9f714f3621f8e667f232709dc497d  schema/v2/schema.unstable.json
```

## M0 contract surface

The fake-model harness covers initialize, new, list, resume with full replay, prompt acknowledgment, cancel, and close. It also verifies required message IDs, running/idle state updates, tool upsert patch semantics, Pi session abort-before-dispose, stderr-only diagnostics, and newline-delimited JSON-RPC batch handling.
