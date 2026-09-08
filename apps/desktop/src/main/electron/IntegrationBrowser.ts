import { shell } from 'electron'
import { Context, Effect, Layer } from 'effect'
import { IntegrationSettingsError } from '../../shared/integration'

/** Opens only authorization URLs already validated by the integration service. */
export class IntegrationBrowser extends Context.Service<IntegrationBrowser, {
  readonly open: (url: string) => Effect.Effect<void, IntegrationSettingsError>
}>()('folio/electron/IntegrationBrowser') {
  static readonly layer = Layer.succeed(IntegrationBrowser)({
    open: (url) => Effect.tryPromise({
      try: () => shell.openExternal(url),
      catch: () => new IntegrationSettingsError({ message: 'Could not open the authorization page.' })
    })
  })
}
