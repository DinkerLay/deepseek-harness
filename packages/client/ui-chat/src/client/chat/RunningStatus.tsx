/** Running Turn clock isolated from the transcript's render cycle. */
import { memo, useEffect, useState, type ReactNode } from 'react'
import { TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatRunDuration, LIVE_RUN_CLOCK_INTERVAL_MS } from './message-chrome.ts'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import a11yCss from './accessibility.module.css'
import css from './ChatView.module.css'

interface RunningStatusProps {
  readonly startTime: number | undefined
  readonly t: ChatViewSlotProps['t']
  /** Decorative glyph from the running activity slot; omitted callers retain the native whale. */
  readonly glyph?: ReactNode
  /** Static native label and clock, without decorative glyphs or shimmer. */
  readonly quiet?: boolean
}

/**
 * Show live elapsed time after the current Turn's content without announcing ticks.
 * @param props - Current Turn start time and localized copy.
 * @returns the blue running indicator; mount only while the Session is running.
 */
export const RunningStatus = memo(function RunningStatus({
  startTime, t, quiet = false, glyph = <RunningWhaleTail />,
}: RunningStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (startTime === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, LIVE_RUN_CLOCK_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [startTime])
  const status = quiet ? t('chat.running') : t('chat.deepDiving')
  const label = startTime === undefined ? status : t(quiet ? 'chat.runningFor' : 'chat.deepDivingFor', {
    duration: formatRunDuration(Math.max(1000, now - startTime), t).map(part => part.text).join(''),
  })
  return (
    <div className={css.running} data-chat-running>
      <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{status}</span>
      <span className={css.runningDivider} aria-hidden="true" />
      <span className={css.runningContent}>
        {!quiet && glyph}
        {quiet ? <span className={css.runningText}>{label}</span>
          : <TextShimmer active className={css.runningText}>{label}</TextShimmer>}
      </span>
    </div>
  )
})
