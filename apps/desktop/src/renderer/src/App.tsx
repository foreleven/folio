import { Button } from '@folio/ui'
import '@folio/ui/styles.css'

/** Renders the desktop shell and proves the shared UI workspace is linked. */
export function App(): React.JSX.Element {
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
          <Button onClick={() => window.alert(`Running on ${window.desktop.platform}`)}>
            Check platform
          </Button>
          <code>packages/ui</code>
        </div>
      </section>
    </main>
  )
}

