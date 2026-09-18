import { BrowserWindow, dialog } from 'electron'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { VaultError, type Vault } from '../../shared/vault'
import { VaultRuntime } from '../services/vault-runtime'
import { VaultService } from '../services/vault-service'
import { ConfigService } from '../services/config-service'
import { MainWindow } from './MainWindow'

/** Shared native Open action used by the menu and renderer RPC. */
export class VaultLauncher extends Context.Service<
  VaultLauncher,
  {
    /** Selects a content directory and opens its window; cancellation returns null without writing. */
    readonly open: Effect.Effect<Vault | null, VaultError>
    /** Resolves a registered ID from disk and opens it without a picker; unknown or unavailable vaults fail. */
    readonly openExisting: (id: string) => Effect.Effect<Vault, VaultError>
    /** Closes an open vault window, deletes managed data, then removes its registration. */
    readonly remove: (id: string) => Effect.Effect<Vault, VaultError>
  }
>()('folio/main/electron/VaultLauncher') {
  static readonly layer = Layer.effect(
    VaultLauncher,
    Effect.gen(function* () {
      const vaults = yield* VaultService
      const runtimes = yield* VaultRuntime
      const windows = yield* MainWindow
      const config = yield* ConfigService
      const lock = yield* Semaphore.make(1)

      /** Revalidates the folder and initializes storage before binding it to the captured source window. */
      const openDirectory = Effect.fn('VaultLauncher.openDirectory')(function* (directory: string, sourceWindowId?: number) {
        const vault = yield* vaults.register(directory)
        yield* windows.openVault(vault, sourceWindowId).pipe(Effect.mapError((cause) => new VaultError({ message: 'Could not open the vault window. Please try again.', cause })))
        return vault
      }, Effect.uninterruptible)

      /** Trusts only the saved index for paths; shares the picker lock to serialize competing open actions. */
      const openExisting = Effect.fn('VaultLauncher.openExisting')(function* (id: string) {
        const sourceWindowId = BrowserWindow.getFocusedWindow()?.id
        return yield* Effect.gen(function* () {
          const current = yield* config.get.pipe(Effect.mapError((cause) => new VaultError({ message: 'Could not read the vault index.', cause })))
          const vault = current.vaults.find((entry) => entry.id === id)
          if (!vault) return yield* new VaultError({ message: 'This vault is no longer registered.', cause: id })
          return yield* openDirectory(vault.path, sourceWindowId)
        }).pipe(lock.withPermit)
      })
      const remove = Effect.fn('VaultLauncher.remove')(
        function* (id: string) {
          const current = yield* config.get.pipe(Effect.mapError((cause) => new VaultError({ message: 'Could not read the vault index.', cause })))
          const vault = current.vaults.find((entry) => entry.id === id)
          if (!vault) return yield* new VaultError({ message: 'This vault is no longer registered.', cause: id })

          // MainWindow waits for Electron's `closed` event. This guarantees the
          // renderer has released its resources before the registration disappears.
          yield* windows.closeVault(id)
          return yield* runtimes.withClosed(id, Effect.gen(function* () {
            yield* vaults.remove(vault)
            const removed = yield* config.removeVault(id).pipe(Effect.mapError((cause) => new VaultError({ message: 'Could not remove the vault registration.', cause })))
            if (removed === null) return yield* new VaultError({ message: 'This vault is no longer registered.', cause: id })
            return removed
          })).pipe(Effect.mapError(cause => cause instanceof VaultError ? cause : new VaultError({ message: 'Could not close Vault background operations. Saved data has been retained.', cause })))
        },
        Effect.uninterruptible,
        lock.withPermit
      )
      const open = Effect.gen(function* () {
        // Capture the source before queueing/showing the dialog: focus can change while it is open.
        const parent = BrowserWindow.getFocusedWindow()
        return yield* Effect.gen(function* () {
          const selected = yield* Effect.tryPromise({
            try: () => {
              const options = { title: 'Open Vault', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
              return parent && !parent.isDestroyed() ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
            },
            catch: (cause) => new VaultError({ message: 'Could not open the folder picker.', cause })
          })
          if (selected.canceled || !selected.filePaths[0]) return null
          // After selection, finish registration/open even if the requesting renderer disconnects.
          return yield* openDirectory(selected.filePaths[0], parent?.id)
        }).pipe(lock.withPermit)
      })
      return VaultLauncher.of({ open, openExisting, remove })
    })
  )
}
