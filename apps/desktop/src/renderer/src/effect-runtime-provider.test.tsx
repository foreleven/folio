import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createRendererRuntime, type RendererRuntime } from './runtime'
import {
  EffectRuntimeProvider,
  useEffectRuntime
} from './effect-runtime-provider'

describe('EffectRuntimeProvider', () => {
  it('makes the renderer ManagedRuntime available to descendants', async () => {
    const runtime = createRendererRuntime()
    let injectedRuntime: RendererRuntime | undefined

    /** Captures the runtime exposed through the React seam. */
    function Probe(): null {
      injectedRuntime = useEffectRuntime()
      return null
    }

    renderToStaticMarkup(
      <EffectRuntimeProvider runtime={runtime}>
        <Probe />
      </EffectRuntimeProvider>
    )

    expect(injectedRuntime).toBe(runtime)
    await runtime.dispose()
  })

  it('rejects hook usage outside the provider', () => {
    /** Attempts to resolve the runtime without an owning Provider. */
    function Probe(): null {
      useEffectRuntime()
      return null
    }

    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      'useEffectRuntime must be used within EffectRuntimeProvider'
    )
  })
})
