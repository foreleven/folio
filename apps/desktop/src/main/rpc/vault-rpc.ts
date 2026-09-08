import { Effect } from 'effect'
import { VaultRpcs } from '../../shared/rpc/vault-rpc'
import { MainWindow } from '../electron/MainWindow'
import { VaultLauncher } from '../electron/VaultLauncher'

/** Routes vault operations through the application-owned window and selection services. */
export const VaultRpcHandlersLive = VaultRpcs.toLayer(Effect.gen(function*() {
  const launcher = yield* VaultLauncher
  const windows = yield* MainWindow
  return VaultRpcs.of({
    'vault.open': () => launcher.open,
    'vault.get': ({ id }) => windows.getVault(id)
  })
}))
