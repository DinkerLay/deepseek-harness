import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AgentInput, Agent } from '@deepseek-ai/dsh-agent'
import { describe, expect, it, vi } from 'vitest'
import { TeamMessageId, TeamTaskId } from '../src/index.ts'
import { facadeControlledMode } from './native-facade-harness.ts'
import { leadMailHarness as setup } from './lead-mail-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const signal = new AbortController().signal

function input(text: string, wakeup = false): AgentInput {
  return { message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    target: 'next-step', wakeup }
}

describe('native Lead-seat mail', () => {
  it('preloads the same original input across two seats without waking and retains each capture receipt', async () => {
    const test = await setup([textResponse('current Lead answer')])
    const original = input('material prepared before the first handoff')
    await test.ctx.agents.receiveInput(test.lead, original)
    const firstIds = await test.owner.queueHeld(test.lead)
    const second = await test.create('lead-second', 2)
    const third = await test.create('lead-third', 3)
    try {
      await test.commit(second, 1)
      expect(await test.owner.preloadLeadMail(test.lead, { executionId: second.agent.id, term: 2 })).toMatchObject([
        { messageId: firstIds[0], executionId: second.agent.id, term: 2 },
      ])
      expect(second.agent.inbox.nextStep).toEqual([original.message])
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('released')
      const secondIds = await test.owner.queueHeld(second.agent)
      expect(secondIds).toHaveLength(1)
      expect(secondIds[0]).not.toBe(firstIds[0])
      await test.commit(third, 2)
      await test.owner.preloadLeadMail(test.lead, { executionId: third.agent.id, term: 3 })
      expect(third.agent.inbox.nextStep).toEqual([original.message])
      expect(test.ctx.agents.inputControlState(second.agent.session).records[0]?.location).toBe('released')
      expect(test.state().delivered).toEqual([firstIds[0], secondIds[0]])
      expect(test.state().leadDeliveries?.map(receipt => receipt.term)).toEqual([2, 3])
      expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/message/delivered')).toEqual([])
      expect(test.adapter.requests).toHaveLength(0)
      test.readiness.ready = true
      await test.ctx.agents.receiveInput(third.agent, { ...input('continue current work', true), target: 'next-turn' })
      await third.agent.whenIdle()
      expect(test.adapter.requests).toHaveLength(1)
      expect(test.lead.status).toBe('idle')
      expect(second.agent.status).toBe('idle')
    } finally { await third.dispose(); await second.dispose(); await test.owner.dispose() }
  })

  it('restores cancelled preparation to the same execution and gives the next capture a new key', async () => {
    const test = await setup()
    const original = input('preserved cancelled input')
    await test.ctx.agents.receiveInput(test.lead, original)
    const first = await test.owner.queueHeld(test.lead)
    await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })
    expect(test.lead.inbox.nextStep).toEqual([original.message])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('inbox')
    expect(test.lead.session.snapshotEvents().filter(event => event.type === 'agent/input/released')).toEqual([])
    const next = await test.owner.queueHeld(test.lead)
    expect(next[0]).not.toBe(first[0])
    expect(test.state().messages.map(message => message.transfer?.input.message.id)).toEqual([original.message.id, original.message.id])
    expect(test.state().delivered).toEqual(first)
    expect(test.adapter.requests).toHaveLength(0)
    await test.owner.dispose()
  })

  it('retains current operation replies while frozen and rejects them from a superseded execution', async () => {
    const test = await setup()
    const reply = createUserMessage({ content: [{ type: 'text', text: 'operation answer' }],
      source: { kind: 'user-question-reply', callId: ToolCallId('question-call'), outcome: 'answered' } })
    await test.ctx.agents.receiveInput(test.lead, { message: reply, target: 'next-step', wakeup: true })
    expect(await test.owner.queueHeld(test.lead)).toEqual([])
    expect(test.state().messages).toEqual([])
    const second = await test.create('reply-current', 2)
    try {
      await test.commit(second, 1)
      await expect(test.ctx.agents.receiveInput(test.lead, { message: { ...reply, id: createUserMessage({
        content: [], source: { kind: 'user' },
      }).id }, target: 'next-step', wakeup: true })).rejects.toThrow('superseded execution')
      expect(test.ctx.agents.inputControlState(test.lead.session).records).toHaveLength(1)
      expect(test.adapter.requests).toHaveLength(0)
    } finally { await second.dispose(); await test.owner.dispose() }
  })

  it('does not let Team message cancellation discard reliably held source input', async () => {
    const test = await setup()
    const original = input('user custody survives Team cancel')
    await test.ctx.agents.receiveInput(test.lead, original)
    const ids = await test.owner.queueHeld(test.lead)
    test.readiness.ready = true
    await expect(test.ctx.agentTeams.cancelPendingMessages(test.lead, 'lead', 'discard transferred work'))
      .rejects.toMatchObject({ code: 'TEAM_MESSAGE_TARGET_DENIED' })
    expect(test.state().cancelled).toEqual([])
    expect(test.state().messages[0]?.id).toBe(ids[0])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    await test.owner.dispose()
  })

  it('reads a frozen current execution without granting authority and preserves valid historical authors', async () => {
    const test = await setup()
    const second = await test.create('readonly-second', 2)
    const third = await test.create('readonly-third', 3)
    try {
      expect(test.ctx.agentTeams.leadContext(second.agent).execution).toBe(test.lead)
      expect(() => test.ctx.agentTeams.membership(second.agent)).toThrow()
      await test.commit(second, 1)
      const context = test.ctx.agentTeams.leadContext(test.lead)
      expect(context.execution).toBe(second.agent)
      expect(context.ready).toBe(false)
      Object.assign(context.seat, { term: 900 })
      expect(test.ctx.agentTeams.leadContext(second.agent).seat.term).toBe(2)
      expect(() => test.ctx.agentTeams.membership(second.agent)).toThrow()
      await test.commit(third, 2)
      expect(test.ctx.agentTeams.isLeadAuthor(third.agent, test.lead.id)).toBe(true)
      expect(test.ctx.agentTeams.isLeadAuthor(third.agent, test.lead.id, 2)).toBe(false)
      expect(test.ctx.agentTeams.isLeadAuthor(third.agent, second.agent.id, 2)).toBe(true)
      expect(test.ctx.agentTeams.isLeadAuthor(third.agent, second.agent.id)).toBe(false)
      expect(test.ctx.agentTeams.isLeadAuthor(third.agent, second.agent.id, 3)).toBe(false)
      expect(() => test.ctx.agentTeams.leadContext(new Proxy(second.agent, {}))).toThrow()
    } finally { await third.dispose(); await second.dispose(); await test.owner.dispose() }
  })

  it('keeps old requirement authors when a current Lead relays them and stamps only the actual sender term', async () => {
    const test = await setup([textResponse('first requirement read'), textResponse('relayed requirement read')])
    test.readiness.ready = true
    const unavailable = async (): Promise<never> => { throw new Error('Task mutation is outside the author test') }
    const writer = test.ctx.agentTeams.installTaskExtension({ id: facadeControlledMode.requiredTaskExtensionId,
      validateMemberGroup: () => {}, assessSettlementNotice: () => 'suppress', create: unavailable, update: unavailable })
    const member = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'author-reader', description: 'requirements reader',
      group: 'readers', presetId: 'reviewer', context: 'fresh', provider: 'spawn', prompt: [], signal })
    const sent = await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'unchanged original requirements' }], signal })
    const original = test.state().messages.find(message => message.id === sent.messageId)
    expect(original?.senderTerm).toBe(1)
    expect(original?.contentAuthors).toEqual([{ executionId: test.lead.id, term: 1 }])
    await vi.waitFor(() => { expect(test.ctx.agents.get(member.member.id)).toBeUndefined() })
    const second = await test.create('author-current', 2)
    try {
      await test.commit(second, 1)
      await writer.commitRecord(second.agent, () => ({ recordId: 'relayed-author', dataJson: '{}', notices: [{
        id: TeamMessageId('relayed-author-notice'), senderId: second.agent.id, senderName: 'lead', targetId: member.member.id,
        content: [{ type: 'text', text: 'Requirement relay' }, { type: 'text', text: 'unchanged original requirements' }],
        contentParts: ['fact', 'fact'], contentAuthors: [null, { executionId: test.lead.id, term: 1 }],
      }] }))
      await vi.waitFor(() => { expect(test.state().delivered).toContain(TeamMessageId('relayed-author-notice')) })
      await vi.waitFor(() => { expect(test.ctx.agents.get(member.member.id)).toBeUndefined() })
      const reader = await test.ctx.sessionPersistence.open(member.member.id, 'read')
      const stored = await reader.read()
      await reader.close()
      const relayed = stored.events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'team-message' && event.data.source.messageId === 'relayed-author-notice')
      expect(relayed?.type === 'user/message' && relayed.data.source.kind === 'team-message' ? relayed.data.source : undefined)
        .toMatchObject({ senderId: second.agent.id, senderTerm: 2,
          contentAuthors: [null, null, { executionId: test.lead.id, term: 1 }] })
      await expect(writer.commitRecord(second.agent, () => ({ recordId: 'forged-term', dataJson: '{}', notices: [{
        id: TeamMessageId('forged-term'), senderId: second.agent.id, senderName: 'lead', senderTerm: 88,
        targetId: member.member.id, content: [],
      }] }))).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      await expect(writer.commitRecord(second.agent, () => ({ recordId: 'forged-author', dataJson: '{}', notices: [{
        id: TeamMessageId('forged-author'), senderId: second.agent.id, senderName: 'lead', targetId: member.member.id,
        content: [{ type: 'text', text: 'unproven requirement' }], contentParts: ['sender'],
        contentAuthors: [{ executionId: second.agent.id, term: 77 }],
      }] }))).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      const forged = { id: TeamMessageId('forged-owner-transfer'), senderId: second.agent.id, senderName: 'lead',
        targetId: test.lead.id, content: [] }
      Reflect.set(forged, 'transfer', { sourceExecutionId: test.lead.id, heldSeq: 0, input: input('not a held source fact') })
      await expect(writer.commitRecord(second.agent, () => ({ recordId: 'forged-owner-transfer', dataJson: '{}', notices: [forged] })))
        .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      await expect(writer.commit(second.agent, () => ({ dataJson: '{}', notices: [forged], updates: [{ previousRevision: null,
        task: { id: TeamTaskId('task-1'), revision: 1, subject: 'forged custody', description: 'no owned capture',
          status: 'pending', blockedBy: [], writeScopes: [] },
      }] }))).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
      expect(test.state().messages.some(message => message.id === forged.id)).toBe(false)
    } finally { writer.dispose(); await second.dispose(); await test.owner.dispose() }
  })

  it.each(['false', 'throw'] as const)('reconfirms an in-memory Lead receipt after root flush %s before releasing source custody', async (failure) => {
    const test = await setup()
    const original = input('source remains until root confirms')
    await test.ctx.agents.receiveInput(test.lead, original)
    const ids = await test.owner.queueHeld(test.lead)
    const second = await test.create(`receipt-${failure}`, 2)
    await test.commit(second, 1)
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failing = true
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === test.lead.session && test.state().leadDeliveries?.length && failing) {
        if (failure === 'throw') throw new Error('root receipt observer failed')
        return false
      }
      return flush(session)
    })
    try {
      await expect(test.owner.preloadLeadMail(test.lead, { executionId: second.agent.id, term: 2 })).rejects.toThrow()
      expect(second.agent.inbox.nextStep).toEqual([original.message])
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
      expect(test.state().delivered).toEqual(ids)
      failing = false
      await test.owner.preloadLeadMail(test.lead, { executionId: second.agent.id, term: 2 })
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('released')
      expect(test.lead.session.snapshotEvents().filter(event => event.type === 'team/message/lead-delivered')).toHaveLength(1)
      expect(second.agent.inbox.nextStep).toHaveLength(1)
      expect(test.adapter.requests).toHaveLength(0)
    } finally { checkpoint.mockRestore(); await second.dispose(); await test.owner.dispose() }
  })

  it('restores an offline E2 solely for old receipt cleanup after a fresh S1 and E3 restart', async () => {
    const first = await setup()
    const second = await first.create('offline-source-second', 2)
    const third = await first.create('offline-current-third', 3)
    await first.commit(second, 1)
    const original = input('historical source custody')
    await first.ctx.agents.receiveInput(second.agent, original)
    const ids = await first.owner.queueHeld(second.agent)
    await first.commit(third, 2)
    const open = first.ctx.sessionPersistence.open.bind(first.ctx.sessionPersistence)
    const stopped = vi.spyOn(first.ctx.sessionPersistence, 'open').mockImplementation((id, access, options) => {
      if (id === second.agent.id && access === 'read') return Promise.reject(new Error('crash before source cleanup'))
      return open(id, access, options)
    })
    await expect(first.owner.preloadLeadMail(first.lead, { executionId: third.agent.id, term: 3 }))
      .rejects.toThrow('crash before source cleanup')
    expect(first.ctx.agents.inputControlState(second.agent.session).records[0]?.location).toBe('held')
    expect(first.state().delivered).toEqual(ids)
    await first.ctx.fiber.dispose()
    stopped.mockRestore()
    const restored = await setup([], { resources: first.resources, resume: true })
    try {
      expect(restored.ctx.agents.get(second.agent.id)).toBeUndefined()
      expect(restored.ctx.agentTeams.leadContext(restored.lead).execution).toBeUndefined()
      await restored.owner.preloadLeadMail(restored.lead, { executionId: third.agent.id, term: 3 })
      const source = restored.ctx.agents.get(second.agent.id)
      expect(source).toBeDefined()
      if (source === undefined) throw new Error('historical source was not restored')
      expect(restored.ctx.agents.inputControlState(source.session).records[0]?.location).toBe('released')
      expect(restored.ctx.agents.canStartInput(source)).toBe(false)
      expect(restored.ctx.agentTeams.tryMembership(source)).toBeUndefined()
      expect(restored.adapter.requests).toHaveLength(0)
      expect(restored.state().leadDeliveries).toHaveLength(1)
    } finally { await restored.owner.dispose() }
  })

  it('cancels a pending current-execution resolver on registration removal without an externally released barrier', async () => {
    const test = await setup()
    const current = await test.create('resolver-current', 2)
    await test.commit(current, 1)
    await current.dispose()
    const entered = Promise.withResolvers<undefined>()
    let receivedSignal: AbortSignal | undefined
    test.provider.resolveExecution = async (_id, cancel) => {
      receivedSignal = cancel
      entered.resolve(undefined)
      return await new Promise<Agent>(() => {})
    }
    // Reload the provider registration to capture this resolver generation.
    await test.owner.dispose()
    const owner = test.ctx.agentTeams.installLeadExecutions(test.provider)
    const original = input('resolver cancellation input')
    await test.ctx.agents.receiveInput(test.lead, original)
    await owner.queueHeld(test.lead)
    const waiting = owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
      .then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    await owner.dispose()
    expect(await waiting).toHaveProperty('error')
    expect(receivedSignal?.aborted).toBe(true)
    expect(test.ctx.agents.get(current.agent.id)).toBeUndefined()
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    expect(test.adapter.requests).toHaveLength(0)
  })
})
