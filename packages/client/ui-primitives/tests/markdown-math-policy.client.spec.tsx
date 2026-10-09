// @vitest-environment jsdom
import { cleanup, render, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MarkdownMathProvider } from '../src/index.ts'
import { MarkdownText } from './markdown-test-components.tsx'

afterEach(cleanup)

const currencyParagraphs = [
  '$230.48、日内区间 $225.67–$231.34，市值 $5.55T。',
  '**$2.46** 比预期 **$2.22** 高10.8%。',
  '**$720–745B**（当季预期） 与 **$835B**。',
  '$201.39、日内区间199.63–201.56；**收盘价** $201.39。',
]

it('preserves currency, Chinese prose, percentages and strong emphasis through settlement', () => {
  const source = currencyParagraphs.join('\n\n')
  const tree = (streaming: boolean) => <MarkdownMathProvider singleDollarTextMath={false}>
    <MarkdownText text={source} streaming={streaming} />
  </MarkdownMathProvider>
  const view = render(tree(true))
  expect(view.container.querySelector('.katex')).toBeNull()
  view.rerender(tree(false))
  expect(view.container.querySelector('.katex')).toBeNull()
  expect([...view.container.querySelectorAll('p')].map(node => node.textContent)).toEqual([
    '$230.48、日内区间 $225.67–$231.34，市值 $5.55T。',
    '$2.46 比预期 $2.22 高10.8%。',
    '$720–745B（当季预期） 与 $835B。',
    '$201.39、日内区间199.63–201.56；收盘价 $201.39。',
  ])
  expect([...view.container.querySelectorAll('strong')].map(node => node.textContent))
    .toEqual(['$2.46', '$2.22', '$720–745B', '$835B', '收盘价'])
})

it('keeps explicit backslash math, double-dollar display math and math fences enabled', () => {
  const source = [
    '行内 \\(E=mc^2\\)，价格 $230.48。', '',
    '\\[x^2+y^2=z^2\\]', '',
    '$$\\frac{a}{b}$$', '',
    '```math', '\\sum_{i=1}^{n} i', '```',
  ].join('\n')
  const view = render(<MarkdownMathProvider singleDollarTextMath={false}>
    <MarkdownText text={source} />
  </MarkdownMathProvider>)
  expect(view.container.querySelectorAll('.katex')).toHaveLength(4)
  expect(view.container.querySelectorAll('.katex-display')).toHaveLength(3)
  expect(view.container.querySelector('.katex-error')).toBeNull()
  expect([...view.container.querySelectorAll('annotation')].map(node => node.textContent))
    .toEqual(['E=mc^2', 'x^2+y^2=z^2', '\\frac{a}{b}', '\\sum_{i=1}^{n} i\n'])
  expect(view.container.textContent).toContain('$230.48')
})

it('preserves legacy single-dollar math and isolates nested and parallel owners', () => {
  const source = '$x+1$'
  const view = render(<>
    <section data-testid="default"><MarkdownText text={source} /></section>
    <MarkdownMathProvider singleDollarTextMath={false}>
      <section data-testid="literal"><MarkdownText text={source} /></section>
      <MarkdownMathProvider singleDollarTextMath={true}>
        <section data-testid="nested"><MarkdownText text={source} /></section>
      </MarkdownMathProvider>
    </MarkdownMathProvider>
    <MarkdownMathProvider singleDollarTextMath={true}>
      <section data-testid="parallel"><MarkdownText text={source} /></section>
    </MarkdownMathProvider>
  </>)
  for (const name of ['default', 'nested', 'parallel']) {
    expect(view.getByTestId(name).querySelectorAll('.katex')).toHaveLength(1)
  }
  const literal = view.getByTestId('literal')
  expect(literal.querySelector('.katex')).toBeNull()
  expect(literal.textContent).toBe(source)
})

it('reparses identical settled text when the owner changes its delimiter preference', () => {
  const source = '$x+1$'
  const tree = (enabled: boolean) => <MarkdownMathProvider singleDollarTextMath={enabled}>
    <MarkdownText text={source} />
  </MarkdownMathProvider>
  const view = render(tree(true))
  expect(view.container.querySelectorAll('.katex')).toHaveLength(1)
  view.rerender(tree(false))
  expect(view.container.querySelector('.katex')).toBeNull()
  expect(view.container.textContent).toBe(source)
  view.rerender(tree(true))
  expect(view.container.querySelectorAll('.katex')).toHaveLength(1)
})

it('retains frozen streaming blocks across policy changes and settles growing currency literally', () => {
  const prefix = '# Retained heading\n\nFirst paragraph.\n\nSecond paragraph.\n\nPrice $230.48'
  const tree = (text: string, enabled: boolean, streaming: boolean) =>
    <MarkdownMathProvider singleDollarTextMath={enabled}>
      <MarkdownText text={text} streaming={streaming} />
    </MarkdownMathProvider>
  const view = render(tree(prefix, false, true))
  const heading = view.getByRole('heading', { name: 'Retained heading' })
  view.rerender(tree(prefix, true, true))
  expect(view.getByRole('heading', { name: 'Retained heading' })).toBe(heading)
  expect(view.container.querySelector('.katex')).toBeNull()
  const settled = `${prefix} and market cap $5.55T.`
  view.rerender(tree(settled, false, true))
  expect(view.getByRole('heading', { name: 'Retained heading' })).toBe(heading)
  view.rerender(tree(settled, false, false))
  expect(view.getByRole('heading', { name: 'Retained heading' })).toBe(heading)
  expect(view.getByText('Price $230.48 and market cap $5.55T.')).toBeTruthy()
  expect(view.container.querySelector('.katex')).toBeNull()
})

it('preserves links and code syntax without enabling unsafe math or URL commands', () => {
  const source = [
    '[报价 $230.48](https://example.com/quote?symbol=NVDA)；`$2.46`；$5.55T。', '',
    '```text', 'Price $230.48 and $5.55T.', '```', '',
    '[unsafe](javascript:alert(1))', '',
    '\\(\\href{javascript:alert(1)}{unsafe math}\\)',
  ].join('\n')
  const view = render(<MarkdownMathProvider singleDollarTextMath={false}>
    <MarkdownText text={source} />
  </MarkdownMathProvider>)
  expect(view.getByRole('link', { name: '报价 $230.48' }).getAttribute('href'))
    .toBe('https://example.com/quote?symbol=NVDA')
  expect(view.container.querySelector('p code')?.textContent).toBe('$2.46')
  expect(view.container.querySelector('pre code')?.textContent).toContain('Price $230.48 and $5.55T.')
  expect(within(view.container).queryByRole('link', { name: 'unsafe' })).toBeNull()
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
})
