// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageContentEditor } from './PageContentEditor'
afterEach(cleanup)

describe('Markdown-backed rich content', () => {
  it('renders headings, task items, links and tables without rewriting source on mount', async () => {
    const changed = vi.fn()
    const value = '# Heading\n\n**Strong** and [Reference](https://example.com) and [Page](folio-page:one)\n\n- [x] Done\n- [ ] Next\n\n| Name | Value |\n| --- | --- |\n| One | Two |'
    render(<PageContentEditor value={value} onChange={changed} chinese={false} />)
    expect(await screen.findByRole('heading', { name: 'Heading' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Reference' }).getAttribute('href')).toBe('https://example.com')
    expect(screen.getByRole('link', { name: 'Page' }).getAttribute('href')).toBe('folio-page:one')
    expect(screen.getByRole('table').textContent).toContain('One')
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }))
    expect((screen.getByRole('textbox', { name: 'Markdown source' }) as HTMLTextAreaElement).value).toBe(value)
    fireEvent.change(screen.getByRole('textbox', { name: 'Markdown source' }), { target: { value: '## Changed\n\nBody' } })
    expect(changed).toHaveBeenCalledWith('## Changed\n\nBody')
  })

  it('reflects source edits and explicit reloads in the rich editor', async () => {
    const view = render(<PageContentEditor value="# Before" onChange={() => {}} chinese={false} />)
    await screen.findByRole('heading', { name: 'Before' })
    view.rerender(<PageContentEditor value="## After" onChange={() => {}} chinese={false} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'After' }).tagName).toBe('H2'))
    expect(screen.queryByRole('heading', { name: 'Before' })).toBeNull()
  })
})
