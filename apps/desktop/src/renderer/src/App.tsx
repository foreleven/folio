import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui'
import {
  requestSystemInfoAtom,
  systemInfoStateAtom
} from './atoms/system-info'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const systemInfoState = useAtomValue(systemInfoStateAtom)
  const requestSystemInfo = useAtomSet(requestSystemInfoAtom)

  const systemInfoLabel = systemInfoState._tag === 'Available'
    ? `${systemInfoState.platform} · v${systemInfoState.version}`
    : systemInfoState._tag === 'Checking'
    ? 'Checking…'
    : systemInfoState._tag === 'Unavailable'
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
            onClick={() => requestSystemInfo()}
          >
            {systemInfoState._tag === 'Checking' ? 'Checking…' : 'Check platform'}
          </Button>
          <code>{systemInfoLabel}</code>
        </div>
      </section>
    </main>
  )
}
