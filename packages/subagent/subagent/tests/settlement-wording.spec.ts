import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished } from 'vitest'
import Subagents, { SubagentRunId, type SubagentSettlementNoticeFacts, type SubagentSettlementNoticeWording } from '../src/index.ts'

it('preserves one explicit send wording from a settlement policy', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Subagents)
  const wording = { action: 'send' as const, subject: 'Controlled member', detail: 'Work remains to be reviewed.' }
  ctx.subagents.registerSettlementNoticePolicy(() => wording)
  const decide = Reflect.get(ctx.subagents, 'sendSettlementNotice') as (
    facts: SubagentSettlementNoticeFacts,
  ) => Promise<'send' | 'suppress' | SubagentSettlementNoticeWording>
  expect(await decide.call(ctx.subagents, { runId: SubagentRunId('wording-run'), parentSessionId: SessionId('wording-parent'),
    childSessionId: SessionId('wording-child'), stopReason: 'completed', startSeq: SessionLogOffset(0),
    endSeq: SessionLogOffset(0), parentStartSeq: SessionLogOffset(0), events: [], firstInputOnly: false })).toEqual(wording)
})
