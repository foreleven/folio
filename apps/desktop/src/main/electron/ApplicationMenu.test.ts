import type { MenuItemConstructorOptions } from 'electron'
import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationMenuLive } from './ApplicationMenu'
import { ElectronApp } from './ElectronApp'
import { SettingsWindow } from './SettingsWindow'

const mocks = vi.hoisted(() => ({
  build: vi.fn((template: MenuItemConstructorOptions[]) => ({ items: template })),
  set: vi.fn(), previous: { previous: true }
}))
vi.mock('electron', () => ({
  app: {},
  Menu: {
    getApplicationMenu: () => mocks.previous,
    setApplicationMenu: mocks.set,
    buildFromTemplate: mocks.build
  }
}))

describe('ApplicationMenu', () => {
  it('installs the settings accelerator after ready and restores the previous menu on disposal', async () => {
    const ready = vi.fn()
    const toggle = vi.fn()
    const runtime = ManagedRuntime.make(ApplicationMenuLive.pipe(Layer.provide(Layer.merge(
      Layer.succeed(ElectronApp)({
        metadata: Effect.succeed({ version: '1', path: '/test', isPackaged: false }),
        whenReady: Effect.sync(ready), events: Stream.empty,
        quitOnWindowAllClosed: false, quit: Effect.void
      }),
      Layer.succeed(SettingsWindow)({ toggle: Effect.sync(toggle) })
    ))))
    try {
      await runtime.runPromise(Effect.void)
      expect(ready).toHaveBeenCalledOnce()
      const items = mocks.build.mock.calls[0][0].flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [])
      const settings = items.find((item) => item.accelerator === 'CommandOrControl+,')
      expect(settings?.label).toBe('Settings…')
      expect(settings?.click).toBeTypeOf('function')
      // Electron supplies menu callback arguments; this handler intentionally ignores them.
      settings?.click?.(undefined as never, undefined as never, undefined as never)
      await vi.waitFor(() => expect(toggle).toHaveBeenCalledOnce())
    } finally {
      await runtime.dispose()
    }
    expect(mocks.set).toHaveBeenLastCalledWith(mocks.previous)
  })
})
