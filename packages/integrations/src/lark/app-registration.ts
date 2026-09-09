import { registerApp } from '@larksuiteoapi/node-sdk'
import { Effect, Schema } from 'effect'
import { IntegrationError } from '../base/index.ts'
import { larkScopes } from './auth.ts'
import { LarkApp } from './state.ts'

type RegistrationProgress = {
  url?: string
  expiresAt?: number
  status: 'starting' | 'polling' | 'slow_down' | 'domain_switched'
  interval?: number
}

/** Forwards ordered SDK registration events; waits for persistence and aborts polling on failure/cancellation. */
export const createApp = Effect.fn('Lark.createApp')(function*(
  onProgress: (data: RegistrationProgress) => Effect.Effect<void, IntegrationError>
) {
  yield* Effect.logDebug('Lark registration SDK started')
  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const controller = new AbortController()
      const combined = AbortSignal.any([signal, controller.signal])
      let progress: RegistrationProgress = { status: 'starting' }
      let writes = Promise.resolve()
      let rejectWrite!: (error: unknown) => void
      const failedWrite = new Promise<never>((_, reject) => { rejectWrite = reject })
      // All callback updates preserve the URL and are committed in SDK event order.
      const publish = (update: Partial<RegistrationProgress>) => {
        if (combined.aborted) return
        const next = { ...progress, ...update }
        if (JSON.stringify(next) === JSON.stringify(progress)) return
        progress = next
        const snapshot = progress
        writes = writes.then(() => Effect.runPromise(onProgress(snapshot), { signal: combined }))
        void writes.catch((error) => { rejectWrite(error); controller.abort() })
      }
      try {
        const registration = registerApp({
          source: 'folio', signal: combined,
          appPreset: { name: 'Folio', desc: 'Personal Wiki information ingestion' },
          addons: { scopes: { user: larkScopes } },
          onQRCodeReady: ({ url, expireIn }) => publish({ url, expiresAt: Date.now() + expireIn * 1000 }),
          onStatusChange: ({ status, interval }) => publish({ status, interval })
        })
        const result = await Promise.race([registration, failedWrite])
        await writes
        return result
      } finally { controller.abort() }
    },
    catch: () => new IntegrationError({ message: 'Lark application registration failed or expired. Try again.' })
  })
  const app = yield* Schema.decodeUnknownEffect(LarkApp)({
    clientId: result.client_id, clientSecret: result.client_secret,
    brand: result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu'
  }).pipe(Effect.mapError(() => new IntegrationError({ message: 'Lark returned invalid application credentials.' })))
  yield* Effect.logDebug('Lark registration SDK completed').pipe(Effect.annotateLogs({ brand: app.brand }))
  return app
}, Effect.tapError(() => Effect.logWarning('Lark registration SDK failed')),
Effect.annotateLogs({ integration: 'lark', subsystem: 'app-registration' }), Effect.withLogSpan('lark.createApp'))
