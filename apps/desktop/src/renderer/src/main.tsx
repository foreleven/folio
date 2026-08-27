import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createRendererContainer } from './di/container'
import { RpcClientProvider } from './rpc/rpc-client-provider'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element was not found')
}

const rendererContainer = createRendererContainer()

createRoot(rootElement).render(
  <StrictMode>
    <RpcClientProvider container={rendererContainer}>
      <App />
    </RpcClientProvider>
  </StrictMode>
)
