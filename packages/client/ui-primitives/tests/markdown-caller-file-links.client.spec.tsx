// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MarkdownDelegateProvider } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

it.each([false, true])('routes approved authored file links only after settlement, streaming=%s', (streaming) => {
  const open = vi.fn()
  const resolveLink = vi.fn((path: string) => path === 'report.md'
    ? { open, title: '/work/report.md', label: 'Open report' }
    : undefined)
  const { container } = render(<MarkdownText streaming={streaming}
    text={'[report](report.md) [reference][doc] [web](https://example.com) [unsafe](javascript:alert)\n\n[doc]: report.md'}
    fileMentions={{ resolve: () => undefined, resolveLink }} />)
  if (streaming) {
    expect(resolveLink).not.toHaveBeenCalled()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  } else {
    for (const button of screen.getAllByRole('button', { name: 'Open report' })) fireEvent.click(button)
    expect(open).toHaveBeenCalledTimes(2)
  }
  expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com')
  expect(container.querySelector('[href^="javascript:"]')).toBeNull()
})

it('retains the official scoped file delegate when the caller does not claim a destination', () => {
  const openFile = vi.fn()
  render(<MarkdownDelegateProvider openFile={openFile}>
    <MarkdownText text="[report](report.md#L12)" fileMentions={{ resolve: () => undefined, resolveLink: () => undefined }} />
  </MarkdownDelegateProvider>)
  fireEvent.click(screen.getByRole('button'))
  expect(openFile).toHaveBeenCalledWith('report.md', { line: 12 })
})
