import { Menu, type MenuItemConstructorOptions } from 'electron'
import { Effect, Layer, Queue } from 'effect'
import { ElectronApp } from './ElectronApp'
import { SettingsWindow } from './SettingsWindow'

/** Installs application-local accelerators and scopes their queue/consumer to the runtime. */
export const ApplicationMenuLive = Layer.effectDiscard(Effect.gen(function*() {
  const app = yield* ElectronApp
  const settings = yield* SettingsWindow
  yield* app.whenReady
  const requests = yield* Queue.unbounded<void>()
  yield* Effect.forkScoped(Effect.forever(
    Queue.take(requests).pipe(
      Effect.andThen(settings.open),
      Effect.catch((error) => Effect.logError('Failed to open settings', error))
    )
  ))

  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CommandOrControl+,',
    /** Queues menu and accelerator requests without starting detached Effect runtimes. */
    click: () => { Queue.offerUnsafe(requests, undefined) }
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
