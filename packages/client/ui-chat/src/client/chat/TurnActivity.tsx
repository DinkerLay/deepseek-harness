/** Default activity contribution over the native running-Turn clock. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { RunningStatus } from './RunningStatus.tsx'

/** @param props - Turn start time and localized native copy. @returns the native running indicator. */
export function TurnActivity({ startTime, t }: PropsRuntime<'conversation.chat.activity'> & PropsLocale<'chat'>) {
  return <RunningStatus startTime={startTime ?? undefined} t={t} />
}
