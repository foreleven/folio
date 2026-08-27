import { useState } from 'react'
import { Button } from '@folio/ui'
import { Effect } from 'effect'
import { SystemRpcClient } from '../../shared/rpc/system-rpc'
import { useEffectRuntime } from './effect-runtime-provider'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const effectRuntime = useEffectRuntime()
  const [runtimeLabel, setRuntimeLabel] = useState('Not checked')

  /** Runs the Effect RPC program that loads process-owned metadata. */
  function checkRuntime(): void {
    const program = Effect.gen(function*() {
      const client = yield* SystemRpcClient
      const info = yield* client['system.getInfo']()
      yield* Effect.sync(() => setRuntimeLabel(`${info.platform} · v${info.version}`))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          console.error('Failed to load runtime information', cause)
          setRuntimeLabel('Unavailable')
        })
      )
    )

    effectRuntime.runFork(program)
  }

  return (
    <main className="app-shell">
      <section className="welcome-card">
        <span className="eyebrow">Folio Desktop</span>
        <h1>Your Electron workspace is ready.</h1>
        <p>
          Electron 43, electron-vite 5, TypeScript, and a shared UI package are
          wired together.
        </p>
        <div className="actions">
          <Button onClick={checkRuntime}>
            Check platform
          </Button>
          <code>{runtimeLabel}</code>
        </div>
      </section>
    </main>
  )
}
