// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RawCitationPreview } from './RawCitationPreview'

const mocks = vi.hoisted(() => ({ value: {} as unknown, refresh: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomValue: () => ({ _tag: 'Success', value: mocks.value })
}))
vi.mock('../rpc/wiki-rpc', () => ({ WikiRpcClient: { query: () => ({}) } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows the deleted raw diff and the prior blob without interpreting either as HTML', () => {
  mocks.value = { kind: 'deletion', commit: 'a'.repeat(40), path: 'raws/lark/im/2026-09-24/a.md', fragment: 'message-1',
    priorContent: '<script>unsafe()</script>', diff: '-old record' }
  render(<RawCitationPreview uri={`folio-raw:${'a'.repeat(40)}/raws/lark/im/2026-09-24/a.md#message-1`} chinese={false} onClose={() => {}} />)
  expect(screen.getByText('-old record')).toBeTruthy()
  expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
})
