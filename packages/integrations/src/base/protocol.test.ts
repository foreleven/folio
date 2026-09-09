import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import { IntegrationAction } from './protocol.ts'

describe('integration action protocol', () => {
  it('decodes callback and external URL actions', () => {
    const decode = Schema.decodeUnknownSync(IntegrationAction)
    expect(decode({ id: 'connect', type: 'callback' })).toEqual({ id: 'connect', type: 'callback' })
    expect(decode({ id: 'open', type: 'open-url', url: 'https://provider.example/connect' }))
      .toEqual({ id: 'open', type: 'open-url', url: 'https://provider.example/connect' })
  })

  it.each([
    { id: 'open', type: 'open-url' },
    { id: 'execute', type: 'shell', command: 'echo unexpected' },
    { id: '', type: 'callback' },
    { id: 'connect' }
  ])('rejects incomplete or unsupported actions: %j', (action) => {
    expect(() => Schema.decodeUnknownSync(IntegrationAction)(action)).toThrow()
  })
})
