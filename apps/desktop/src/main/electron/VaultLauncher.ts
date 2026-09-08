import { BrowserWindow, dialog } from 'electron'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { VaultError, type Vault } from '../../shared/vault'
import { VaultService } from '../services/vault-service'
import { MainWindow } from './MainWindow'

/** Shared native Open action used by the menu and renderer RPC. */
export class VaultLauncher extends Context.Service<VaultLauncher, {
  /** Selects a content directory and opens its window; cancellation returns null without writing. */
  readonly open: Effect.Effect<Vault | null, VaultError>
}>()('folio/main/electron/VaultLauncher') {
  static readonly layer = Layer.effect(VaultLauncher, Effect.gen(function*() {
    const vaults = yield* VaultService
    const windows = yield* MainWindow
    const lock = yield* Semaphore.make(1)
    const open = Effect.gen(function*() {
      // Capture the source before queueing/showing the dialog: focus can change while it is open.
      const parent = BrowserWindow.getFocusedWindow()
      return yield* Effect.gen(function*() {
        const selected = yield* Effect.tryPromise({
          try: () => {
            const options = { title: 'Open Vault', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
            return parent && !parent.isDestroyed() ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
          },
          catch: (cause) => new VaultError({ message: 'Could not open the folder picker.', cause })
        })
        if (selected.canceled || !selected.filePaths[0]) return null
        // After selection, finish registration/open even if the requesting renderer disconnects.
        return yield* Effect.gen(function*() {
          const vault = yield* vaults.register(selected.filePaths[0])
          yield* windows.openVault(vault, parent?.id).pipe(Effect.mapError((cause) =>
            new VaultError({ message: 'Could not open the vault window. Please try again.', cause })
          ))
          return vault
        }).pipe(Effect.uninterruptible)
      }).pipe(lock.withPermit)
    })
    return VaultLauncher.of({ open })
  }))
}
