import { Container } from 'inversify'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RpcHandlerToken } from '../../../shared/rpc'
import { RpcClientProvider, useRpcClient } from './rpc-client-provider'

const ExampleRpcHandler = Symbol.for(
  'test.ExampleRpcHandler'
) as RpcHandlerToken<ExampleRpcHandler>

interface ExampleRpcHandler {
  getValue(): string
}

describe('RpcClientProvider', () => {
  it('lets a component inject an RPC handler from the provided container', () => {
    const container = new Container()
    const handler: ExampleRpcHandler = { getValue: () => 'ready' }
    container.bind<ExampleRpcHandler>(ExampleRpcHandler).toConstantValue(handler)
    let injectedHandler: ExampleRpcHandler | undefined

    /** Captures the hook result through a normal render boundary. */
    function Probe(): null {
      injectedHandler = useRpcClient(ExampleRpcHandler)
      return null
    }

    renderToStaticMarkup(
      <RpcClientProvider container={container}>
        <Probe />
      </RpcClientProvider>
    )

    expect(injectedHandler).toBe(handler)
  })

  it('rejects hook usage outside the provider boundary', () => {
    /** Attempts to resolve a client without a container in context. */
    function Probe(): null {
      useRpcClient(ExampleRpcHandler)
      return null
    }

    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      'useRpcClient must be used within RpcClientProvider'
    )
  })
})
