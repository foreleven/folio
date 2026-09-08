import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RegistryProvider } from '@effect/atom-react'
import { App } from './App'
import { Settings } from './settings/Settings'
import { PreferencesProvider } from './preferences'
import '@folio/ui/styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element was not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <RegistryProvider>
      <PreferencesProvider>
        {window.location.hash === '#settings' ? <Settings /> : <App />}
      </PreferencesProvider>
    </RegistryProvider>
  </StrictMode>
)
