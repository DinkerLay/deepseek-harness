import type { Agent, AgentInput } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { TeamId } from '../src/index.ts'
import { facadeControlledMode } from './native-facade-harness.ts'
import { leadMailHarness } from './lead-mail-harness.ts'

function input(text: string): AgentInput {
  return { message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    target: 'next-turn', wakeup: true }
}

describe('native Lead mail recovery edges', () => {
  it('recaptures an edited cancelled input from JSONL without reusing its old material or receipt', async () => {
    const first = await leadMailHarness()
    const original = input('cancelled preparation body')
    await first.ctx.agents.receiveInput(first.lead, original)
    const oldIds = await first.owner.queueHeld(first.lead)
    await first.owner.preloadLeadMail(first.lead, { executionId: first.lead.id, term: 1 })
    expect(first.lead.inbox.nextTurn).toEqual([original.message])

    first.readiness.ready = true
    await first.ctx.agents.mutateInput(first.lead, { kind: 'replace', messageId: original.message.id,
      content: [{ type: 'text', text: 'latest user-authorized body' }] })
    first.readiness.ready = false
    const edited = { ...original, message: { ...original.message,
      content: [{ type: 'text' as const, text: 'latest user-authorized body' }] } }
    const newIds = await first.owner.queueHeld(first.lead)
    expect(newIds).toHaveLength(1)
    expect(newIds[0]).not.toBe(oldIds[0])
    expect(first.state().messages.map(message => message.transfer?.input)).toEqual([original, edited])
    const captures = first.state().messages.map(message => message.transfer?.heldSeq)
    expect(captures[1]).not.toBe(captures[0])
    expect(first.state().delivered).toEqual(oldIds)
    expect(first.adapter.requests).toHaveLength(0)
    await first.ctx.fiber.dispose()

    const restored = await leadMailHarness([], { resources: first.resources, resume: true })
    try {
      expect(restored.ctx.agents.inputControlState(restored.lead.session).records[0])
        .toMatchObject({ location: 'held', input: edited })
      expect(await restored.owner.queueHeld(restored.lead)).toEqual(newIds)
      expect(restored.state().delivered).toEqual(oldIds)
      expect(restored.lead.inbox.nextTurn).toEqual([])
      await restored.owner.preloadLeadMail(restored.lead, { executionId: restored.lead.id, term: 1 })
      expect(restored.lead.inbox.nextTurn).toEqual([edited.message])
      expect(restored.state().delivered).toEqual([...oldIds, ...newIds])
      expect(restored.state().leadDeliveries).toHaveLength(2)
      expect(restored.lead.session.snapshotEvents().filter(event => event.type === 'agent/input/released')).toEqual([])
      expect(restored.ctx.agents.inputControlState(restored.lead.session).records[0])
        .toMatchObject({ location: 'inbox', input: edited })
      expect(restored.adapter.requests).toHaveLength(0)
    } finally { await restored.owner.dispose() }
  })

  it('rejects a resolver returning the live anchor instead of the marked recipient and retains source custody', async () => {
    const test = await leadMailHarness()
    const entered = Promise.withResolvers<undefined>()
    const resolved = Promise.withResolvers<Agent>()
    await test.replaceProvider({ resolveExecution: async () => {
      entered.resolve(undefined)
      return await resolved.promise
    } })
    const original = input('wrong recipient must not consume this input')
    await test.ctx.agents.receiveInput(test.lead, original)
    const ids = await test.owner.queueHeld(test.lead)
    const recipient = await test.create('edge-wrong-recipient', 2)
    await test.commit(recipient, 1)
    await recipient.dispose()
    const waiting = test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 2 })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    await entered.promise
    resolved.resolve(test.lead)
    await rejected
    expect(test.lead.session.header.parentSession).toBeUndefined()
    expect(test.state().messages.map(message => message.id)).toEqual(ids)
    expect(test.state().delivered).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0])
      .toMatchObject({ location: 'held', input: original })
    expect(test.lead.inbox.nextTurn).toEqual([])
    expect(test.ctx.agents.get(recipient.agent.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    await test.owner.dispose()
  })

  it.each(['preset', 'revision'] as const)('refuses historical cleanup when its Host binding has a different %s', async (change) => {
    const test = await leadMailHarness()
    const source = await test.create(`edge-history-${change}`, 2)
    const recipient = await test.create(`edge-history-current-${change}`, 3)
    const actual = test.ctx.sessionProjections.stateOf(source.agent.session, 'teamLeadExecutionRecord')?.identity
    if (actual === undefined || actual === null) throw new Error('ordinary source requires its durable marker')
    // The resolver boundary must reject even a schema-valid Host record that
    // names the right id and term but binds another composition declaration.
    test.lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(test.lead.id), previousTerm: 1,
      binding: { executionId: source.agent.id, term: 2,
        presetId: change === 'preset' ? 'standard' : actual.presetId,
        revision: change === 'revision' ? 'a'.repeat(64) : actual.revision },
      extension: { id: facadeControlledMode.requiredTaskExtensionId, dataJson: '{}' }, releases: [] })
    await test.ctx.sessions.flush(test.lead.session)
    const original = input('invalid historical binding retains this source')
    await test.ctx.agents.receiveInput(source.agent, original)
    const ids = await test.owner.queueHeld(source.agent)
    await test.commit(recipient, 2)
    await source.dispose()
    try {
      await expect(test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 3 }))
        .rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
      const restored = test.ctx.agents.get(source.agent.id)
      if (restored === undefined) throw new Error('historical resolver did not restore the real source')
      expect(restored).not.toBe(source.agent)
      expect(restored.session.header).toMatchObject({ parentSession: test.lead.id, agentPreset: actual.presetId })
      expect(test.ctx.agents.inputControlState(restored.session).records[0])
        .toMatchObject({ location: 'held', input: original })
      expect(test.state().messages.map(message => message.id)).toEqual(ids)
      expect(test.state().leadDeliveries).toHaveLength(1)
      expect(recipient.agent.inbox.nextTurn).toEqual([original.message])
      expect(test.ctx.agents.canStartInput(restored)).toBe(false)
      expect(test.ctx.agents.canClaimInput(restored)).toBe(false)
      expect(test.adapter.requests).toHaveLength(0)
    } finally { await recipient.dispose(); await test.owner.dispose() }
  })

  it('rejects a prepared recipient after the seat changes across its resolver barrier without a late wake', async () => {
    const test = await leadMailHarness()
    const activate = test.provider.resolveExecution?.bind(test.provider)
    if (activate === undefined) throw new Error('fixture requires its real cold activation provider')
    const entered = Promise.withResolvers<Agent>()
    const finish = Promise.withResolvers<undefined>()
    await test.replaceProvider({ resolveExecution: async (id, cancel) => {
      const agent = await activate(id, cancel)
      entered.resolve(agent)
      await finish.promise
      return agent
    } })
    const original = input('seat race must retain this source')
    await test.ctx.agents.receiveInput(test.lead, original)
    const ids = await test.owner.queueHeld(test.lead)
    const second = await test.create('edge-seat-second', 2)
    const third = await test.create('edge-seat-third', 3)
    await test.commit(second, 1)
    await second.dispose()
    const waiting = test.owner.preloadLeadMail(test.lead, { executionId: second.agent.id, term: 2 })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'TEAM_LEAD_STALE_TERM' })
    const prepared = await entered.promise
    const wake = vi.spyOn(prepared, 'wakePending')
    try {
      await test.commit(third, 2)
      finish.resolve(undefined)
      await rejected
      expect(test.state().messages.map(message => message.id)).toEqual(ids)
      expect(test.state().delivered).toEqual([])
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0])
        .toMatchObject({ location: 'held', input: original })
      expect(prepared.inbox.nextTurn).toEqual([])
      expect(third.agent.inbox.nextTurn).toEqual([])
      expect(test.ctx.agents.canStartInput(prepared)).toBe(false)
      expect(wake).not.toHaveBeenCalled()
      expect(test.adapter.requests).toHaveLength(0)
    } finally { finish.resolve(undefined); wake.mockRestore(); await third.dispose(); await test.owner.dispose() }
  })

  it('closes an unresolved recipient before releasing its external barrier and ignores the late real activation', async () => {
    const test = await leadMailHarness()
    const activate = test.provider.resolveExecution?.bind(test.provider)
    if (activate === undefined) throw new Error('fixture requires its real cold activation provider')
    const entered = Promise.withResolvers<AbortSignal>()
    const finish = Promise.withResolvers<undefined>()
    const late = Promise.withResolvers<unknown>()
    await test.replaceProvider({ resolveExecution: async (id, cancel) => {
      if (cancel === undefined) throw new Error('native resolution requires its registration signal')
      entered.resolve(cancel)
      await finish.promise
      try { return await activate(id, cancel) } catch (error: unknown) { late.resolve(error); throw error }
    } })
    const original = input('closing resolver retains this source')
    await test.ctx.agents.receiveInput(test.lead, original)
    const ids = await test.owner.queueHeld(test.lead)
    const recipient = await test.create('edge-closing-recipient', 2)
    await test.commit(recipient, 1)
    await recipient.dispose()
    const waiting = test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 2 })
    const rejected = expect(waiting).rejects.toMatchObject({ code: 'TEAM_LEAD_PROVIDER_CLOSED' })
    const cancel = await entered.promise
    await test.owner.dispose()
    await rejected
    expect(cancel.aborted).toBe(true)
    expect(test.ctx.agents.get(recipient.agent.id)).toBeUndefined()
    finish.resolve(undefined)
    expect(await late.promise).toBeDefined()
    expect(test.ctx.agents.get(recipient.agent.id)).toBeUndefined()
    expect(test.state().messages.map(message => message.id)).toEqual(ids)
    expect(test.state().delivered).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0])
      .toMatchObject({ location: 'held', input: original })
    expect(test.lead.inbox.nextTurn).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  })
})
