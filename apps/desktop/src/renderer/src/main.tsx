import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createRendererContainer, getSystemService } from './di/container'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element was not found')
}

const rendererContainer = createRendererContainer()
const systemService = getSystemService(rendererContainer)

createRoot(rootElement).render(
  <StrictMode>
    <App systemService={systemService} />
  </StrictMode>
)
