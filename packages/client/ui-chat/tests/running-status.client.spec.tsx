// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { RunningStatus } from '../src/client/chat/RunningStatus.tsx'
import { zh } from '../src/client/locale.ts'

const t = makeTranslate(zh, commonZh)

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(5_000) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function statusHarness(startTime?: number) {
  const view = render(<RunningStatus startTime={startTime} t={t} />)
  return {
    ...view,
    content: () => view.container.querySelector('[data-chat-running] > :last-child'),
    set: (nextStartTime?: number) => { view.rerender(<RunningStatus startTime={nextStartTime} t={t} />) },
  }
}

describe('RunningStatus', () => {
  it('waits for an open Turn start before allocating its clock', () => {
    const view = statusHarness()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
    view.set(1_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.querySelectorAll('[data-shimmer="true"]')).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    view.set()
    expect(view.content()?.textContent).toBe('深度求索中')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the indicator mounted while a continuous run moves to the next Turn', () => {
    const view = statusHarness(1_000)
    const content = view.content()
    const status = view.getByRole('status')
    const initialText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(initialText)
    view.set(7_000)
    expect(view.content()).toBe(content)
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(vi.getTimerCount()).toBe(1)
    const nextTurnText = content?.textContent
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(content?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(content?.textContent).not.toBe(nextTurnText)
    expect(view.getByRole('status')).toBe(status)
    expect(status.textContent).toBe('深度求索中')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the duration nonnegative when the start is ahead of the local clock', () => {
    const view = statusHarness(6_000)
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(view.content()?.textContent).toMatch(/^深度求索中，用时 \d+秒 ···$/)
    expect(view.content()?.textContent).not.toContain('-')
  })

  it('retains its clock and announcement when the decorative glyph changes', () => {
    const view = render(<RunningStatus startTime={1_000} t={t} glyph={<span data-test-glyph aria-hidden="true" />} />)
    const status = view.getByRole('status')
    const row = view.container.querySelector('[data-chat-running]')
    expect(row?.querySelector('[data-test-glyph]')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(row?.textContent).toContain('用时 6秒')
    view.rerender(<RunningStatus startTime={1_000} t={t} glyph={null} />)
    expect(row?.querySelector('[data-test-glyph], svg')).toBeNull()
    expect(view.getByRole('status')).toBe(status)
    expect(vi.getTimerCount()).toBe(1)
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(row?.textContent).toContain('用时 7秒')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows quiet running text and elapsed time without mounting an animated glyph or shimmer', () => {
    const view = render(<RunningStatus startTime={1_000} t={t} quiet glyph={<span data-animated-glyph />} />)
    const row = view.container.querySelector('[data-chat-running]')
    const status = view.getByRole('status')
    expect(row?.querySelector('[data-animated-glyph], svg, [data-shimmer]')).toBeNull()
    expect(status.textContent).toBe('运行中')
    expect(row?.textContent).toContain('运行中，用时 4秒')
    act(() => { vi.advanceTimersByTime(2_000) })
    expect(row?.textContent).toContain('运行中，用时 6秒')
    expect(view.getByRole('status')).toBe(status)
    expect(vi.getTimerCount()).toBe(1)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

})
