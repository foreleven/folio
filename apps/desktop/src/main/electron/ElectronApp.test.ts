import { Effect, ManagedRuntime, Stream } from 'effect'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElectronApp } from './ElectronApp'

type AppEvent = 'activate' | 'window-all-closed' | 'before-quit'
type AppListener = () => void

const electronMocks = vi.hoisted(() => ({
  listeners: new Map<AppEvent, AppListener>(),
  on: vi.fn((event: AppEvent, listener: AppListener) => {
    electronMocks.listeners.set(event, listener)
  }),
  removeListener: vi.fn((event: AppEvent) => {
    electronMocks.listeners.delete(event)
  }),
  quit: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve())
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/test/folio',
    getVersion: () => '1.2.3',
    isPackaged: false,
    on: electronMocks.on,
    quit: electronMocks.quit,
    removeListener: electronMocks.removeListener,
    whenReady: electronMocks.whenReady
  }
}))

beforeEach(() => {
  electronMocks.listeners.clear()
  vi.clearAllMocks()
})

describe('ElectronApp live service', () => {
  it('exposes metadata and scopes Electron lifecycle listeners', async () => {
    const runtime = ManagedRuntime.make(ElectronApp.layer)
    const electronApp = await runtime.runPromise(ElectronApp)
    const events = runtime.runPromise(Stream.runCollect(electronApp.events))

    await vi.waitFor(() => expect(electronMocks.listeners.size).toBe(3))
    electronMocks.listeners.get('activate')?.()
    electronMocks.listeners.get('window-all-closed')?.()
    electronMocks.listeners.get('before-quit')?.()

    await expect(events).resolves.toEqual([
      { _tag: 'Activate' },
      { _tag: 'WindowAllClosed' }
    ])
    await expect(runtime.runPromise(electronApp.metadata)).resolves.toEqual({
      version: '1.2.3',
      path: '/test/folio',
      isPackaged: false
    })
    await runtime.runPromise(electronApp.whenReady)
    await runtime.runPromise(electronApp.quit)
    await runtime.dispose()

    expect(electronMocks.whenReady).toHaveBeenCalledOnce()
    expect(electronMocks.quit).toHaveBeenCalledOnce()
    expect(electronMocks.removeListener).toHaveBeenCalledTimes(3)
  })
})
