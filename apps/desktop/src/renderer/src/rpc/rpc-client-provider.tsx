import { createContext, useContext, type ReactNode } from 'react'
import type { Container, ServiceIdentifier } from 'inversify'

const RpcClientContext = createContext<Container | undefined>(undefined)

interface RpcClientProviderProps {
  container: Container
  children: ReactNode
}

/** Makes the renderer RPC container available to every descendant component. */
export function RpcClientProvider({
  container,
  children
}: RpcClientProviderProps): React.JSX.Element {
  return (
    <RpcClientContext.Provider value={container}>
      {children}
    </RpcClientContext.Provider>
  )
}

/** Resolves one RPC handler by token using the lifecycle configured in the container. */
export function useRpcClient<Client>(identifier: ServiceIdentifier<Client>): Client {
  const container = useContext(RpcClientContext)
  if (!container) {
    throw new Error('useRpcClient must be used within RpcClientProvider')
  }

  return container.get<Client>(identifier)
}
