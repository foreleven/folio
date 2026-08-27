import { createContext, useContext, type ReactNode } from 'react'
import type { RendererRuntime } from './runtime'

const EffectRuntimeContext = createContext<RendererRuntime | undefined>(undefined)

interface EffectRuntimeProviderProps {
  readonly runtime: RendererRuntime
  readonly children: ReactNode
}

/** Exposes the renderer's scoped Effect runtime to the React tree. */
export function EffectRuntimeProvider({
  runtime,
  children
}: EffectRuntimeProviderProps): React.JSX.Element {
  return (
    <EffectRuntimeContext.Provider value={runtime}>
      {children}
    </EffectRuntimeContext.Provider>
  )
}

/** Returns the ManagedRuntime used to execute renderer Effect programs. */
export function useEffectRuntime(): RendererRuntime {
  const runtime = useContext(EffectRuntimeContext)
  if (!runtime) {
    throw new Error('useEffectRuntime must be used within EffectRuntimeProvider')
  }
  return runtime
}
