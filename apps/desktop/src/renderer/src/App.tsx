import { useState } from 'react'
import { Button } from '@folio/ui'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
  const [runtime, setRuntime] = useState('Not checked')

  /** Loads process-owned metadata through the typed JSON-RPC boundary. */
  async function checkRuntime(): Promise<void> {
    try {
      const info = await window.desktop.request('system.getInfo')
      setRuntime(`${info.platform} · v${info.version}`)
    } catch (error: unknown) {
      console.error('Failed to load runtime information', error)
      setRuntime('Unavailable')
    }
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
          <Button onClick={() => void checkRuntime()}>
            Check platform
          </Button>
          <code>{runtime}</code>
        </div>
      </section>
    </main>
  )
}
