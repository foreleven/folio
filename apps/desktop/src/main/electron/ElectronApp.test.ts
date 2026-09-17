import { Effect, Layer, ManagedRuntime, Stream } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ElectronApp } from './ElectronApp'

type AppEvent = 'activate' | 'window-all-closed' | 'before-quit'
type AppListener = (event?: { preventDefault(): void }) => void

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
  it('keeps a real Worker alive without windows and holds repeated Quit until dependent cleanup finishes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'folio-app-shutdown-'))
    const entrypoint = join(directory, 'agent.mjs')
    await writeFile(entrypoint, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready'); setInterval(()=>{},1000)")
    let exited = false
    let release!: () => void
    let cleanupStarted = false
    const barrier = new Promise<void>(resolve => { release = resolve })
    const resources = Layer.effectDiscard(Effect.gen(function*() {
      yield* ElectronApp
      const worker = new Worker(entrypoint)
      const stopped = new Promise<void>(resolve => worker.once('exit', () => { exited = true; resolve() }))
      yield* Effect.addFinalizer(() => Effect.promise(async () => { await worker.terminate(); await stopped }))
      yield* Effect.promise(() => new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject) }))
      yield* Effect.addFinalizer(() => Effect.promise(async () => { cleanupStarted = true; await barrier }))
    }))
    const runtime = ManagedRuntime.make(resources.pipe(Layer.provideMerge(ElectronApp.layer)))
    try {
      const app = await runtime.runPromise(ElectronApp)
      const observed: string[] = []
      const events = runtime.runPromise(Stream.runForEach(app.events, event => Effect.sync(() => { observed.push(event._tag) })))
      electronMocks.listeners.get('window-all-closed')?.()
      await vi.waitFor(() => expect(observed).toContain('WindowAllClosed'))
      expect(exited).toBe(false)
      expect(electronMocks.quit).not.toHaveBeenCalled()
      const preventDefault = vi.fn()
      electronMocks.listeners.get('before-quit')?.({ preventDefault })
      await events
      const disposing = runtime.dispose()
      await vi.waitFor(() => expect(cleanupStarted).toBe(true))
      electronMocks.listeners.get('before-quit')?.({ preventDefault })
      expect(preventDefault).toHaveBeenCalledTimes(2)
      expect(electronMocks.quit).not.toHaveBeenCalled()
      expect(exited).toBe(false)
      release()
      await disposing
      expect(exited).toBe(true)
      expect(electronMocks.quit).toHaveBeenCalledOnce()
    } finally { release(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, 10000)

  it('exposes metadata and scopes Electron lifecycle listeners', async () => {
    const runtime = ManagedRuntime.make(ElectronApp.layer)
    const electronApp = await runtime.runPromise(ElectronApp)
    const events = runtime.runPromise(Stream.runCollect(electronApp.events))

    await vi.waitFor(() => expect(electronMocks.listeners.size).toBe(3))
    electronMocks.listeners.get('activate')?.()
    electronMocks.listeners.get('window-all-closed')?.()
    const preventDefault = vi.fn()
    electronMocks.listeners.get('before-quit')?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()

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
    expect(electronMocks.quit).toHaveBeenCalledTimes(2)
    expect(electronMocks.removeListener).toHaveBeenCalledTimes(3)
  })
})
