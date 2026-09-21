import { Effect, Semaphore } from 'effect'

// Electron owns one writer process. Git's ref compare-and-swap remains the correctness boundary
// for external writers, while checkout-scoped gates prevent app services from racing one index.
const gates = new Map<string, Semaphore.Semaphore>()

export function withGitOperationGate<A, E, R>(root: string, checkout: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const key = JSON.stringify([root, checkout])
  let gate = gates.get(key)
  if (!gate) {
    gate = Semaphore.makeUnsafe(1)
    gates.set(key, gate)
  }
  return gate.withPermit(Effect.uninterruptible(effect))
}
