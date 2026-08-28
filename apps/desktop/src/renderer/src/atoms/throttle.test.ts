import { Duration, Effect, Layer } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'
import { makeThrottledAction } from './throttle'

describe('makeThrottledAction', () => {
  it('throttles arbitrary payloads while updating the target atom', async () => {
    const valuesAtom = Atom.make<ReadonlyArray<string>>([])
    const requestAtom = makeThrottledAction(
      Atom.runtime(Layer.empty),
      (value: string, registry) =>
        Effect.sync(() => registry.set(valuesAtom, [...registry.get(valuesAtom), value])),
      { duration: Duration.millis(30) }
    )
    const registry = AtomRegistry.make()
    registry.mount(valuesAtom)
    const release = registry.mount(requestAtom)

    registry.set(requestAtom, 'first')
    registry.set(requestAtom, 'second')

    await vi.waitFor(() => expect(registry.get(valuesAtom)).toEqual(['first']))
    await new Promise((resolve) => setTimeout(resolve, 40))
    registry.set(requestAtom, 'third')
    await vi.waitFor(() => expect(registry.get(valuesAtom)).toEqual(['first', 'third']))

    release()
    registry.dispose()
  })
})
