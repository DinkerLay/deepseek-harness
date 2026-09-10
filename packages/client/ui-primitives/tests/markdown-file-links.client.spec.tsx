// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownText } from './markdown-test-components.tsx'
afterEach(cleanup)
it.each([false, true])('opens approved authored file links, streaming=%s', (streaming) => {
  const open = vi.fn()
  const fileMentions = { resolve: () => undefined,
    resolveLink: (path: string) => path === 'report.md' ? { open, title: '/work/report.md', label: 'Open report' } : undefined }
  const { container } = render(<MarkdownText streaming={streaming}
    text={'[report](report.md) [reference][doc] [web](https://example.com) [unsafe](javascript:alert)\n\n[doc]: report.md'}
    fileMentions={fileMentions} />)
  if (streaming) { expect(screen.queryAllByRole('button')).toHaveLength(0); return }
  for (const button of screen.getAllByRole('button', { name: 'Open report' })) fireEvent.click(button)
  expect(open).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com')
  expect(container.querySelector('[href^="javascript:"]')).toBeNull()
})
it('keeps file links inert without a caller vocabulary', () => {
  const { container } = render(<MarkdownText text="[report](report.md)" />)
  expect(container.textContent).toBe('report')
  expect(container.querySelector('a, button')).toBeNull()
})
