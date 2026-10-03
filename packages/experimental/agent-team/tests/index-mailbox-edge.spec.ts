import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { TeamId, TeamMessageId, type TeamMessageSnapshot } from '../src/index.ts'
import { nativeHarness, nativeInternals, nativeState } from './native-lifecycle-harness.ts'

describe('native recovery without Lead input ownership', () => {
  it('keeps another controller custody and reuses its exact peer input without taking over Lead routing', async () => {
    const test = await nativeHarness({ controlled: false })
    test.policy.admission = 'hold'
    const other = createUserMessage({ content: [{ type: 'text', text: 'unrelated plugin context' }],
      source: { kind: 'runtime-context' } })
    await test.ctx.agents.receiveInput(test.lead, { message: other, target: 'next-step', wakeup: false })
    const differentPeer = createUserMessage({ content: [{ type: 'text', text: 'a different identified peer item' }],
      source: { kind: 'team-message', teamId: TeamId(test.lead.id), messageId: TeamMessageId('different-peer'),
        senderId: test.lead.id, senderName: 'lead' } })
    await test.ctx.agents.receiveInput(test.lead, { message: differentPeer, target: 'next-step', wakeup: false })
    const message: TeamMessageSnapshot = { id: TeamMessageId('generic-controller-peer'), senderId: test.lead.id,
      senderName: 'lead', targetId: test.lead.id, content: [{ type: 'text', text: 'extension-owned peer reminder' }] }
    await test.queue(message)
    const mailbox = nativeInternals(test.ctx).mailbox
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(false)
    const receipts = test.ctx.agents.inputControlState(test.lead.session).records
    const original = receipts.find(record => record.input.message.source.kind === 'team-message'
      && record.input.message.source.messageId === message.id)
    if (original === undefined) throw new Error('identified peer input was not retained')
    expect(receipts).toHaveLength(3)
    expect(original.location).toBe('held')
    expect(test.lead.inbox.nextStep).toEqual([])
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([])
    await test.controller.preload(test.lead, original.input)
    expect(await mailbox.tryDispatch(test.lead, message, test.signal)).toBe(true)
    expect(test.lead.inbox.nextStep).toEqual([original.input.message])
    expect(nativeState(test.ctx, test.lead).delivered).toEqual([message.id])
    expect(nativeState(test.ctx, test.lead).leadDeliveries).toBeUndefined()
    expect(test.adapter.requests).toEqual([])
    using stored = await test.ctx.sessionQuery.observeSession(test.lead.id, { projectionMode: 'none' })
    expect(stored.events.filter(event => event.type === 'team/message/delivered')).toHaveLength(1)
    expect(stored.events.filter(event => event.type === 'team/message/lead-delivered')).toEqual([])
    expect(stored.events.filter(event => event.type === 'agent/input/held')).toHaveLength(3)
  })

  it('observes a registered Session extension without scheduling an absent Agent', async () => {
    const test = await nativeHarness({ controlled: false })
    const session = test.ctx.sessions.create(SessionId('session-without-agent'))
    expect(test.ctx.sessions.get(session.id)).toBe(session)
    expect(test.ctx.agents.get(session.id)).toBeUndefined()
    test.controller.bind(session)
    session.append('team/extension', { version: 1, teamId: TeamId(session.id),
      extension: { id: 'lifecycle-writer', recordId: 'setup-only', dataJson: '{}' } })
    expect(test.ctx.sessionProjections.stateOf(session, 'agentTeam')?.extensionRecords).toEqual([
      { writerId: 'lifecycle-writer', recordId: 'setup-only', dataJson: '{}' },
    ])
    expect(test.ctx.agents.get(session.id)).toBeUndefined()
    expect(test.adapter.requests).toEqual([])
  })
})
