// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectTimeline } from './ProjectTimeline'

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), open: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomValue: () => ({ _tag: 'Success', value: [
    { id: 'meeting', title: 'Morning meeting', objectType: 'meeting', occurredAt: '2026-09-24T09:00:00+08:00' }
  ] })
}))
vi.mock('../rpc/wiki-rpc', () => ({ WikiRpcClient: { query: () => ({}) } }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows a Project timeline with its authored offset and opens the linked asset', () => {
  render(<ProjectTimeline projectId="project" revision="v1" chinese={false} onOpen={mocks.open} />)
  expect(screen.getByText('2026-09-24 09:00:00+08:00')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Morning meeting' }))
  expect(mocks.open).toHaveBeenCalledWith('meeting')
})
