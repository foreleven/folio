# Lark lifecycle verification

Updated 2026-09-08 (Asia/Shanghai). This record distinguishes real execution from fixtures.

Reference inspected: local checkout `/Users/feng/Projects/wiki`, branch `feat/electron`,
`src/app/integrations/lark/app-registration.ts` (last file commit `1b1ed9a`).
Also inspected its `auth-state.ts`, `device-oauth.ts`, and installed SDK 1.73.3 source.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Reuse system CLI | Real `lark-cli --version`: 1.0.94; default installation reused it | Verified live |
| Install missing CLI and reuse managed copy | Real isolated PATH: missing detection → npm installed 7 packages → executable verified → second run reused it | Verified live |
| Install complete skills | Real pinned Git checkout; installed lark-shared (7 files), lark-im (61), lark-mail (36), plus license | Verified live |
| Register IM and Email resources | Real standalone host persisted both metadata records in `~/.folio/integrations/lark/resources.json` | Verified live |
| Start SDK application registration | Real SDK returned a verification URL and polling events, persisted by host | Verified live |
| Complete application registration and token exchange | Real registration completed; app and tenant tokens exchanged and saved with 0600 permissions, ~2-hour expiry. Failure recovery remains covered by tests | Verified live |
| User device OAuth and identity validation | Real OAuth completed; browser showed success, user token and refresh token saved privately, SDK verified the user, and installer reached ready. Error branches covered by tests | Verified live |
| Renew app/user authorization | Real app token re-exchange succeeded; real user refresh changed both tokens, preserved identity, and subsequent check returned ready. Expiry/action dispatch/error recovery covered by tests | Verified live and by tests |
| Restart and final ready check | Installer exited successfully. Separate verifier processes loaded saved credentials and returned ready before and after token rotation. Live-check concurrency covered by tests | Verified live and by tests |
| IM/Email access with installed CLI | Previous standalone verifier (now `tests/verify-lark.test.ts`): check ready; IM read succeeded (1 item), Email INBOX read succeeded (1 item), before and after refresh | Verified live |
| onIngest stays empty | Both resource hooks leave their agent context unchanged | Verified by tests |

31 tests pass. Final workspace typechecks, desktop production build, live verifier,
and `git diff --check` all passed. Credentials and authorization URLs are
intentionally excluded from this record.

Real verification also found and fixed two issues: the mail listing requires an
explicit folder selector (`INBOX`), and SDK 1.73.3 treats logger level 0 as the info
default; an explicit quiet logger now prevents raw transport logs.

Refresh tests additionally verify that a successful token rotation is saved before
subsequent identity verification, so a transient network failure cannot lose the new
pair. A different resolved user identity never produces ready.

The authorized lifecycle is verified end to end. Failure and timing branches use
fixtures rather than deliberately denying or expiring the user's live authorization.
Ingestion itself remains outside this work: both onIngest hooks are intentionally empty.

The standalone scripts were subsequently migrated to opt-in Vitest cases under
`tests/`. The historical live results above describe the earlier execution, not a
new authorization run. Current entry points are `test:lark:install` and
`test:lark:verify`; default fixture tests skip both live cases.
