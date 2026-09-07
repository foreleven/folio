import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as NodePath from '@effect/platform-node/NodePath'
import { nativeTheme } from 'electron'
import { ConfigProvider, Layer, ManagedRuntime } from 'effect'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '../services/config-service'
import { ApplicationThemeLive } from './ApplicationTheme'

const mocks = vi.hoisted(() => ({
  systemDark: false,
  setBackgroundColor: vi.fn(),
  setDestroyedBackground: vi.fn()
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    nativeTheme: Object.assign(new EventEmitter(), {
      themeSource: 'system'
    }),
    BrowserWindow: {
      getAllWindows: () => [
        { isDestroyed: () => false, setBackgroundColor: mocks.setBackgroundColor },
        { isDestroyed: () => true, setBackgroundColor: mocks.setDestroyedBackground }
      ]
    }
  }
})

let directory: string

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.systemDark = false
  nativeTheme.themeSource = 'system'
  Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
    configurable: true,
    get: () => nativeTheme.themeSource === 'dark'
      || (nativeTheme.themeSource === 'system' && mocks.systemDark)
  })
  directory = await mkdtemp(join(tmpdir(), 'folio-theme-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** Uses an isolated real config store to exercise startup and its shared change stream. */
function makeRuntime() {
  return ManagedRuntime.make(ApplicationThemeLive.pipe(
    Layer.provideMerge(ConfigService.layer.pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({
        FOLIO_CONFIG_DIR: directory
      })))
    ))
  ))
}

describe('ApplicationTheme', () => {
  it('initializes before consumers run and follows saved and system theme changes', async () => {
    await writeFile(join(directory, 'config.json'), '{"theme":"dark"}')
    const runtime = makeRuntime()
    try {
      const config = await runtime.runPromise(ConfigService)
      expect(nativeTheme.themeSource).toBe('dark')
      await vi.waitFor(() => expect(mocks.setBackgroundColor).toHaveBeenLastCalledWith('#0a0a0a'))

      await runtime.runPromise(config.update({ theme: 'light' }))
      await vi.waitFor(() => expect(mocks.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff'))

      await runtime.runPromise(config.update({ theme: 'system' }))
      await vi.waitFor(() => expect(nativeTheme.themeSource).toBe('system'))
      mocks.systemDark = true
      nativeTheme.emit('updated')
      expect(mocks.setBackgroundColor).toHaveBeenLastCalledWith('#0a0a0a')
      expect(mocks.setDestroyedBackground).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
    expect(nativeTheme.listenerCount('updated')).toBe(0)
    expect(nativeTheme.shouldUseDarkColors).toBe(true)
  })

  it('allows startup with damaged config and recovers after the file is repaired', async () => {
    await writeFile(join(directory, 'config.json'), '{broken')
    const runtime = makeRuntime()
    try {
      await runtime.runPromise(ConfigService)
      expect(nativeTheme.themeSource).toBe('system')
      await writeFile(join(directory, 'config.json'), '{"theme":"dark"}')
      await vi.waitFor(() => expect(nativeTheme.themeSource).toBe('dark'), { timeout: 2500 })
    } finally {
      await runtime.dispose()
    }
  })
})
