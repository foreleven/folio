import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { EffectRuntimeProvider } from './effect-runtime-provider'
import { createRendererRuntime } from './runtime'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element was not found')
}

const rendererRuntime = createRendererRuntime()
window.addEventListener('beforeunload', () => void rendererRuntime.dispose(), { once: true })

createRoot(rootElement).render(
  <StrictMode>
    <EffectRuntimeProvider runtime={rendererRuntime}>
      <App />
    </EffectRuntimeProvider>
  </StrictMode>
)
