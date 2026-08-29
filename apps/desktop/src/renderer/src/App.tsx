import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { Button } from '@folio/ui'
import { requestSystemInfoAtom } from './atoms/system-info'
import { SystemRpcClient } from './rpc/system-rpc'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const systemInfoState = useAtomValue(SystemRpcClient.getSystemInfo)
  const requestSystemInfo = useAtomSet(requestSystemInfoAtom)
  const count = useAtomSet(SystemRpcClient.count, {mode: 'promise'})

  const systemInfoLabel = systemInfoState._tag === 'Success'
    ? `${systemInfoState.value.platform} · v${systemInfoState.value.version}`
    : systemInfoState.waiting
    ? 'Checking…'
    : systemInfoState._tag === 'Failure'
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
            {systemInfoState.waiting ? 'Checking…' : 'Check platform'}
          </Button>
          <code>{systemInfoLabel}</code>
        </div>
      </section>
    </main>
  )
}
