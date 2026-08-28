import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui'
import {
  requestRuntimeCheckAtom,
  runtimeStateAtom
} from './atoms/system-info'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const runtimeState = useAtomValue(runtimeStateAtom)
  const checkRuntime = useAtomSet(requestRuntimeCheckAtom)

  const runtimeLabel = runtimeState._tag === 'Available'
    ? `${runtimeState.platform} · v${runtimeState.version}`
    : runtimeState._tag === 'Checking'
    ? 'Checking…'
    : runtimeState._tag === 'Unavailable'
    ? 'Unavailable'
    : 'Not checked'

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
          <Button
            onClick={() => checkRuntime(undefined)}
          >
            {runtimeState._tag === 'Checking' ? 'Checking…' : 'Check platform'}
          </Button>
          <code>{runtimeLabel}</code>
        </div>
      </section>
    </main>
  )
}
