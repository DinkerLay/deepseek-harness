/** Default activity contribution over the native running-Turn clock. */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import { RunningStatus } from './RunningStatus.tsx'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import { NS } from '../locale.ts'

/** @param props - Turn start time and localized native copy. @returns the native running indicator. */
export function TurnActivity({ startTime, renderSlot, t }: PropsRuntime<'conversation.chat.activity'>
  & PropsRenderSlots<'conversation.chat.activity.icon'> & PropsLocale<'chat'>) {
  return <RunningStatus startTime={startTime ?? undefined} t={t}
    glyph={renderSlot('conversation.chat.activity.icon', { startTime })} />
}

/** Register the native activity and its separately replaceable decorative glyph. */
export function registerTurnActivity(ctx: Context): void {
  ctx.slots.inject('conversation.chat.activity', () => ctx.slots.register({
    name: 'conversation.chat.activity', locale: NS,
    children: { 'conversation.chat.activity.icon': { kind: 'single', scope: 'session' } },
  }, TurnActivity))
  ctx.slots.inject('conversation.chat.activity.icon', () => ctx.slots.register({
    name: 'conversation.chat.activity.icon',
  }, RunningWhaleTail))
}
