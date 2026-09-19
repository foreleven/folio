import { Effect } from 'effect'
import { VaultRpcs } from '../../shared/rpc/vault-rpc'
import { VaultContext } from '../services/vault/vault-context'
import { VaultLauncher } from '../electron/VaultLauncher'

/** Routes vault operations through the application-owned window and selection services. */
export const VaultRpcHandlersLive = VaultRpcs.toLayer(
  Effect.gen(function* () {
    const launcher = yield* VaultLauncher
    return VaultRpcs.of({
      'vault.open': () => launcher.open,
      'vault.openExisting': ({ id }) => launcher.openExisting(id),
      'vault.get': () => Effect.map(VaultContext, (context) => context.vault),
      'vault.remove': ({ id }) => launcher.remove(id)
    })
  })
)
