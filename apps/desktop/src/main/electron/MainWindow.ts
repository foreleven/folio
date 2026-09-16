import { VaultRuntime } from '../services/vault-runtime'
import { VaultWindowContexts } from '../services/vault-window-contexts'
import type { BrowserWindow } from 'electron'
import { Context, Effect, Layer, Semaphore } from 'effect'
import { createRendererWindow, loadRenderer, RendererLoadError } from './renderer-window'

import type { Vault } from '../../shared/vault'

/** Main-window boundary owned by the Electron application program. */
export class MainWindow extends Context.Service<
  MainWindow,
  {
    /** Opens the main renderer maximized within the current display's work area. */
    readonly open: Effect.Effect<void, RendererLoadError>
    /** Reuses an empty source window; occupied, missing, or closed sources open independently. Existing vaults are focused. */
    readonly openVault: (vault: Vault, sourceWindowId?: number) => Effect.Effect<void, RendererLoadError>
    /** Returns the immutable vault context for an open window; unknown IDs return null. */
    readonly getVault: (id: string) => Effect.Effect<Vault | null>
    /** Closes the window for a vault, waiting until Electron has emitted `closed`. */
    readonly closeVault: (id: string) => Effect.Effect<void>
    /** Reports whether an application window is currently open. */
    readonly isOpen: Effect.Effect<boolean>
  }
>()('folio/main/electron/MainWindow') {
  /** Live layer whose scope owns every window opened by the application. */
  static readonly layer = Layer.effect(
    MainWindow,
    Effect.gen(function* () {
      const runtimes = yield* VaultRuntime
      const contexts = yield* VaultWindowContexts
      const windows = new Map<BrowserWindow, Vault | undefined>()
      const vaultWindows = new Map<string, { window: BrowserWindow; vault: Vault }>()
      const lock = yield* Semaphore.make(1)

      /** Removes and destroys one window without double-closing it. */
      const destroyWindow = (window: BrowserWindow): void => {
        if (!window.isDestroyed()) contexts.unbind(window.webContents.id)
        const vault = windows.get(window)
        if (vault) vaultWindows.delete(vault.id)
        windows.delete(window)
        if (!window.isDestroyed()) {
          window.destroy()
        }
      }

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const window of Array.from(windows.keys())) {
            destroyWindow(window)
          }
        })
      )

      /** Creates an owned window and rolls it back on failed or interrupted navigation. */
      const create = Effect.fn('MainWindow.create')(function* (vault?: Vault) {
        const services = vault ? yield* runtimes.open(vault.id).pipe(Effect.mapError((cause) => new RendererLoadError({ cause }))) : undefined
        const window = createRendererWindow({ title: vault ? `${vault.name} — Folio` : 'Folio' })
        const senderId = window.webContents.id
        // Maximize only when ready so startup does not reveal an unloaded renderer.
        window.once('ready-to-show', () => window.maximize())
        windows.set(window, vault)
        if (services) contexts.bind(senderId, services)
        if (vault) vaultWindows.set(vault.id, { window, vault })
        window.once('closed', () => {
          contexts.unbind(senderId)
          // The window may have started at welcome and acquired a vault later.
          const current = windows.get(window)
          if (current) vaultWindows.delete(current.id)
          windows.delete(window)
        })
        yield* loadRenderer(window, vault ? `vault/${vault.id}` : undefined).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (vault) vaultWindows.delete(vault.id)
              destroyWindow(window)
            })
          )
        )
      })

      /** Serializes navigation so rapid opens cannot focus an incompletely loaded duplicate. */
      const openVault = Effect.fn('MainWindow.openVault')(function* (vault: Vault, sourceWindowId?: number) {
        const existing = vaultWindows.get(vault.id)?.window
        if (existing && !existing.isDestroyed()) {
          if (existing.isMinimized()) existing.restore()
          existing.show()
          existing.focus()
          return
        }
        const source = sourceWindowId === undefined ? undefined : Array.from(windows.keys()).find((window) => window.id === sourceWindowId)
        if (source && !source.isDestroyed() && windows.get(source) === undefined) {
          // Build and bind before navigation so requests already have their Vault services.
          const services = yield* runtimes.open(vault.id).pipe(Effect.mapError((cause) => new RendererLoadError({ cause })))
          // Opening storage can yield while the source window closes.
          if (source.isDestroyed()) return yield* create(vault)
          const senderId = source.webContents.id
          contexts.bind(senderId, services)
          windows.set(source, vault)
          vaultWindows.set(vault.id, { window: source, vault })
          yield* loadRenderer(source, `vault/${vault.id}`).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                vaultWindows.delete(vault.id)
                contexts.unbind(senderId)
                if (!source.isDestroyed()) {
                  windows.set(source, undefined)
                  yield* loadRenderer(source).pipe(Effect.catch((error) => Effect.logError('Failed to restore welcome page', error)))
                }
              })
            )
          )
          return
        }
        yield* create(vault)
      }, lock.withPermit)

      /**
       * Closes a vault window before its registration can be removed. Waiting for
       * `closed` matters because renderers may still have database handles while
       * Electron is processing the close request.
       */
      const closeVault = Effect.fn('MainWindow.closeVault')(function* (id: string) {
        const current = vaultWindows.get(id)?.window
        if (!current || current.isDestroyed()) return
        yield* Effect.callback<void>((resume) => {
          const onClosed = () => resume(Effect.void)
          current.once('closed', onClosed)
          current.close()
          return Effect.sync(() => current.removeListener('closed', onClosed))
        })
      }, lock.withPermit)

      return MainWindow.of({
        open: create(),
        openVault,
        closeVault,
        getVault: (id) => Effect.sync(() => vaultWindows.get(id)?.vault ?? null),
        isOpen: Effect.sync(() => Array.from(windows.keys()).some((window) => !window.isDestroyed()))
      })
    })
  )
}
