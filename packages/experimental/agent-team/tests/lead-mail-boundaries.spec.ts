import type { InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { TeamId, TeamMessageId } from '../src/index.ts'
import type { TeamMessageSnapshot } from '../src/index.ts'
import { TeamJournal } from '../src/journal.ts'
import { TeamLeadMail } from '../src/lead-mail.ts'
import type { LeadMailOperations } from '../src/lead-mail.ts'
import { TeamRuntimeLifecycle } from '../src/lifecycle.ts'
import { teamMessageDeliveryContent } from '../src/mailbox.ts'
import { leadMailHarness } from './lead-mail-harness.ts'
import { textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

type Harness = Awaited<ReturnType<typeof leadMailHarness>>

function material(text = 'source-controlled input', wakeup = false) {
  return { message: createUserMessage({ content: [{ type: 'text' as const, text }], source: { kind: 'user' } }),
    target: 'next-step' as const, wakeup }
}

function notice(test: Harness, id: string): TeamMessageSnapshot {
  return { id: TeamMessageId(id), senderId: test.lead.id, senderName: 'lead', targetId: test.lead.id,
    content: [{ type: 'text', text: id }] }
}

function receiver(test: Harness, overrides: Partial<LeadMailOperations> = {}, maxPending = 32, maxBytes = 65536) {
  const runtime = Reflect.get(test.ctx.agentTeams, 'leadExecutions') as { input: InputControllerHandle }
  const input = runtime.input
  const journal = new TeamJournal(test.ctx, () => {})
  const lifecycle = new TeamRuntimeLifecycle(1000)
  const operations: LeadMailOperations = {
    context: agent => test.ctx.agentTeams.leadContext(agent), canDeliver: () => test.readiness.ready,
    resolve: async anchor => test.ctx.agentTeams.leadContext(anchor),
    resolveSource: async (_anchor, id) => {
      const source = test.ctx.agents.get(id)
      if (source === undefined) throw new Error('source boundary requires a live execution')
      return source
    },
    serial: async (_id, operation) => await operation(), dispatch: async () => false,
    cancelObsolete: async () => false,
    admitted: () => true,
    frame: (message, state) => ({ content: teamMessageDeliveryContent(message, state),
      source: { kind: 'team-message', teamId: TeamId(test.lead.id), messageId: message.id,
        senderId: message.senderId, senderName: message.senderName } }),
    ...overrides,
  }
  const mail = new TeamLeadMail(test.ctx, journal, lifecycle, operations, maxPending, maxBytes)
  mail.bind(input)
  return { mail, input, journal, lifecycle, operations }
}

async function queue(test: Harness, message: TeamMessageSnapshot) {
  test.lead.session.append('team/message/queued', { version: 2, teamId: TeamId(test.lead.id), message })
  await test.ctx.sessions.flush(test.lead.session)
}

describe('native Lead mail custody boundaries', () => {
  it('orders ordinary Lead notices and transferred input together, waking only the ready committed recipient', async () => {
    const test = await leadMailHarness([textResponse('ready current recipient')])
    const current = await test.create('ordinary-current', 2)
    const first = notice(test, 'ordinary-first')
    const second = notice(test, 'ordinary-second')
    await queue(test, first)
    const held = material('between notices')
    await test.ctx.agents.receiveInput(test.lead, held)
    const transfers = await test.owner.queueHeld(test.lead)
    await queue(test, second)
    await test.commit(current, 1)
    await test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
    expect(current.agent.inbox.nextStep.map(message => message.id)).toEqual([first.id, held.message.id, second.id])
    expect(test.state().delivered).toEqual([first.id, transfers[0], second.id])
    expect(test.adapter.requests).toHaveLength(0)
    test.readiness.ready = true
    const next = notice(test, 'ordinary-ready')
    await queue(test, next)
    const { mail } = receiver(test)
    expect(await mail.deliver(test.lead, next)).toBe(true)
    await current.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.lead.status).toBe('idle')
    await current.dispose()
    await test.owner.dispose()
  })

  it.each(['false', 'throw'] as const)('keeps one target custody after target flush %s and confirms it before any root receipt', async (failure) => {
    const test = await leadMailHarness()
    const current = await test.create(`target-${failure}`, 2)
    const original = material()
    await test.ctx.agents.receiveInput(test.lead, original)
    await test.owner.queueHeld(test.lead)
    await test.commit(current, 1)
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failing = true
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === current.agent.session && failing) {
        if (failure === 'throw') throw new Error('target checkpoint failed')
        return false
      }
      return flush(session)
    })
    try {
      await expect(test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })).rejects.toThrow()
      expect(test.state().delivered).toEqual([])
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
      failing = false
      await test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
      expect(current.agent.inbox.nextStep).toEqual([original.message])
      expect(test.state().leadDeliveries).toHaveLength(1)
    } finally { checkpoint.mockRestore(); await current.dispose(); await test.owner.dispose() }
  })

  it.each(['false', 'throw'] as const)('reconfirms an already queued capture after anchor flush %s without duplicating it', async (failure) => {
    const test = await leadMailHarness()
    const original = material()
    await test.ctx.agents.receiveInput(test.lead, original)
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failing = true
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === test.lead.session && test.state().messages.length > 0 && failing) {
        if (failure === 'throw') throw new Error('queue checkpoint failed')
        return false
      }
      return flush(session)
    })
    try {
      await expect(test.owner.queueHeld(test.lead)).rejects.toThrow()
      expect(test.state().messages).toHaveLength(1)
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
      failing = false
      const ids = await Promise.all([test.owner.queueHeld(test.lead), test.owner.queueHeld(test.lead)])
      expect(ids[0]).toEqual(ids[1])
      expect(test.state().messages).toHaveLength(1)
    } finally { checkpoint.mockRestore(); await test.owner.dispose() }
  })

  it('retains source custody when transfer capacity or bytes are exhausted and skips cancelled ordinary items', async () => {
    const test = await leadMailHarness()
    const cancelled = notice(test, 'cancelled-normal')
    await queue(test, cancelled)
    test.lead.session.append('team/message/cancelled', { version: 3, teamId: TeamId(test.lead.id),
      targetId: test.lead.id, messageIds: [cancelled.id], reason: 'ordinary coordination cancelled' })
    const pending = notice(test, 'pending-normal')
    await queue(test, pending)
    const original = material()
    await test.ctx.agents.receiveInput(test.lead, original)
    const full = receiver(test, {}, 1)
    await expect(full.mail.queueHeld(test.lead, full.input)).rejects.toMatchObject({ code: 'TEAM_MAILBOX_FULL' })
    const small = receiver(test, {}, 32, 1)
    await expect(small.mail.queueHeld(test.lead, small.input)).rejects.toMatchObject({ code: 'TEAM_MESSAGE_TOO_LARGE' })
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    test.readiness.ready = true
    expect(await full.mail.deliver(test.lead, cancelled, full.input)).toBe(false)
    await test.owner.dispose()
  })

  it('rejects detached anchors, stale preload seats and seat/readiness changes inside the recipient transaction', async () => {
    const test = await leadMailHarness()
    const queued = notice(test, 'changed-recipient')
    await queue(test, queued)
    const { mail, input, operations } = receiver(test)
    await expect(mail.preloadLeadMail(new Proxy(test.lead, {}), { executionId: test.lead.id, term: 1 }, input))
      .rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    await expect(mail.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 9 }, input))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    await expect(mail.deliver(test.lead, queued, input, { executionId: test.lead.id, term: 9 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    operations.resolve = async () => ({ ...test.ctx.agentTeams.leadContext(test.lead),
      seat: { ...test.ctx.agentTeams.leadContext(test.lead).seat, term: 8 } })
    await expect(mail.deliver(test.lead, queued, input)).rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    operations.resolve = async () => test.ctx.agentTeams.leadContext(test.lead)
    operations.context = () => ({ anchor: test.lead, seat: { executionId: test.lead.id, term: 1 }, ready: false })
    expect(await mail.deliver(test.lead, queued, input)).toBe(false)
    await expect(mail.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 }, input))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    operations.canDeliver = () => true
    operations.context = () => ({ ...test.ctx.agentTeams.leadContext(test.lead), ready: false })
    expect(await mail.deliver(test.lead, queued)).toBe(false)
    await expect(mail.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 }, input))
      .resolves.toHaveLength(1)
    await test.owner.dispose()
  })

  it('requires the captured durable material and refuses a conflicting existing queue identity', async () => {
    const test = await leadMailHarness()
    const original = material()
    await test.ctx.agents.receiveInput(test.lead, original)
    const { mail, input, journal } = receiver(test)
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const persistence = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async () => {
        const stored = await read()
        return { ...stored, events: stored.events.filter(event => event.type !== 'agent/input/held') }
      })
      return handle
    })
    await expect(mail.queueHeld(test.lead, input)).rejects.toMatchObject({ code: 'TEAM_INPUT_DURABILITY' })
    persistence.mockRestore()
    const ids = await mail.queueHeld(test.lead, input)
    const state = journal.state(test.lead)
    const snapshot = vi.spyOn(journal, 'state').mockImplementation(() => ({ ...state,
      messages: state.messages.map(message => message.id === ids[0] ? { ...message, senderName: 'conflicting identity' } : message) }))
    await expect(mail.queueHeld(test.lead, input)).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    snapshot.mockRestore()
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    await test.owner.dispose()
  })

  it('uses the unbound controlled admission path and does not invent a receipt for held input', async () => {
    const test = await leadMailHarness([textResponse('fallback admission receiver')])
    const failures: unknown[] = []
    test.ctx.on('agent/error', ({ error }) => { failures.push(error) })
    const queued = notice(test, 'without-preload-owner')
    await queue(test, queued)
    const boundary = receiver(test, { canDeliver: () => true,
      context: () => ({ ...test.ctx.agentTeams.leadContext(test.lead), ready: true }) })
    boundary.mail.bind(undefined)
    expect(await boundary.mail.deliver(test.lead, queued)).toBe(false)
    expect(test.state().leadDeliveries).toBeUndefined()
    test.readiness.ready = true
    const held = test.ctx.agents.inputControlState(test.lead.session).records[0]?.input
    if (held === undefined) throw new Error('receiver did not retain controlled input')
    await test.owner.preload(test.lead, held)
    expect(await boundary.mail.deliver(test.lead, queued)).toBe(true)
    expect(test.state().leadDeliveries).toHaveLength(1)
    await test.lead.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(failures).toEqual([])
    await test.owner.dispose()
  })

  it('does not clear a later capture with an earlier receipt and reports unavailable cleanup ownership', async () => {
    const test = await leadMailHarness()
    const source = await test.create('recapture-source', 2)
    const recipient = await test.create('recapture-recipient', 3)
    await test.commit(source, 1)
    const original = material()
    await test.ctx.agents.receiveInput(source.agent, original)
    const first = await test.owner.queueHeld(source.agent)
    await test.commit(recipient, 2)
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const unavailable = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation((id, access, options) =>
      id === source.agent.id && access === 'read' ? Promise.reject(new Error('source confirmation is temporarily unavailable'))
        : open(id, access, options))
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 3 })).rejects.toThrow()
    unavailable.mockRestore()
    expect(test.state().delivered).toEqual(first)
    const { mail } = receiver(test)
    mail.bind(undefined)
    await expect(mail.cleanupConfirmed(test.lead)).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    // The owned generic restore is non-waking, even for a historical source.
    // Its new capture must not be settled by the old target's receipt.
    await test.owner.preload(source.agent, original)
    const next = await test.owner.queueHeld(source.agent)
    expect(next[0]).not.toBe(first[0])
    const sourceOwner = receiver(test)
    await sourceOwner.mail.cleanupConfirmed(test.lead, sourceOwner.input)
    expect(test.ctx.agents.inputControlState(source.agent.session).records[0]?.location).toBe('held')
    await test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 3 })
    expect(test.ctx.agents.inputControlState(source.agent.session).records[0]?.location).toBe('released')
    expect(recipient.agent.inbox.nextStep).toEqual([original.message])
    expect(test.adapter.requests).toHaveLength(0)
    await recipient.dispose()
    await source.dispose()
    await test.owner.dispose()
  })

  it.each(['false', 'throw'] as const)('refuses a frozen ordinary Lead queue acknowledgement after root flush %s', async (failure) => {
    const test = await leadMailHarness(['hang'])
    test.readiness.ready = true
    const unavailable = async (): Promise<never> => { throw new Error('Task mutation is outside this mail test') }
    const writer = test.ctx.agentTeams.installTaskExtension({ id: 'facade-writer', validateMemberGroup: () => {},
      assessSettlementNotice: () => 'suppress', create: unavailable, update: unavailable })
    const member = await test.ctx.agentTeams.spawnTeammate(test.lead, { name: 'queue-sender', description: 'queue sender',
      presetId: 'reviewer', provider: 'spawn', context: 'fresh', prompt: [], signal: new AbortController().signal })
    await test.ctx.agentTeams.sendMessage(test.lead, { target: member.member.name,
      content: [{ type: 'text', text: 'begin sender turn' }], signal: new AbortController().signal })
    const sender = test.ctx.agents.get(member.member.id)
    if (sender === undefined) throw new Error('member sender must be executing')
    test.readiness.ready = false
    const flush = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (session === test.lead.session && test.state().messages.some(message => message.targetId === test.lead.id)) {
        if (failure === 'throw') throw new Error('ordinary Lead queue checkpoint failed')
        return false
      }
      return flush(session)
    })
    try {
      await expect(test.ctx.agentTeams.sendMessage(sender, { target: 'lead', content: [{ type: 'text', text: 'ordinary custody' }],
        signal: new AbortController().signal })).rejects.toThrow()
      const message = test.state().messages.find(item => item.targetId === test.lead.id)
      expect(message).toBeDefined()
      expect(test.lead.inbox.nextStep).toEqual([])
      expect(test.state().delivered).not.toContain(message?.id)
      checkpoint.mockRestore()
      await test.owner.preloadLeadMail(test.lead, { executionId: test.lead.id, term: 1 })
      expect(test.lead.inbox.nextStep).toHaveLength(1)
      expect(test.adapter.requests).toHaveLength(1)
    } finally { checkpoint.mockRestore(); writer.dispose(); await test.owner.dispose() }
  })
})
