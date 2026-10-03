import { InputControllerId } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { TeamId } from '../src/index.ts'
import { facadeControlledMode } from './native-facade-harness.ts'
import { leadMailHarness } from './lead-mail-harness.ts'

function original() {
  return { message: createUserMessage({ content: [{ type: 'text' as const, text: 'cold native custody' }], source: { kind: 'user' } }),
    target: 'next-step' as const, wakeup: false }
}

describe('owned Lead mail activation', () => {
  it('cold-preloads the exact current recipient while the readonly context stays non-activating', async () => {
    const test = await leadMailHarness()
    const held = original()
    await test.ctx.agents.receiveInput(test.lead, held)
    await test.owner.queueHeld(test.lead)
    const current = await test.create('cold-exact-current', 2)
    await test.commit(current, 1)
    await current.dispose()
    const resolve = test.provider.resolveExecution?.bind(test.provider)
    if (resolve === undefined) throw new Error('fixture requires an owned resolver')
    const calls = vi.fn(resolve)
    await test.replaceProvider({ resolveExecution: calls })
    expect(test.ctx.agentTeams.leadContext(test.lead).execution).toBeUndefined()
    expect(calls).not.toHaveBeenCalled()
    await test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 })
    const recipient = test.ctx.agents.get(current.agent.id)
    expect(recipient?.inbox.nextStep).toEqual([held.message])
    expect(test.ctx.agentTeams.leadContext(test.lead).ready).toBe(false)
    expect(calls).toHaveBeenCalledTimes(1)
    expect(test.adapter.requests).toHaveLength(0)
    await test.owner.dispose()
  })

  it('retains a cold current queue if no execution resolver is registered', async () => {
    const test = await leadMailHarness()
    await test.ctx.agents.receiveInput(test.lead, original())
    await test.owner.queueHeld(test.lead)
    const current = await test.create('cold-missing-resolver', 2)
    await test.commit(current, 1)
    await current.dispose()
    await test.replaceProvider({}, true)
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    expect(test.state().delivered).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    await test.owner.dispose()
  })

  it('requires the exact live object returned by cold activation, not a wrapper with the same id', async () => {
    const test = await leadMailHarness()
    await test.ctx.agents.receiveInput(test.lead, original())
    await test.owner.queueHeld(test.lead)
    const current = await test.create('cold-wrapped-current', 2)
    await test.commit(current, 1)
    await current.dispose()
    const resolve = test.provider.resolveExecution?.bind(test.provider)
    if (resolve === undefined) throw new Error('fixture requires an owned resolver')
    await test.replaceProvider({ resolveExecution: async (id, signal) => new Proxy(await resolve(id, signal), {}) })
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    expect(test.ctx.agents.get(current.agent.id)?.inbox.nextStep).toEqual([])
    expect(test.state().delivered).toEqual([])
    await test.owner.dispose()
  })

  it('refuses a live candidate whose complete marker does not match the committed Host seat', async () => {
    const test = await leadMailHarness()
    const current = await test.create('mismatched-current-marker', 2)
    test.lead.session.append('team/lead/transaction', { version: 1, teamId: TeamId(test.lead.id), previousTerm: 1,
      binding: { executionId: current.agent.id, term: 2, presetId: 'reviewer', revision: 'a'.repeat(64) },
      extension: { id: facadeControlledMode.requiredTaskExtensionId, dataJson: '{}' }, releases: [] })
    await test.ctx.sessions.flush(test.lead.session)
    await test.ctx.agents.receiveInput(test.lead, original())
    await test.owner.queueHeld(test.lead)
    expect(test.ctx.agentTeams.leadContext(test.lead).execution).toBeUndefined()
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: current.agent.id, term: 2 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_IDENTITY_INVALID' })
    expect(current.agent.inbox.nextStep).toEqual([])
    expect(test.state().delivered).toEqual([])
    await current.dispose()
    await test.owner.dispose()
  })

  it('retains receipt-confirmed offline source custody with an explicit missing-cleanup-resolver diagnostic', async () => {
    const test = await leadMailHarness()
    const source = await test.create('missing-cleanup-source', 2)
    const recipient = await test.create('missing-cleanup-recipient', 3)
    await test.commit(source, 1)
    await test.ctx.agents.receiveInput(source.agent, original())
    await test.owner.queueHeld(source.agent)
    await test.commit(recipient, 2)
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const stopped = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation((id, access, options) =>
      id === source.agent.id && access === 'read' ? Promise.reject(new Error('source cleanup interrupted')) : open(id, access, options))
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 3 })).rejects.toThrow()
    expect(test.state().leadDeliveries).toHaveLength(1)
    await source.dispose()
    stopped.mockRestore()
    await test.replaceProvider({}, true)
    await expect(test.owner.preloadLeadMail(test.lead, { executionId: recipient.agent.id, term: 3 }))
      .rejects.toMatchObject({ code: 'TEAM_LEAD_ANCHOR_INVALID' })
    expect(test.ctx.agents.get(source.agent.id)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    await recipient.dispose()
    await test.owner.dispose()
  })

  it('does not treat candidate-held material or an unloaded held event as a legitimate historical sender', async () => {
    const test = await leadMailHarness()
    const candidate = await test.create('uncommitted-material-source', 2)
    await test.owner.preload(candidate.agent, original())
    await expect(test.owner.queueHeld(candidate.agent)).rejects.toMatchObject({ code: 'TEAM_NOT_MEMBER' })
    expect(candidate.agent.inbox.nextStep).toHaveLength(1)
    expect(test.ctx.agentTeams.isLeadAuthor(test.lead, SessionId('not-a-seat'), 1)).toBe(false)
    const unloaded = test.ctx.sessions.create(SessionId('unloaded-source-fact'))
    const controllerId = InputControllerId('native-team-lead')
    unloaded.append('agent/input/controller-bound', { version: 1, controllerId })
    unloaded.append('agent/input/held', { version: 1, controllerId, input: original() })
    expect(test.state().messages).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
    await candidate.dispose()
    await test.owner.dispose()
  })

  it('closes a capture awaiting an uncooperative persisted read without waiting for external barrier release', async () => {
    const test = await leadMailHarness()
    const held = original()
    await test.ctx.agents.receiveInput(test.lead, held)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    const reader = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (args[0] === test.lead.id && args[1] === 'read') {
        const read = handle.read.bind(handle)
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
          const stored = await read(...readArgs)
          entered.resolve(undefined)
          await release.promise
          return stored
        })
      }
      return handle
    })
    const capture = test.owner.queueHeld(test.lead).then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    let closed = false
    const disposal = test.owner.dispose().then(() => { closed = true })
    try {
      await vi.waitFor(() => { expect(closed).toBe(true) })
      expect(await capture).toHaveProperty('error')
      expect(test.state().messages).toEqual([])
      expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    } finally { release.resolve(undefined); reader.mockRestore(); await disposal }
    await Promise.resolve()
    expect(test.state().messages).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('cancels a queued native capture behind a Host transaction and cannot append after registration closes', async () => {
    const test = await leadMailHarness()
    test.readiness.ready = true
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const lock = test.ctx.agentTeams.readCompositionLocked(test.lead, async () => {
      entered.resolve(undefined)
      await release.promise
    })
    await entered.promise
    test.readiness.ready = false
    await test.ctx.agents.receiveInput(test.lead, original())
    const capture = test.owner.queueHeld(test.lead).then(value => ({ value }), (error: unknown) => ({ error }))
    let closed = false
    const disposal = test.owner.dispose().then(() => { closed = true })
    try {
      await vi.waitFor(() => { expect(closed).toBe(true) })
      expect(await capture).toHaveProperty('error')
    } finally { release.resolve(undefined); await lock; await disposal }
    expect(test.state().messages).toEqual([])
    expect(test.ctx.agents.inputControlState(test.lead.session).records[0]?.location).toBe('held')
    expect(test.adapter.requests).toHaveLength(0)
  })
})
