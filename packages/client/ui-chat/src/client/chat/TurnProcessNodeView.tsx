import { memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, PresentationInjected } from '../contract/slots.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { formatRunDuration } from './message-chrome.ts'
import a11yCss from './accessibility.module.css'
import css from './TurnProcessNodeView.module.css'
import { TurnProcessHeaderOutlet } from './ProcessHeaderTargets.tsx'

/** Settled Turn duration and process disclosure above its content. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t, usePresentation, useConversation,
}: ChatNodeViewProps<'turn-process'> & InjectFace<PresentationInjected>) {
  const inline = usePresentation(policy => policy.inlineCompletedSummary === true)
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  const open = !turnProcess.foldable || turnProcess.open
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn?.status !== 'closed') return null
  const canCollapse = turnProcess.foldable && turnProcess.hasContent && !turnProcessAlwaysOpen(node)
  const reason = turn.end?.data.reason.kind
  const elapsedMs = turn.start === undefined || turn.end === undefined ? undefined
    : Math.max(0, turn.end.time - turn.start.time)
  const duration = elapsedMs === undefined ? undefined : formatRunDuration(elapsedMs, t)
  const label = reason === 'aborted' ? t(duration === undefined ? 'message.stopped' : 'message.turnProcess.stoppedTook')
    : reason === 'error' ? t(duration === undefined ? 'message.turnProcess.failed' : 'message.turnProcess.failedTook')
      : duration === undefined ? t('message.turnProcess.worked')
        : t('message.turnProcess.took')
  const announcement = reason === 'aborted' ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : t('message.turnProcess.worked')
  const control = (
    <button
      type="button"
      className={`${css.root}${inline ? ` ${css.inlineControl}` : ''}`}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      disabled={!canCollapse}
      aria-expanded={turnProcess.hasContent ? open : undefined}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      <span className={css.label}>
        {label}
        {duration?.map((part, index) => (
          <span key={index} className={part.numeric ? css.durationNumber : undefined}>{part.text}</span>
        ))}
      </span>
      {canCollapse && <IconChevronDownOutlineRegular className={css.chevron} />}
    </button>
  )
  return <>
    <span className={a11yCss.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {inline ? <div className={css.inlineRow} data-turn-process-row={turn.turn}>
      {control}
      <TurnProcessHeaderOutlet turn={turn.turn} useConversation={useConversation} t={t} />
    </div> : control}
  </>
})
