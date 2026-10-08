/** Default activity contribution over the native running-Turn clock. */
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PresentationInjected } from '../contract/slots.ts'
import { presentationPolicyFor, type ChatPresentationPolicy } from '../presentation-policy.ts'
import { RunningStatus } from './RunningStatus.tsx'
import { RunningWhaleTail } from './RunningWhaleTail.tsx'
import { NS } from '../locale.ts'

/** @param props - Turn start time and localized native copy. @returns the native running indicator. */
export function TurnActivity({ startTime, renderSlot, t, usePresentation }: PropsRuntime<'conversation.chat.activity'>
  & PropsRenderSlots<'conversation.chat.activity.icon'> & PropsLocale<'chat'> & InjectFace<PresentationInjected>) {
  const quiet = usePresentation(policy => policy.quietActivity === true)
  return <RunningStatus startTime={startTime ?? undefined} t={t} quiet={quiet}
    glyph={quiet ? null : renderSlot('conversation.chat.activity.icon', { startTime })} />
}

/** Register the native activity and its separately replaceable decorative glyph. */
export function registerTurnActivity(ctx: Context, presentation: ObservableSnapshot<ChatPresentationPolicy> = {
  getSnapshot: () => presentationPolicyFor('detailed'), subscribe: () => () => {},
}): void {
  ctx.slots.inject('conversation.chat.activity', () => ctx.slots.register({
    name: 'conversation.chat.activity', locale: NS,
    inject: (): PresentationInjected => ({ hooks: { presentation } }),
    children: { 'conversation.chat.activity.icon': { kind: 'single', scope: 'session' } },
  }, TurnActivity))
  ctx.slots.inject('conversation.chat.activity.icon', () => ctx.slots.register({
    name: 'conversation.chat.activity.icon',
  }, RunningWhaleTail))
}
