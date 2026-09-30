// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RawCitationPreview } from './RawCitationPreview'

const mocks = vi.hoisted(() => ({ value: {} as unknown, refresh: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomValue: () => ({ _tag: 'Success', value: mocks.value })
}))
vi.mock('../rpc/wiki-rpc', () => ({ WikiRpcClient: { query: () => ({}) } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const chatSource = (records: string) => `---
source: "lark/im"
chat_name: "产品讨论"
time_zone: "Asia/Shanghai"
---

# 产品讨论

${records}`
const message = (index: number, text = `Evidence ${index}`) => `- 2026-09-28 14:0${index}:00 | Alice | Team (ou_alice) | om_${index} | ${text}`
const citation = (fragment: string | null) => `folio-raw:${'a'.repeat(40)}/raws/lark/im/2026-09-28/chat.md${fragment === null ? '' : '#' + fragment}`
function renderFile(content: string, fragment: string | null = 'om_4') {
  mocks.value = { kind: 'file', commit: 'a'.repeat(40), path: 'raws/lark/im/2026-09-28/chat.md', fragment, content }
  return render(<RawCitationPreview uri={citation(fragment)} chinese={false} onClose={() => {}} />)
}

it('locates the exact message, shows attribution and adjacent context, and expands both directions', () => {
  const content = chatSource(Array.from({ length: 9 }, (_, index) => message(index)).join('\n'))
  renderFile(content, '%6Fm_4')
  expect(screen.getByRole('heading', { name: '产品讨论' })).toBeTruthy()
  expect(screen.getByText('Time zone: Asia/Shanghai')).toBeTruthy()
  const conversation = within(screen.getByRole('list', { name: 'Source conversation' }))
  expect(conversation.getAllByRole('listitem')).toHaveLength(5)
  const selected = conversation.getAllByRole('listitem').find(item => item.getAttribute('aria-current') === 'true')!
  expect(within(selected).getByText('Evidence 4')).toBeTruthy()
  expect(within(selected).getByText('Alice | Team (ou_alice)')).toBeTruthy()
  expect(within(selected).getByText('2026-09-28 14:04:00')).toBeTruthy()
  expect(conversation.queryByText('Evidence 0')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Show earlier messages' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show later messages' }))
  expect(conversation.getAllByRole('listitem')).toHaveLength(9)
  expect(screen.queryByRole('button', { name: 'Show later messages' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'View complete source' }))
  expect(screen.getByRole('button', { name: 'Hide complete source' }).getAttribute('aria-expanded')).toBe('true')
  expect(document.querySelectorAll('pre')[9]?.textContent).toBe(content)
})

it.each([
  ['om_missing', message(0, 'A reference to om_missing is not its record')],
  ['om_0', message(0) + '\n' + message(0, 'Duplicate ID')],
  ['%E0%A4', message(0)]
])('keeps full evidence visible when the citation cannot uniquely locate a message (%s)', (fragment, records) => {
  const content = chatSource(records)
  renderFile(content, fragment)
  expect(screen.getByRole('status').textContent).toContain('could not be located')
  expect(screen.queryByText('Cited message')).toBeNull()
  expect(document.querySelector('pre')?.textContent).toBe(content)
})

it('preserves mail and unfamiliar source formats without losing unparsed content', () => {
  const content = '---\nsource: lark/email\n---\n# Mail subject\n\nOriginal mail body'
  renderFile(content, null)
  expect(document.querySelector('pre')?.textContent).toBe(content)
  expect(screen.queryByRole('status')).toBeNull()
})

it('does not silently discard malformed chat rows or interpret original HTML', () => {
  const content = chatSource(message(0) + '\nUnexpected source line <script>unsafe()</script>')
  renderFile(content, 'om_0')
  expect(document.querySelector('pre')?.textContent).toBe(content)
  expect(document.querySelector('script')).toBeNull()
})

it('shows a deleted chat at its cited prior message and renders its body as text', () => {
  mocks.value = { kind: 'deletion', commit: 'a'.repeat(40), path: 'raws/lark/im/2026-09-28/chat.md', fragment: 'om_0',
    priorContent: chatSource(message(0, '<img src="x" onerror="unsafe()"> ↵ Correction: customer B')), diff: '-old record' }
  render(<RawCitationPreview uri={citation('om_0')} chinese={false} onClose={() => {}} />)
  expect(screen.getByText('Cited message')).toBeTruthy()
  expect(screen.getByText('-old record')).toBeTruthy()
  expect(screen.getByRole('listitem').textContent).toContain('Correction: customer B')
  expect(document.querySelector('img')).toBeNull()
})

it('shows the deleted raw diff and the prior blob without interpreting either as HTML', () => {
  mocks.value = { kind: 'deletion', commit: 'a'.repeat(40), path: 'raws/lark/im/2026-09-24/a.md', fragment: 'message-1',
    priorContent: '<script>unsafe()</script>', diff: '-old record' }
  render(<RawCitationPreview uri={`folio-raw:${'a'.repeat(40)}/raws/lark/im/2026-09-24/a.md#message-1`} chinese={false} onClose={() => {}} />)
  expect(screen.getByText('-old record')).toBeTruthy()
  expect(screen.getByText('<script>unsafe()</script>')).toBeTruthy()
  expect(document.querySelector('script')).toBeNull()
})
