import { VaultRuntime } from '../services/vault-runtime'
import { VaultContext, makeVaultContext } from '../services/vault-context'
import { VaultWindowContexts } from '../services/vault-window-contexts'
import { TaskService } from '../services/task-service'
import { Context, Effect, Layer, ManagedRuntime } from 'effect'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainWindow } from './MainWindow'
import { RendererLoadError } from './renderer-window'

const windowLayer = MainWindow.layer.pipe(
  Layer.provide(
    Layer.succeed(VaultRuntime)({
      withClosed: (_id, operation) => operation,
      open: (id) =>
        Effect.succeed(Context.make(VaultContext, makeVaultContext({ id, name: 'wiki', path: '/wiki' }, '/config')).pipe(Context.add(TaskService, {} as TaskService['Service'])))
    })
  ),
  Layer.provideMerge(VaultWindowContexts.layer)
)

const mocks = vi.hoisted(() => ({ create: vi.fn(), load: vi.fn() }))
vi.mock('./renderer-window', async (original) => ({
  ...(await original<typeof import('./renderer-window')>()),
  createRendererWindow: mocks.create,
  loadRenderer: mocks.load
}))

/** Minimal native lifecycle double: destruction emits closed and updates native state. */
class WindowDouble extends EventEmitter {
  /** Gives each native-window double a stable identity for source-window selection. */
  constructor(readonly id: number) {
    super()
    this.webContents = { id }
  }
  webContents: { id: number }
  destroyed = false
  minimized = false
  isDestroyed = () => this.destroyed
  isMinimized = () => this.minimized
  restore = vi.fn(() => {
    this.minimized = false
  })
  show = vi.fn()
  focus = vi.fn()
  maximize = vi.fn()
  close = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })
}
const first = { id: '407bc090-c297-4b3b-96bb-6ced8f64b89c', name: 'wiki', path: '/a/wiki' }
const second = { id: '3b933ccc-363a-4508-b4e6-6d222e3431bd', name: 'wiki', path: '/b/wiki' }
let created: WindowDouble[]
beforeEach(() => {
  created = []
  mocks.create.mockImplementation(() => {
    const window = new WindowDouble(created.length + 1)
    created.push(window)
    return window
  })
  mocks.load.mockReturnValue(Effect.void)
})
afterEach(() => {
  vi.resetAllMocks()
})

describe('vault windows', () => {
  it('keeps a welcome window and distinct vault contexts, restoring duplicate opens', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.open)
      await runtime.runPromise(Effect.all([windows.openVault(first), windows.openVault(first), windows.openVault(second)], { concurrency: 'unbounded' }))
      expect(created).toHaveLength(3)
      expect(mocks.load.mock.calls.map((call) => call[1])).toEqual([undefined, `vault/${first.id}`, `vault/${second.id}`])
      expect(await runtime.runPromise(windows.getVault(first.id))).toEqual(first)
      expect(await runtime.runPromise(windows.getVault(second.id))).toEqual(second)
      expect(await runtime.runPromise(windows.getVault('unknown'))).toBeNull()
      expect(mocks.create).toHaveBeenCalledWith({ title: 'wiki — Folio' })
      created[1].minimized = true
      await runtime.runPromise(windows.openVault(first))
      expect(created[1].restore).toHaveBeenCalledOnce()
      expect(created[1].focus).toHaveBeenCalledTimes(2)
      expect(created).toHaveLength(3)
      created[1].destroy()
      expect(await runtime.runPromise(windows.getVault(first.id))).toBeNull()
      expect(await runtime.runPromise(windows.getVault(second.id))).toEqual(second)
      await runtime.runPromise(windows.openVault(first))
      expect(created).toHaveLength(4)
    } finally {
      await runtime.dispose()
    }
    for (const window of created) expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('reuses the source welcome window, then opens another vault independently', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.open)
      const source = created[0]
      await runtime.runPromise(windows.openVault(first, source.id))
      expect(created).toHaveLength(1)
      expect(mocks.load).toHaveBeenLastCalledWith(source, `vault/${first.id}`)
      expect(await runtime.runPromise(windows.getVault(first.id))).toEqual(first)
      await runtime.runPromise(windows.openVault(second, source.id))
      expect(created).toHaveLength(2)
      expect(await runtime.runPromise(windows.getVault(first.id))).toEqual(first)
      expect(mocks.load).toHaveBeenLastCalledWith(created[1], `vault/${second.id}`)
      source.destroy()
      expect(await runtime.runPromise(windows.getVault(first.id))).toBeNull()
      expect(await runtime.runPromise(windows.getVault(second.id))).toEqual(second)
    } finally {
      await runtime.dispose()
    }
  })

  it('focuses an existing vault without consuming the source welcome window', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.openVault(first))
      await runtime.runPromise(windows.open)
      const welcome = created[1]
      await runtime.runPromise(windows.openVault(first, welcome.id))
      expect(created).toHaveLength(2)
      expect(created[0].focus).toHaveBeenCalledOnce()
      await runtime.runPromise(windows.openVault(second, welcome.id))
      expect(created).toHaveLength(2)
      expect(mocks.load).toHaveBeenLastCalledWith(welcome, `vault/${second.id}`)
    } finally {
      await runtime.dispose()
    }
  })

  it('does not reuse another welcome window when the source is closed or unowned', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.open)
      await runtime.runPromise(windows.open)
      created[0].destroy()
      await runtime.runPromise(windows.openVault(first, created[0].id))
      expect(created).toHaveLength(3)
      await runtime.runPromise(windows.openVault(second, 999))
      expect(created).toHaveLength(4)
      expect(mocks.load.mock.calls.filter((call) => call[0] === created[1])).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  it('restores welcome after failed reuse and permits a retry in the same window', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.open)
      const source = created[0]
      mocks.load.mockReturnValueOnce(Effect.fail(new RendererLoadError({ cause: 'unavailable' })))
      expect(await runtime.runPromise(Effect.flip(windows.openVault(first, source.id)))).toMatchObject({ _tag: 'RendererLoadError' })
      expect(created).toHaveLength(1)
      expect(source.isDestroyed()).toBe(false)
      expect(await runtime.runPromise(windows.getVault(first.id))).toBeNull()
      expect(mocks.load).toHaveBeenLastCalledWith(source)
      await runtime.runPromise(windows.openVault(first, source.id))
      expect(created).toHaveLength(1)
      expect(await runtime.runPromise(windows.getVault(first.id))).toEqual(first)
    } finally {
      await runtime.dispose()
    }
  })

  it('rolls back a failed load, preserves other windows, and retries successfully', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.openVault(first))
      mocks.load.mockReturnValueOnce(Effect.fail(new RendererLoadError({ cause: 'unavailable' })))
      expect(await runtime.runPromise(Effect.flip(windows.openVault(second)))).toMatchObject({ _tag: 'RendererLoadError' })
      expect(created[1].isDestroyed()).toBe(true)
      expect(created[0].isDestroyed()).toBe(false)
      expect(await runtime.runPromise(windows.getVault(second.id))).toBeNull()
      await runtime.runPromise(windows.openVault(second))
      expect(await runtime.runPromise(windows.getVault(second.id))).toEqual(second)
      for (const window of created) if (!window.isDestroyed()) window.destroy()
      expect(await runtime.runPromise(windows.isOpen)).toBe(false)
    } finally {
      await runtime.dispose()
    }
  })

  it('waits for the native close event before releasing a vault context', async () => {
    const runtime = ManagedRuntime.make(windowLayer)
    try {
      const windows = await runtime.runPromise(MainWindow)
      await runtime.runPromise(windows.openVault(first))
      const current = created[0]
      const closing = runtime.runPromise(windows.closeVault(first.id))
      await closing
      expect(current.close).toHaveBeenCalledOnce()
      expect(await runtime.runPromise(windows.getVault(first.id))).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })
})

it('binds services before navigation and removes them on failed navigation and close', async () => {
  const runtime = ManagedRuntime.make(windowLayer)
  try {
    const windows = await runtime.runPromise(MainWindow)
    const contexts = await runtime.runPromise(VaultWindowContexts)
    await runtime.runPromise(windows.open)
    const source = created[0]
    contexts.connect(101, source.webContents.id)
    expect(contexts.get(101)).toBeUndefined()
    mocks.load.mockImplementationOnce(() =>
      Effect.sync(() => {
        expect(Context.get(contexts.get(101)!, VaultContext).id).toBe(first.id)
      })
    )
    await runtime.runPromise(windows.openVault(first, source.id))
    source.destroy()
    expect(contexts.get(101)).toBeUndefined()
    await runtime.runPromise(windows.open)
    const next = created[1]
    contexts.connect(102, next.webContents.id)
    mocks.load.mockReturnValueOnce(Effect.fail(new RendererLoadError({ cause: 'failed navigation' })))
    await expect(runtime.runPromise(windows.openVault(second, next.id))).rejects.toBeDefined()
    expect(contexts.get(102)).toBeUndefined()
  } finally {
    await runtime.dispose()
  }
})
