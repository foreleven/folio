import { Effect, Layer } from 'effect'
import { RpcTest } from 'effect/unstable/rpc'
import { describe, expect, it } from 'vitest'
import { SystemRpcs } from '../../shared/rpc/system-rpc'
import { SystemService } from '../services/system-service'
import { SystemRpcHandlersLive } from './system-rpc'

describe('System Effect RPC interface', () => {
  it('serves process metadata through the generated client and handler layer', async () => {
    const TestSystemService = Layer.succeed(SystemService)({
      getInfo: Effect.succeed({ platform: 'darwin', version: '1.2.3' }),
      count: (c) => Effect.succeed(c)
    })
    const TestHandlers = SystemRpcHandlersLive.pipe(Layer.provide(TestSystemService))
    const program = Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(SystemRpcs)
      return yield* client['system.getInfo']()
    }).pipe(Effect.provide(TestHandlers), Effect.scoped)

    await expect(Effect.runPromise(program)).resolves.toEqual({
      platform: 'darwin',
      version: '1.2.3'
    })
  })
})
