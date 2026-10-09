// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarkdownMathProvider, MarkdownSyntaxProvider } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const ranges = '1Q26 +93~98% [1](https://example.com/first)，2Q26 +40%，3Q26 +13~18% [2](https://example.com/second)。'

it('keeps numeric ranges and citations intact while appending and settling financial prose', () => {
  const tree = (text: string, streaming: boolean) =>
    <MarkdownSyntaxProvider singleDollarTextMath={false} singleTildeStrikethrough={false}>
      <MarkdownText text={text} streaming={streaming} />
    </MarkdownSyntaxProvider>
  const partial = ranges.slice(0, ranges.indexOf('，3Q26'))
  const view = render(tree(partial, true))
  expect(view.container.querySelector('del')).toBeNull()
  view.rerender(tree(ranges, true))
  expect(view.container.querySelector('del')).toBeNull()
  expect(view.container.textContent).toContain('+93~98%')
  expect(view.container.textContent).toContain('+13~18%')
  view.rerender(tree(ranges, false))
  expect(view.container.querySelector('del')).toBeNull()
  expect(view.getByRole('link', { name: '1' }).getAttribute('href')).toBe('https://example.com/first')
  expect(view.getByRole('link', { name: '2' }).getAttribute('href')).toBe('https://example.com/second')
})

it('preserves double-tilde deletion and literal punctuation without changing native defaults', () => {
  const source = '~single~ and ~~double~~; $x+1$; `+93~98% ... +13~18%`'
  const view = render(<>
    <section data-testid="legacy"><MarkdownText text={source} /></section>
    <MarkdownSyntaxProvider singleDollarTextMath={false} singleTildeStrikethrough={false}>
      <section data-testid="financial"><MarkdownText text={source} /></section>
    </MarkdownSyntaxProvider>
  </>)
  const legacy = view.getByTestId('legacy')
  expect([...legacy.querySelectorAll('del')].map(node => node.textContent)).toEqual(['single', 'double'])
  expect(legacy.querySelectorAll('.katex')).toHaveLength(1)
  const financial = view.getByTestId('financial')
  expect([...financial.querySelectorAll('del')].map(node => node.textContent)).toEqual(['double'])
  expect(financial.querySelector('.katex')).toBeNull()
  expect(financial.textContent).toContain('~single~')
  expect(financial.textContent).toContain('$x+1$')
  expect(financial.querySelector('code')?.textContent).toBe('+93~98% ... +13~18%')
})

it('keeps old Math scopes compatible and inherits the enclosing tilde preference', () => {
  const source = '~range~ and $x+1$'
  const view = render(<>
    <MarkdownMathProvider singleDollarTextMath={false}>
      <section data-testid="old-math"><MarkdownText text={source} /></section>
    </MarkdownMathProvider>
    <MarkdownSyntaxProvider singleDollarTextMath={false} singleTildeStrikethrough={false}>
      <section data-testid="outer"><MarkdownText text={source} /></section>
      <MarkdownMathProvider singleDollarTextMath={true}>
        <section data-testid="nested-math"><MarkdownText text={source} /></section>
      </MarkdownMathProvider>
    </MarkdownSyntaxProvider>
  </>)
  const oldMath = view.getByTestId('old-math')
  expect(oldMath.querySelector('del')?.textContent).toBe('range')
  expect(oldMath.querySelector('.katex')).toBeNull()
  const outer = view.getByTestId('outer')
  expect(outer.querySelector('del')).toBeNull()
  expect(outer.querySelector('.katex')).toBeNull()
  const nested = view.getByTestId('nested-math')
  expect(nested.querySelector('del')).toBeNull()
  expect(nested.querySelectorAll('.katex')).toHaveLength(1)
})

it('rebuilds frozen streaming grammar when tilde preferences change for identical source', () => {
  const source = `# Prefix\n\n${ranges}\n\nAnother paragraph.\n\nThird paragraph.\n\nTail.`
  const tree = (singleTildeStrikethrough: boolean, streaming: boolean) =>
    <MarkdownSyntaxProvider singleDollarTextMath={false} singleTildeStrikethrough={singleTildeStrikethrough}>
      <MarkdownText text={source} streaming={streaming} />
    </MarkdownSyntaxProvider>
  const view = render(tree(true, true))
  expect(view.container.querySelector('del')?.textContent).toContain('98%')
  view.rerender(tree(false, true))
  expect(view.container.querySelector('del')).toBeNull()
  expect(view.container.textContent).toContain('+93~98%')
  view.rerender(tree(true, true))
  expect(view.container.querySelectorAll('del')).toHaveLength(1)
  view.rerender(tree(false, false))
  expect(view.container.querySelector('del')).toBeNull()
  view.rerender(tree(true, false))
  expect(view.container.querySelectorAll('del')).toHaveLength(1)
  view.rerender(tree(false, false))
  expect(view.container.querySelector('del')).toBeNull()
  expect(view.container.textContent).toContain('+13~18%')
})

it('retains monetary emphasis and explicit math when both ambiguous delimiters are disabled', () => {
  const source = [
    '**$2.46** 比 **$2.22** 高10.8%；股价 $230.48，市值 $5.55T；区间 +93~98% 至 +13~18%。', '',
    '行内 \\(E=mc^2\\)。', '', '\\[x^2+y^2=z^2\\]', '', '$$\\frac{a}{b}$$', '',
    '```math', '\\sum_{i=1}^{n} i', '```',
  ].join('\n')
  const tree = (streaming: boolean) =>
    <MarkdownSyntaxProvider singleDollarTextMath={false} singleTildeStrikethrough={false}>
      <MarkdownText text={source} streaming={streaming} />
    </MarkdownSyntaxProvider>
  const view = render(tree(true))
  expect(view.container.querySelector('del')).toBeNull()
  view.rerender(tree(false))
  expect(view.container.querySelector('del')).toBeNull()
  expect([...view.container.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['$2.46', '$2.22'])
  expect(view.container.querySelectorAll('.katex')).toHaveLength(4)
  expect(view.container.querySelector('.katex-error')).toBeNull()
  expect(view.container.textContent).toContain('区间 +93~98% 至 +13~18%')
})
