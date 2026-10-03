import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId, TeamMessageId } from '../src/index.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

describe('native coordinated crash recovery', () => {
  it('reloads the frozen second incumbent from JSONL, occupies E2 and atomically commits E3', async () => {
    const first = await leadCoordinatorHarness()
    await first.freeze()
    const next = await first.create('recovered-second-incumbent', 2)
    await first.coordinator.runAtSafePoint(first.lead, first.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: first.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } })
    })
    await first.stage('ready')
    await first.freeze('handoff-2', 2)
    await first.ctx.fiber.dispose()

    const recovered = await leadCoordinatorHarness({ resources: first.resources, resume: true })
    expect(recovered.state().leadCoordination).toMatchObject({ phase: 'frozen', previousExecutionId: next.agent.id, previousTerm: 2 })
    expect(recovered.ctx.agents.get(next.agent.id)).toBeUndefined()
    const third = await recovered.create('recovered-third-incumbent', 3)
    await recovered.coordinator.runAtSafePoint(recovered.lead, recovered.safeRequest('handoff-2', 2), async (safe) => {
      expect(safe.execution.id).toBe(next.agent.id)
      expect(safe.execution).not.toBe(recovered.lead)
      await safe.record({ recordId: 'second-prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: recovered.binding(third.agent), releases: [],
        record: { recordId: 'second-commit', dataJson: '{}' } })
    })
    await recovered.stage('ready', 'handoff-2', 2)
    expect(recovered.ctx.agentTeams.membership(third.agent).term).toBe(3)
    expect(recovered.state().leadHistory?.map(item => item.executionId)).toEqual([next.agent.id, third.agent.id])
    expect(recovered.adapter.requests).toEqual([])
    expect(recovered.lead.status).toBe('idle')
  })

  it('reloads a committed-not-ready seat, delivers its persisted fact material once and only then records readiness', async () => {
    const first = await leadCoordinatorHarness()
    await first.freeze()
    const next = await first.create('recovered-preload-recipient', 2)
    await first.coordinator.runAtSafePoint(first.lead, first.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: first.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' },
        notices: [{ id: TeamMessageId('summary-cold'), senderId: first.lead.id, senderName: 'lead', targetId: first.lead.id,
          content: [{ type: 'text', text: 'Automatic reference' }], contentAuthors: [null] }] })
    })
    await first.ctx.fiber.dispose()
    const recovered = await leadCoordinatorHarness({ resources: first.resources, resume: true })
    expect(recovered.state().leadCoordination?.phase).toBe('committed')
    expect(recovered.ctx.agentTeams.leadContext(recovered.lead).ready).toBe(false)
    const seat = recovered.ctx.agentTeams.leadContext(recovered.lead).seat
    await recovered.owner.preloadLeadMail(recovered.lead, seat)
    await recovered.owner.preloadLeadMail(recovered.lead, seat)
    const actual = recovered.ctx.agents.get(seat.executionId)
    expect(actual?.inbox.nextStep).toHaveLength(1)
    expect(recovered.state().leadDeliveries).toHaveLength(1)
    expect(recovered.adapter.requests).toEqual([])
    await recovered.stage('ready')
    expect(recovered.ctx.agentTeams.leadContext(recovered.lead).ready).toBe(true)
  })

  it('holds ordinary Lead input through a cancelled preparation and restores it without pretending it ran', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'queued original input' }], source: { kind: 'user' } }),
      target: 'next-step' as const, wakeup: false }
    await test.ctx.agents.receiveInput(test.lead, input)
    expect(test.lead.inbox.nextStep).toEqual([])
    await test.owner.queueHeld(test.lead)
    expect(test.state().messages).toHaveLength(1)
    await test.stage('cancelled')
    await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })
    expect(test.lead.inbox.nextStep).toEqual([input.message])
    expect(test.adapter.requests).toEqual([])
  })

  it('does not acknowledge a commit whose bound Task writer disappeared during its flush', async () => {
    const test = await leadCoordinatorHarness()
    await test.freeze()
    const candidate = await test.create('writer-disappears', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
      const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
        const confirmed = await original(session)
        test.writer.dispose()
        return confirmed
      })
      await expect(safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [],
        record: { recordId: 'commit', dataJson: '{}' } })).rejects.toMatchObject({ code: 'TEAM_TASK_EXTENSION_UNAVAILABLE' })
      flush.mockRestore()
      expect(test.state().lead?.executionId).toBe(candidate.agent.id)
    })
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
  })

  it('counts only unsettled Lead mail while preserving independent member and cancelled legacy queue facts', async () => {
    const test = await leadCoordinatorHarness({ config: { maxPendingMessagesPerMember: 3 } })
    const original = { message: createUserMessage({ content: [{ type: 'text', text: 'already received material' }], source: { kind: 'user' } }),
      target: 'next-step' as const, wakeup: false }
    await test.ctx.agents.receiveInput(test.lead, original)
    await test.owner.queueHeld(test.lead)
    expect(test.state().delivered).toHaveLength(1)
    await test.freeze()
    const pending = { ...original, message: createUserMessage({ content: [{ type: 'text', text: 'new held material' }], source: { kind: 'user' } }) }
    await test.ctx.agents.receiveInput(test.lead, pending)
    await test.owner.queueHeld(test.lead)
    expect(test.state().messages.filter(message => !test.state().delivered.includes(message.id))).toHaveLength(2)
    // Released ordinary queue and cancellation formats remain valid recovery inputs.
    const cancelled = { id: TeamMessageId('legacy-cancelled'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id, content: [] }
    const member = { ...cancelled, id: TeamMessageId('independent-member-mail'), targetId: SessionId('member') }
    test.lead.session.append('team/message/queued', { version: 2, teamId: TeamId(test.lead.id), message: cancelled })
    test.lead.session.append('team/message/cancelled', { version: 3, teamId: TeamId(test.lead.id), targetId: test.lead.id,
      messageIds: [cancelled.id], reason: 'legacy notice cancelled' })
    test.lead.session.append('team/message/queued', { version: 2, teamId: TeamId(test.lead.id), message: member })
    await test.ctx.sessions.flush(test.lead.session)
    const next = await test.create('queue-count-recipient', 2)
    await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: test.binding(next.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' },
        notices: [{ id: TeamMessageId('bounded-summary'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
          content: [{ type: 'text', text: 'automatic reference' }] }] })
    })
    expect(test.state().lead?.executionId).toBe(next.agent.id)
    expect(test.state().cancelled[0]?.messageId).toBe(cancelled.id)
  })
})
