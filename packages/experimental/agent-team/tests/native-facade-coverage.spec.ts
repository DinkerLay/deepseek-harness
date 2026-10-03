import { SessionId, SessionLogOffset, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SubagentRunId, type SubagentSettlementNoticeFacts } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId, TeamTaskId } from '../src/index.ts'
import { TeamMailbox } from '../src/mailbox.ts'
import { facadeControlledMode, nativeFacadeHarness } from './native-facade-harness.ts'

function facts(parentSessionId: SessionId): SubagentSettlementNoticeFacts {
  return { runId: SubagentRunId('facade-settlement'), parentSessionId, childSessionId: SessionId('unrostered-child'),
    stopReason: 'completed', startSeq: SessionLogOffset(0), endSeq: SessionLogOffset(0),
    parentStartSeq: SessionLogOffset(0), events: [], firstInputOnly: false }
}

describe('native Team facade admission and lifecycle', () => {
  it('abstains from settlement decisions and fallback wording after the parent leaves', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode } })
    const missing = facts(SessionId('absent-parent'))
    expect(await test.policy(missing)).toBeUndefined()
    expect(test.wording(missing)).toBeUndefined()
    const unrelated = facts(test.lead.id)
    expect(await test.policy(unrelated)).toBeUndefined()
    expect(test.wording(unrelated)).toBeUndefined()
  })

  it('does not expose a Lead seat to a stale Agent identity', async () => {
    const test = await nativeFacadeHarness()
    expect(() => test.ctx.agentTeams.leadSeat(new Proxy(test.lead, {})))
      .toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))
    expect(test.ctx.agentTeams.leadSeat(test.lead)).toMatchObject({ executionId: test.lead.id, term: 1 })
  })

  it('logs a failed post-commit Task notice dispatch while retaining its durable record', async () => {
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode } })
    const unavailable = async (): Promise<never> => { throw new Error('Task mutation is outside this test') }
    const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
      create: unavailable, update: unavailable })
    const mailbox: unknown = Reflect.get(test.ctx.agentTeams, 'mailbox')
    if (!(mailbox instanceof TeamMailbox)) throw new Error('native mailbox was not initialized')
    const recovery = vi.spyOn(mailbox, 'recoverFor').mockRejectedValue(new Error('mailbox restart unavailable'))
    const warning = vi.spyOn(test.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      expect(await writer.commitRecord(test.lead, () => ({ recordId: 'notice-with-dispatch-error', dataJson: '{}',
        affectsComposition: true, notices: [{ id: TeamMessageId('facade-notice'), senderId: test.lead.id,
          senderName: 'lead', targetId: test.lead.id, content: [{ type: 'text', text: 'restore notice delivery' }] }] })))
        .toEqual({ recordId: 'notice-with-dispatch-error', committed: true })
      await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('Team Task notice dispatch failed: mailbox restart unavailable') })
      expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/extension')).toHaveLength(1)
    } finally { recovery.mockRestore(); warning.mockRestore(); writer.dispose() }
  })

  it.each(['member', 'task', 'message'] as const)('does not stamp controlled mode over a fresh publication containing historical %s data', async (kind) => {
    const anchor = SessionId('facade-anchor')
    const teamId = TeamId(anchor)
    let event: SessionEvent
    if (kind === 'member') event = { type: 'team/member/configured', seq: SessionSeq(0), time: 0,
      data: { version: 3, teamId, member: { id: SessionId('historical-member'), name: 'historical',
        description: 'historical role', provider: 'spawn', context: 'fresh', phase: 'provisioning' } } }
    else if (kind === 'task') event = { type: 'team/task', seq: SessionSeq(0), time: 0,
      data: { version: 2, teamId, task: { id: TeamTaskId('task-1'), revision: 1, subject: 'historical Task',
        description: 'retained', status: 'pending', blockedBy: [], writeScopes: [] } } }
    else event = { type: 'team/message/queued', seq: SessionSeq(0), time: 0, data: { version: 2, teamId,
      message: { id: TeamMessageId('historical-message'), senderId: anchor, senderName: 'lead',
        targetId: anchor, content: [{ type: 'text', text: 'historical notice' }] } } }
    const test = await nativeFacadeHarness({ config: { controlledMode: facadeControlledMode }, seed: [event] })
    expect(test.ctx.agentTeams.controlledMode(test.lead)).toBeUndefined()
    expect(test.lead.session.snapshotEvents().filter(record => record.type === 'team/mode')).toEqual([])
    expect(test.lead.session.snapshotEvents()[0]).toEqual(event)
  })
})
