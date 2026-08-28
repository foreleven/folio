import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RegistryProvider, useAtomMount } from '@effect/atom-react'
import { App } from './App'
import { checkRuntimeThrottleAtom } from './atoms/system-info'
import './styles.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Renderer root element was not found')
}

/** Mounts renderer-wide background atoms for the lifetime of the registry. */
function RendererProvider({ children }: React.PropsWithChildren): React.JSX.Element {
  useAtomMount(checkRuntimeThrottleAtom)
  return <>{children}</>
}

createRoot(rootElement).render(
  <StrictMode>
    <RegistryProvider>
      <RendererProvider>
        <App />
      </RendererProvider>
    </RegistryProvider>
  </StrictMode>
)
