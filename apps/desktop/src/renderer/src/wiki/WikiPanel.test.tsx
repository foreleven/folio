// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultObjectTypes, newPageMetadata, type PageDocument, type SavePage } from '../../../shared/wiki'
import { WikiPanel } from './WikiPanel'
import { useState } from 'react'
const mocks = vi.hoisted(() => ({ snapshot: {} as unknown, read: vi.fn(), save: vi.fn(), saveTypes: vi.fn(), refresh: vi.fn() }))
vi.mock('@effect/atom-react', () => ({
  useAtomRefresh: () => mocks.refresh,
  useAtomSet: (kind: string) => kind === 'read' ? mocks.read : kind === 'save' ? mocks.save : mocks.saveTypes,
  useAtomValue: () => ({ _tag: 'Success', value: mocks.snapshot })
}))
vi.mock('../rpc/wiki-rpc', () => ({ WikiRpcClient: { query: () => ({}), readPage: 'read', savePage: 'save', saveTypes: 'types' } }))
vi.mock('../preferences', () => ({ useLocale: () => 'en-US' }))
vi.mock('./PageContentEditor', () => ({ PageContentEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => <textarea aria-label="Page content" value={value} onChange={event => onChange(event.target.value)} /> }))
const one: PageDocument = { ...newPageMetadata('one', 'project'), title: 'Alpha', body: 'Original', path: 'one.md', version: 'v1' }
const two: PageDocument = { ...newPageMetadata('two', 'note', 'one'), title: 'Beta', body: 'Second', path: 'two.md', version: 'v2' }
beforeEach(() => {
  mocks.snapshot = { pages: [one, two], objectTypes: defaultObjectTypes, typesVersion: '', issues: [] }
  mocks.read.mockImplementation(async ({ payload }: { payload: { id: string } }) => payload.id === one.id ? one : two)
  mocks.save.mockImplementation(async ({ payload }: { payload: { input: SavePage } }) => ({ ...payload.input.metadata, body: payload.input.body, path: `${payload.input.metadata.id}.md`, version: 'saved-version' }))
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.useRealTimers() })
const openAlpha = async () => { fireEvent.click(screen.getAllByRole('button', { name: /📁 Alpha/ })[0]!); await screen.findByRole('textbox', { name: 'Page title' }) }

function Workspace() {
  const [active, setActive] = useState(true)
  return <WikiPanel active={active} onActivate={() => setActive(true)}>{({ navigation, content }) => <>
    <aside><button onClick={() => setActive(false)}>Tasks</button>{navigation(() => {})}</aside>
    <main><div hidden={!active}>{content}</div>{!active && <p>Task workspace</p>}</main>
  </>}</WikiPanel>
}

describe('Wiki knowledge workflow', () => {
  it('keeps the draft across workspace sections and saves it before opening another page from the shared sidebar', async () => {
    render(<Workspace />); await openAlpha()
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: 'Draft across sections' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(screen.getByText('Task workspace')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Page content' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /📝 Beta/ }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ payload: { input: expect.objectContaining({ body: 'Draft across sections', expectedVersion: 'v1' }) } }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Page title' }) as HTMLInputElement).value).toBe('Beta'))
    expect(screen.queryByText('Task workspace')).toBeNull()
    expect(document.querySelector('main nav, main aside')).toBeNull()
  })

  it('collapses the sidebar tree without navigating or discarding editor content', async () => {
    render(<Workspace />); await openAlpha()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Alpha' }))
    expect(screen.queryByRole('button', { name: /📝 Beta/ })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'Page content' }) as HTMLTextAreaElement).value).toBe('Original')
    fireEvent.click(screen.getByRole('button', { name: 'Expand Alpha' }))
    expect(screen.getByRole('button', { name: /📝 Beta/ })).toBeTruthy()
  })

  it('reveals a save conflict when returning from another module without replacing the draft', async () => {
    mocks.save.mockRejectedValue(new Error('This Page changed since it was opened.'))
    render(<Workspace />); await openAlpha()
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: 'Keep my draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    fireEvent.click(screen.getByRole('button', { name: /📝 Beta/ }))
    await screen.findByRole('alert')
    expect((screen.getByRole('textbox', { name: 'Page content' }) as HTMLTextAreaElement).value).toBe('Keep my draft')
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('opens the page tree, edits typed properties and saves the Markdown document', async () => {
    render(<WikiPanel active onActivate={() => {}}>{({ navigation, content }) => <>{navigation(() => {})}{content}</>}</WikiPanel>)
    await openAlpha()
    fireEvent.change(screen.getByRole('textbox', { name: 'Page title' }), { target: { value: 'Updated' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), { target: { value: 'In progress' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: '# Updated\n\nKnowledge' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ payload: { input: expect.objectContaining({ expectedVersion: 'v1', body: '# Updated\n\nKnowledge', metadata: expect.objectContaining({ title: 'Updated', properties: { status: 'In progress' } }) }) } }))
    await screen.findByText('Saved', { exact: true })
  })

  it('keeps unsaved content and blocks navigation after a conflict', async () => {
    mocks.save.mockRejectedValue(new Error('This Page changed since it was opened.'))
    render(<WikiPanel active onActivate={() => {}}>{({ navigation, content }) => <>{navigation(() => {})}{content}</>}</WikiPanel>); await openAlpha()
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: 'Local draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByRole('alert')
    fireEvent.click(screen.getAllByRole('button', { name: /📝 Beta/ })[0]!)
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2))
    expect((screen.getByRole('textbox', { name: 'Page content' }) as HTMLTextAreaElement).value).toBe('Local draft')
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('does not lose edits made while a save is in flight', async () => {
    let finish!: (page: PageDocument) => void
    mocks.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<WikiPanel active onActivate={() => {}}>{({ navigation, content }) => <>{navigation(() => {})}{content}</>}</WikiPanel>); await openAlpha()
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: 'First edit' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Page content' }), { target: { value: 'Newer edit' } })
    await act(async () => finish({ ...one, body: 'First edit', version: 'new-version' }))
    expect((screen.getByRole('textbox', { name: 'Page content' }) as HTMLTextAreaElement).value).toBe('Newer edit')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.save).toHaveBeenLastCalledWith({ payload: { input: expect.objectContaining({ body: 'Newer edit', expectedVersion: 'new-version' }) } }))
  })

  it('searches pages and scopes the table to an ObjectType', async () => {
    render(<WikiPanel active onActivate={() => {}}>{({ navigation, content }) => <>{navigation(() => {})}{content}</>}</WikiPanel>)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search pages' }), { target: { value: 'Alpha' } })
    expect(screen.getAllByRole('row')).toHaveLength(2)
    fireEvent.change(screen.getByRole('textbox', { name: 'Search pages' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /Project\s*1/ }))
    await screen.findByRole('columnheader', { name: 'Status' })
    expect(screen.getAllByRole('row')).toHaveLength(2)
  })

  it('creates a new Page with a stable ID and explicit new-file precondition', async () => {
    render(<WikiPanel active onActivate={() => {}}>{({ navigation, content }) => <>{navigation(() => {})}{content}</>}</WikiPanel>)
    fireEvent.click(screen.getAllByRole('button', { name: 'New page' })[0]!)
    await screen.findByRole('textbox', { name: 'Page title' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Page title' }), { target: { value: 'New knowledge' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ payload: { input: expect.objectContaining({ expectedVersion: null, metadata: expect.objectContaining({ title: 'New knowledge', objectType: 'page', id: expect.any(String) }) }) } }))
  })
})
