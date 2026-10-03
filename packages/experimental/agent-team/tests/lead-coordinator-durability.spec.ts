import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TeamId, TeamLeadOperationId, TeamMessageId } from '../src/index.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { leadCoordinatorHarness } from './lead-coordinator-harness.ts'

async function committed() {
  const test = await leadCoordinatorHarness({}, [textResponse('Input handled after ready confirmation')])
  await test.freeze()
  const candidate = await test.create('ready-durability-recipient', 2)
  await test.coordinator.runAtSafePoint(test.lead, test.safeRequest(), async (safe) => {
    await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
    await safe.commitLeadTransaction({ binding: test.binding(candidate.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' } })
  })
  return { ...test, candidate }
}

describe('coordinated readiness durability', () => {
  it.each(['blocked', 'false', 'throw'] as const)('keeps execution closed while ready checkpoint is %s', async (outcome) => {
    const test = await committed()
    const enter = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      enter.resolve(undefined)
      await release.promise
      if (outcome === 'false') return false
      if (outcome === 'throw') throw new Error('ready checkpoint failed')
      return await original(session)
    })
    const ready = test.stage('ready')
    const settled = ready.then(() => ({ accepted: true }), (error: unknown) => ({ error }))
    await enter.promise
    expect(test.state().leadCoordination?.phase).toBe('ready')
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'new input during confirmation' }], source: { kind: 'user' } }),
      target: 'next-step' as const, wakeup: true }
    await test.ctx.agents.receiveInput(test.candidate.agent, input)
    expect(test.candidate.agent.inbox.nextStep).toEqual([])
    expect(test.adapter.requests).toEqual([])
    release.resolve(undefined)
    const result = await settled
    if (outcome === 'blocked') expect(result).toEqual({ accepted: true })
    else {
      expect(result).toHaveProperty('error')
      expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
      expect(test.adapter.requests).toEqual([])
      await test.stage('ready')
    }
    flush.mockRestore()
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    await test.candidate.agent.whenIdle()
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
  })

  it('contains observer exceptions after durability and still refreshes every other observer', async () => {
    const test = await committed()
    let observed = 0
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.ctx.on('agent-team/confirmed', () => { throw new Error('observer failed') })
    test.ctx.on('agent-team/confirmed', () => { observed++ })
    await test.stage('ready')
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(observed).toBe(1)
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
    warn.mockRestore()
  })

  it('keeps a ready Lead admitted during material-only flush and dispatches the fact notice only after confirmation', async () => {
    const test = await committed()
    await test.stage('ready')
    const enter = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      enter.resolve(undefined)
      await release.promise
      return await original(session)
    })
    const notice = { id: TeamMessageId('edited-summary'), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
      content: [{ type: 'text' as const, text: 'Manually edited reference, without any added authority' }] }
    const material = { operationId: TeamLeadOperationId('handoff-1'), previousTerm: 1, recordId: 'summary-edit', dataJson: '{"edited":true}',
      notices: [notice] }
    const editing = test.coordinator.record(test.lead, material)
    await enter.promise
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(true)
    expect(test.ctx.agentTeams.membership(test.candidate.agent).role).toBe('lead')
    expect(test.candidate.agent.inbox.nextStep).toEqual([])
    expect(test.adapter.requests).toEqual([])
    release.resolve(undefined)
    await editing
    flush.mockRestore()
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    await test.candidate.agent.whenIdle()
    expect(test.state().messages.find(item => item.id === notice.id)?.contentAuthors).toEqual([null])
    await test.coordinator.record(test.lead, material)
    expect(test.state().messages.filter(item => item.id === notice.id)).toHaveLength(1)
    await expect(test.coordinator.record(test.lead, { ...material, notices: [{ ...notice,
      content: [{ type: 'text', text: 'different effects' }] }] })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
  })

  it('cold-preloads fact summary before captured user and member backlog, preserving each original identity once', async () => {
    const first = await leadCoordinatorHarness()
    const memberId = SessionId('summary-order-member')
    const member = { id: memberId, name: 'summary-order-member', description: 'Member', provider: 'spawn', context: 'fresh' as const,
      phase: 'provisioning' as const }
    first.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(first.lead.id), member })
    first.lead.session.append('team/member/configured', { version: 3, teamId: TeamId(first.lead.id), member: { ...member, phase: 'active' } })
    const child = await first.ctx.agents.create({ sessionId: memberId, meta: { parentSession: first.lead.id },
      agentOptions: { provider: 'mock', model: 'mock' } })
    await first.freeze()
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'frozen user backlog' }], source: { kind: 'user' } }),
      target: 'next-step' as const, wakeup: false }
    await first.ctx.agents.receiveInput(first.lead, input)
    await first.owner.queueHeld(first.lead)
    const mail = await first.ctx.agentTeams.sendMessage(child.agent, { target: 'lead', content: [{ type: 'text', text: 'frozen member backlog' }],
      signal: new AbortController().signal })
    await child.dispose()
    const candidate = await first.create('summary-order-recipient', 2)
    const summaryId = TeamMessageId('initial-handoff-summary')
    await first.coordinator.runAtSafePoint(first.lead, first.safeRequest(), async (safe) => {
      await safe.record({ recordId: 'prepared', dataJson: '{}' }, true)
      await safe.commitLeadTransaction({ binding: first.binding(candidate.agent), releases: [], record: { recordId: 'commit', dataJson: '{}' },
        notices: [{ id: summaryId, senderId: first.lead.id, senderName: 'lead', targetId: first.lead.id,
          content: [{ type: 'text', text: 'Automatic initialization reference' }] }] })
    })
    await first.ctx.fiber.dispose()
    const recovered = await leadCoordinatorHarness({ resources: first.resources, resume: true })
    const seat = recovered.ctx.agentTeams.leadContext(recovered.lead).seat
    await recovered.owner.preloadLeadMail(recovered.lead, seat)
    await recovered.owner.preloadLeadMail(recovered.lead, seat)
    const inbox = recovered.ctx.agents.get(seat.executionId)?.inbox.nextStep
    expect(inbox?.map(item => item.id)).toEqual([summaryId, input.message.id, mail.messageId])
    expect(inbox?.[0]?.source.kind).toBe('team-message')
    expect(inbox?.[1]?.source.kind).toBe('user')
    expect(recovered.state().leadDeliveries).toHaveLength(3)
    expect(recovered.adapter.requests).toEqual([])
  })
})
