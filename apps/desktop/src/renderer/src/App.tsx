import { useAtom } from '@effect/atom-react'
import { Button } from '@folio/ui'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { checkSystemInfoAtom } from './runtime'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const [result, checkRuntime] = useAtom(checkSystemInfoAtom)
  const runtimeLabel = AsyncResult.match(result, {
    onInitial: () => 'Not checked',
    onFailure: () => 'Unavailable',
    onSuccess: ({ value }) => `${value.platform} · v${value.version}`
  })

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
          <Button onClick={() => checkRuntime(undefined)} disabled={result.waiting}>
            {result.waiting ? 'Checking…' : 'Check platform'}
          </Button>
          <code>{runtimeLabel}</code>
        </div>
      </section>
    </main>
  )
}
