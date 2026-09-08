import { dialog, Menu, type MenuItemConstructorOptions } from 'electron'
import { Effect, Layer, Queue } from 'effect'
import { ElectronApp } from './ElectronApp'
import { MainWindow } from './MainWindow'
import { VaultLauncher } from './VaultLauncher'
import { SettingsWindow } from './SettingsWindow'

/** Installs application-local accelerators and scopes their queue/consumer to the runtime. */
export const ApplicationMenuLive = Layer.effectDiscard(Effect.gen(function*() {
  const app = yield* ElectronApp
  const settings = yield* SettingsWindow
  const windows = yield* MainWindow
  const vaults = yield* VaultLauncher
  yield* app.whenReady
  const requests = yield* Queue.unbounded<'settings' | 'open' | 'new'>()
  yield* Effect.forkScoped(Effect.forever(
    Queue.take(requests).pipe(
      Effect.flatMap(Effect.fn('ApplicationMenu.handle')(function*(request) {
        if (request === 'settings') yield* settings.toggle
        else if (request === 'new') yield* windows.open
        else yield* vaults.open
      })),
      Effect.catch((error) => Effect.logError('Failed to handle menu action', error).pipe(
        Effect.andThen(Effect.sync(() => dialog.showErrorBox('Could not open window',
          error._tag === 'VaultError' ? error.message : 'The window could not be loaded. Please try again.')))
      ))
    )
  ))

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    /** Queues menu and accelerator requests without starting detached Effect runtimes. */
    click: () => { Queue.offerUnsafe(requests, 'settings') }
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{
      label: 'Folio',
      submenu: [
        { role: 'about' }, { type: 'separator' }, settingsItem,
        { type: 'separator' }, { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' }
      ]
    } satisfies MenuItemConstructorOptions] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CommandOrControl+Shift+N', click: () => { Queue.offerUnsafe(requests, 'new') } },
        { label: 'Open Vault…', accelerator: 'CommandOrControl+O', click: () => { Queue.offerUnsafe(requests, 'open') } },
        { type: 'separator' },
        ...(process.platform === 'darwin' ? [] : [settingsItem, { type: 'separator' } as const]),
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Menu.getApplicationMenu()
      Menu.setApplicationMenu(Menu.buildFromTemplate(template))
      return previous
    }),
    (previous) => Effect.sync(() => Menu.setApplicationMenu(previous))
  )
}))
