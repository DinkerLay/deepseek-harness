import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentInput, AgentInputController, InputControllerHandle } from '@deepseek-ai/dsh-agent'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'
import { ReactLoopAgent } from '../src/agent.ts'

const id = InputControllerId('test-input-policy')
interface PolicyState { admission: 'accept' | 'hold' | 'reject'; start: boolean; claim: boolean }
interface Resources { root: string; contexts: Context[] }

function input(text: string, wakeup = false): AgentInput {
  return { message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    target: 'next-step', wakeup }
}

async function boot(options: {
  resources?: Resources
  resume?: boolean
  storage?: boolean
  script?: ConstructorParameters<typeof MockAdapter>[0]
  prepare?: AgentInputController['prepare']
  prepareClaim?: AgentInputController['prepareClaim']
} = {}) {
  const resources = options.resources ?? { root: mkdtempSync(join(tmpdir(), 'dsh-input-control-')), contexts: [] }
  if (options.resources === undefined) onTestFinished(async () => {
    for (const ctx of resources.contexts.toReversed()) await ctx.fiber.dispose()
    rmSync(resources.root, { recursive: true, force: true })
  })
  const ctx = new Context()
  resources.contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (options.storage !== false) await ctx.plugin(JsonlSessionPersistence, { root: resources.root })
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(options.script ?? [textResponse('done'), textResponse('done again')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const policy: PolicyState = { admission: 'accept', start: true, claim: true }
  let capability: InputControllerHandle | undefined
  const owner = await ctx.plugin(Object.assign(function policyFixture(ownerCtx: Context) {
    capability = ownerCtx.agents.registerInputController(id, {
      admit: () => policy.admission === 'reject' ? { kind: 'reject', reason: 'test receipt denied' }
        : { kind: policy.admission },
      canStart: () => policy.start,
      canClaim: () => policy.claim,
      ...options.prepare === undefined ? {} : { prepare: options.prepare },
      ...options.prepareClaim === undefined ? {} : { prepareClaim: options.prepareClaim },
    })
  }, { inject: ['agents'] }))
  if (capability === undefined) throw new Error('input policy fixture did not initialize')
  const cap = capability
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === 'input-agent') events.push(event) })
  const handle = options.resume
    ? await ctx.agents.resume({ resumeSessionId: SessionId('input-agent'), agentOptions: { provider: 'mock', model: 'mock' } })
    : await ctx.agents.create({ sessionId: SessionId('input-agent'), agentOptions: { provider: 'mock', model: 'mock' } })
  return { ctx, agent: handle.agent, handle, cap, policy, owner, adapter, events, resources, loopFiber }
}

function splices(events: readonly SessionEvent[], request: AgentInput): number {
  return events.filter(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === request.message.id)).length
}

describe('optional input control', () => {
  it('selects only exact pending identities and preserves the other queue and original wake intent', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const first = input('selected work'), other = { ...input('shared execution'), target: 'next-turn' as const }
    await test.ctx.agents.receiveInput(test.agent, first)
    await test.ctx.agents.receiveInput(test.agent, other)
    expect(await test.cap.holdPending(test.agent, [first.message.id])).toEqual([first])
    expect(test.agent.inbox.nextStep).toEqual([])
    expect(test.agent.inbox.nextTurn).toEqual([other.message])
    expect(await test.cap.holdPending(test.agent, [])).toEqual([])
    expect(await test.cap.holdPending(test.agent, [first.message.id])).toEqual([first])
    await test.cap.release(test.agent, first.message.id)
    await expect(test.cap.holdPending(test.agent, [first.message.id])).rejects.toThrow(/not pending or held/)
    await expect(test.cap.preload(test.agent, first)).rejects.toThrow(/released input cannot be preloaded/)
    expect(test.agent.inbox.nextStep).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('awaits only the bound optional claim preparation before the actual model batch', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const prepare = vi.fn(async (_agent: Agent, signal: AbortSignal) => {
      entered.resolve(undefined); await release.promise; signal.throwIfAborted()
    })
    const test = await boot({ prepareClaim: prepare })
    expect(test.ctx.agents.prepareInputClaim(test.agent, new AbortController().signal)).toBeUndefined()
    test.cap.bind(test.agent.session)
    await test.ctx.agents.receiveInput(test.agent, input('held before claim', true))
    await entered.promise
    expect(test.adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    await test.agent.whenIdle()
    expect(prepare).toHaveBeenCalledOnce()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('aborts claim preparation on controller disposal and drains a callback which finishes late', async () => {
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let ownedSignal: AbortSignal | undefined
    const test = await boot({ prepareClaim: async (_agent, signal) => {
      ownedSignal = signal; entered.resolve(undefined); await release.promise
    } })
    test.cap.bind(test.agent.session)
    await test.ctx.agents.receiveInput(test.agent, input('must not reach model', true))
    await entered.promise
    let disposed = false
    const closing = test.cap.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(ownedSignal?.aborted).toBe(true) })
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await closing
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(1)
  })
  it.each(['false', 'throw'] as const)('reconfirms a removed input after flush %s without clearing another uncertain receipt', async (failure) => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const removed = input('removed once')
    const other = input('unrelated uncertain receipt')
    await test.ctx.agents.receiveInput(test.agent, removed)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('remove checkpoint unavailable')
      return false
    })
    try {
      await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: removed.message.id }))
        .rejects.toThrow()
      expect(test.agent.inbox.nextStep).toEqual([])
      flush.mockResolvedValueOnce(false)
      await expect(test.ctx.agents.receiveInput(test.agent, other)).rejects.toThrow(/not confirmed/)
      await test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: removed.message.id })
      expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
      expect(test.agent.inbox.nextStep).toEqual([other.message])
      expect(splices(test.events, removed)).toBe(1)
      await test.ctx.agents.receiveInput(test.agent, other)
      expect(test.ctx.agents.canStartInput(test.agent)).toBe(true)
      await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: removed.message.id }))
        .rejects.toThrow(/no longer pending/)
      expect(test.adapter.requests).toHaveLength(0)
    } finally { flush.mockRestore() }
  })

  it('cancels configured preparation on factory-provider unload before the preparation barrier is released', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const id = SessionId('configured-unload')
    const cap = test.ctx.agents.registerInputController(InputControllerId('configured-unload-policy'), {
      admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
      initialize: (session) => {
        if (session.id !== id) return
        cap.bind(session)
        entered.resolve(undefined)
        return release.promise
      },
    })
    const creating = test.ctx.agentLoop.create(id, { provider: 'mock', model: 'mock' })
      .then(agent => ({ agent }), (error: unknown) => ({ error }))
    let disposal: Promise<void> | undefined
    let disposed = false
    try {
      await entered.promise
      disposal = test.loopFiber.dispose().then(() => { disposed = true })
      await vi.waitFor(() => { expect(disposed).toBe(true) })
      expect(await creating).toHaveProperty('error')
      expect(test.ctx.agents.get(id)).toBeUndefined()
      expect(test.ctx.sessions.get(id)).toBeUndefined()
      expect(test.adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await Promise.all([creating, disposal])
      await cap.dispose()
    }
  })

  it('keeps every unbound registry delivery synchronous and wakes only on request', async () => {
    const test = await boot()
    const material = input('registry context')
    const queued = { ...input('registry queue'), target: 'next-turn' as const }
    expect(test.ctx.agents.sendInput(test.agent, material)).toBeUndefined()
    expect(test.ctx.agents.sendInput(test.agent, queued)).toBeUndefined()
    test.agent.wakePending?.()
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.ctx.agents.sendInput(test.agent, input('registry steering', true))).toBeUndefined()
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(2)
    test.agent.wakePending?.()
    expect(test.agent.status).toBe('idle')
  })

  it('contains a failed controlled notice and leaves its durable input unstarted', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.admission = 'hold'
    const held = input('held registry receipt')
    expect(await test.ctx.agents.sendInput(test.agent, held)).toMatchObject({ location: 'held' })
    test.policy.admission = 'reject'
    const warning = vi.spyOn(test.ctx.logger, 'warn')
    test.ctx.agents.sendInputNotice(test.agent, input('notice denied', true))
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith(expect.stringContaining('test receipt denied')) })
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(1)
    warning.mockRestore()
  })

  it('preserves unbound notice delivery and synchronous receiver failures', async () => {
    const test = await boot()
    test.ctx.agents.sendInputNotice(test.agent, input('unbound notice'))
    expect(test.agent.inbox.nextStep).toHaveLength(1)
    const inject = vi.spyOn(test.agent, 'inject').mockImplementationOnce(() => { throw new Error('receiver closed') })
    expect(() => { test.ctx.agents.sendInputNotice(test.agent, input('rejected notice')) }).toThrow('receiver closed')
    inject.mockRestore()
  })

  it('rechecks admission after reserving the driver before opening a turn', async () => {
    const test = await boot()
    const admission = vi.spyOn(test.ctx.agents, 'canStartInput').mockReturnValueOnce(true).mockReturnValue(false)
    test.agent.followup(input('closed before turn').message)
    await test.agent.whenIdle()
    expect(test.events.some(event => event.type === 'turn/start')).toBe(false)
    expect(test.agent.inbox.nextTurn).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
    admission.mockRestore()
  })

  it('prepares configured startup input before publishing its Agent', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const cap = test.ctx.agents.registerInputController(InputControllerId('configured-preparation'), {
      admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
      initialize: async (session) => {
        if (session.id !== 'configured-input') return
        entered.resolve(undefined)
        await release.promise
        cap.bind(session)
      },
    })
    const creating = test.ctx.agentLoop.create(SessionId('configured-input'), { provider: 'mock', model: 'mock' })
    try {
      await entered.promise
      expect(test.ctx.agents.get(SessionId('configured-input'))).toBeUndefined()
      release.resolve(undefined)
      const agent = await creating
      expect(test.ctx.agents.isInputControlled(agent.session)).toBe(true)
      expect(test.adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await creating
      await cap.dispose()
    }
  })

  it('captures internal prepend, append and replacement facts as non-waking input without guessing old intent', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const first = input('workspace instructions')
    const last = input('additional facts')
    test.agent.inbox.prepend('next-step', first.message)
    test.agent.inbox.append('next-step', last.message)
    const replacement = input('updated workspace instructions')
    expect(test.agent.inbox.replace(first.message.id, replacement.message)).toBe(true)
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(0)
    test.policy.start = false
    test.policy.claim = false
    expect(await test.cap.holdPending(test.agent)).toEqual([replacement, last])
    expect(test.agent.inbox.nextStep).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('retains captured queue order before newly held arrivals across failed flush, retry and cold recovery', async () => {
    const first = await boot()
    first.cap.bind(first.agent.session)
    const tail = input('original tail')
    const head = input('prepended original head')
    first.agent.inbox.append('next-step', tail.message)
    first.agent.inbox.prepend('next-step', head.message)
    first.policy.admission = 'hold'
    first.policy.start = false
    first.policy.claim = false
    const later = input('arrived during freeze', true)
    expect(await first.ctx.agents.receiveInput(first.agent, later)).toMatchObject({ location: 'held' })
    const flush = vi.spyOn(first.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(first.cap.holdPending(first.agent)).rejects.toThrow(/durability/)
    flush.mockRestore()
    expect(await first.cap.holdPending(first.agent)).toEqual([head, tail, later])
    await first.handle.dispose()
    const second = await boot({ resources: first.resources, resume: true, script: [] })
    second.policy.start = false
    second.policy.claim = false
    expect(await second.cap.holdPending(second.agent)).toEqual([head, tail, later])
    expect(second.adapter.requests).toHaveLength(0)
  })

  it('leaves unbound synchronous input, transcript and wake timing unchanged', async () => {
    const test = await boot()
    const request = input('ordinary', true)
    const flush = vi.spyOn(test.ctx.sessions, 'flush')
    test.agent.send(request.message, request.target, request.wakeup)
    expect(test.agent.status).toBe('running')
    expect(test.events[0]).toMatchObject({ type: 'agent/inbox/spliced', data: { target: 'next-step' } })
    if (test.events[0]?.type === 'agent/inbox/spliced') expect(test.events[0].data.wakeup).toBeUndefined()
    expect(flush).not.toHaveBeenCalled()
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.events.some(event => event.type.startsWith('agent/input/'))).toBe(false)
    flush.mockRestore()
  })

  it('records non-waking intent, then wakes only after durable receipt', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const material = input('reference only')
    const first = await test.ctx.agents.receiveInput(test.agent, material)
    expect(first).toEqual({ messageId: material.message.id, location: 'inbox' })
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.inputControlState(test.agent.session).records[0]?.input).toEqual(material)
    expect(() => { test.agent.steer(input('old synchronous path').message) }).toThrow(/durable receipt/)
    await test.ctx.agents.receiveInput(test.agent, input('act now', true))
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect([...test.agent.inbox.nextStep, ...test.agent.inbox.nextTurn]).toHaveLength(0)
  })

  it('blocks a new turn and direct claim without consuming pending inputs', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.start = false
    test.policy.claim = false
    const request = input('wait until ready', true)
    await test.ctx.agents.receiveInput(test.agent, request)
    test.agent.wakePending?.()
    expect(test.agent.status).toBe('idle')
    expect(test.events.some(event => event.type === 'turn/start')).toBe(false)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
    expect(test.adapter.requests).toHaveLength(0)
    test.policy.start = true
    test.policy.claim = true
    test.agent.wakePending?.()
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('retains held inputs outside the executable inbox and releases each once', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.admission = 'hold'
    const request = input('transfer later', true)
    expect(await test.ctx.agents.receiveInput(test.agent, request)).toMatchObject({ location: 'held' })
    expect([...test.agent.inbox.nextStep, ...test.agent.inbox.nextTurn]).toHaveLength(0)
    expect(test.adapter.requests).toHaveLength(0)
    expect(await test.ctx.agents.receiveInput(test.agent, request)).toMatchObject({ location: 'held' })
    expect(test.events.filter(event => event.type === 'agent/input/held')).toHaveLength(1)
    await test.cap.release(test.agent, request.message.id)
    await test.cap.release(test.agent, request.message.id)
    expect(test.events.filter(event => event.type === 'agent/input/released')).toHaveLength(1)
    expect(await test.ctx.agents.receiveInput(test.agent, request)).toMatchObject({ location: 'released' })
    expect([...test.agent.inbox.nextStep, ...test.agent.inbox.nextTurn]).toHaveLength(0)
  })

  it('rejects claim before mutation even when a new turn was permitted', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.claim = false
    const request = input('not claimable', true)
    await test.ctx.agents.receiveInput(test.agent, request)
    await test.agent.whenIdle()
    expect(test.agent.inbox.nextStep).toEqual([request.message])
    expect(test.adapter.requests).toHaveLength(0)
    const concrete = test.agent
    if (!(concrete instanceof ReactLoopAgent)) throw new Error('fixture must use the concrete driver')
    expect(() => concrete.inbox.claim('next-turn', 2)).toThrow(/before consumption/)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
  })

  it('rechecks a release whose prior flush failed instead of returning success from memory', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.admission = 'hold'
    const request = input('release after target confirmation')
    await test.ctx.agents.receiveInput(test.agent, request)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.cap.release(test.agent, request.message.id)).rejects.toThrow(/not confirmed/)
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    await test.cap.release(test.agent, request.message.id)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(test.events.filter(event => event.type === 'agent/input/released')).toHaveLength(1)
    flush.mockRestore()
  })

  it('preserves abort-time queue classification across a later retry', async () => {
    const test = await boot({ script: ['hang', textResponse('after abort')] })
    test.cap.bind(test.agent.session)
    await test.ctx.agents.receiveInput(test.agent, input('first turn', true))
    await vi.waitFor(() => { expect(test.adapter.requests).toHaveLength(1) })
    test.agent.cancel({ kind: 'user' }, { keepInbox: true })
    const request = input('steer after abort', true)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.ctx.agents.receiveInput(test.agent, request)).rejects.toThrow(/not confirmed/)
    await test.agent.whenIdle()
    expect(test.ctx.agents.inputControlState(test.agent.session).records.at(-1)?.input).toMatchObject({
      target: 'next-turn', requestedTarget: 'next-step', wakeup: true,
    })
    await test.ctx.agents.receiveInput(test.agent, request)
    await test.agent.whenIdle()
    expect(splices(test.events, request)).toBe(1)
    expect(test.adapter.requests).toHaveLength(2)
    flush.mockRestore()
  })

  it('closes the provider and drains a pending receipt without a late wake', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const receipt = test.ctx.agents.receiveInput(test.agent, input('owner unloads', true))
    const rejected = expect(receipt).rejects.toThrow(/closed/)
    await entered.promise
    let disposed = false
    const disposal = test.owner.dispose().then(() => { disposed = true })
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await rejected
    await disposal
    expect(disposed).toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(1)
    flush.mockRestore()
  })

  it('prepares a recovered bound Session before the caller mounts composition', async () => {
    const first = await boot()
    first.cap.bind(first.agent.session)
    await first.ctx.sessions.flush(first.agent.session)
    await first.handle.dispose()
    const order: string[] = []
    await first.cap.dispose()
    const cap = first.ctx.agents.registerInputController(id, {
      admit: () => ({ kind: 'accept' }), canStart: () => false, canClaim: () => false,
      prepare: (session) => {
        order.push(`prepare:${session.id}`)
        return Promise.resolve()
      },
    })
    const resumed = await first.ctx.agents.resume({ resumeSessionId: SessionId('input-agent'),
      agentOptions: { provider: 'mock', model: 'mock' }, setup: () => { order.push('composition') } })
    expect(order).toEqual(['prepare:input-agent', 'composition'])
    expect(first.adapter.requests).toHaveLength(0)
    await resumed.dispose()
    await cap.dispose()
  })

  it('reserves preload for the bound provider and never wakes it', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.admission = 'reject'
    test.policy.start = false
    test.policy.claim = false
    const request = input('summary', true)
    await expect(test.ctx.agents.receiveInput(test.agent, request)).rejects.toThrow('test receipt denied')
    const other = test.ctx.agents.registerInputController(InputControllerId('other-policy'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    await expect(other.preload(test.agent, request)).rejects.toThrow(/another controller/)
    await test.cap.preload(test.agent, request, true)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.inputControlState(test.agent.session).records[0]?.input.wakeup).toBe(true)
  })

  it.each(['false', 'throw'] as const)('retains uncertain custody after flush %s and retries without reinsertion', async (failure) => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('retry once', true)
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      await original(session)
      if (failure === 'throw') throw new Error('receipt observer failed after storage')
      return false
    })
    await expect(test.ctx.agents.receiveInput(test.agent, request)).rejects.toThrow()
    test.agent.wakePending?.()
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
    await test.ctx.agents.receiveInput(test.agent, request)
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(splices(test.events, request)).toBe(1)
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(1)
    flush.mockRestore()
  })

  it('does not claim or wake while persistence is still pending', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const receipt = test.ctx.agents.receiveInput(test.agent, input('pending', true))
    await entered.promise
    test.agent.wakePending?.()
    expect(test.ctx.agents.canClaimInput(test.agent)).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    await receipt
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    flush.mockRestore()
  })

  it('does not wake again when a processed input is retried', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('processed once', true)
    await test.ctx.agents.receiveInput(test.agent, request)
    await test.agent.whenIdle()
    await test.ctx.agents.receiveInput(test.agent, request)
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(1)
    expect(splices(test.events, request)).toBe(1)
  })

  it('keeps an earlier unconfirmed input closed until that receipt is retried', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const first = input('uncertain input', true)
    const second = input('independent input', true)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.ctx.agents.receiveInput(test.agent, first)).rejects.toThrow(/not confirmed/)
    await test.ctx.agents.receiveInput(test.agent, second)
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    await test.ctx.agents.receiveInput(test.agent, first)
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    expect(splices(test.events, first)).toBe(1)
    expect(splices(test.events, second)).toBe(1)
    flush.mockRestore()
  })

  it('refuses a durable receipt without a persistence listener', async () => {
    const test = await boot({ storage: false })
    test.cap.bind(test.agent.session)
    await expect(test.ctx.agents.receiveInput(test.agent, input('not stored', true))).rejects.toThrow(/no persistence listener/)
    test.agent.wakePending?.()
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toHaveLength(1)
  })

  it('rejects missing bindings, invalid provider configuration and unmatched release capabilities', async () => {
    const test = await boot()
    const request = input('unbound')
    await expect(test.ctx.agents.receiveInput(test.agent, request)).rejects.toThrow(/no input controller/)
    expect(() => { test.ctx.agents.registerInputController(InputControllerId(''), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    }) }).toThrow(/empty/)
    test.cap.bind(test.agent.session)
    const other = test.ctx.agents.registerInputController(InputControllerId('release-other'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    await expect(other.release(test.agent, request.message.id)).rejects.toThrow(/another controller/)
    await expect(test.cap.release(test.agent, request.message.id)).rejects.toThrow(/held custody/)
    await test.owner.dispose()
    expect(() => { test.cap.bind(test.agent.session) }).toThrow(/closed/)
  })

  it('refuses duplicate driver contributions and missing driver-produced custody', async () => {
    const test = await boot()
    const concrete = test.agent
    if (!(concrete instanceof ReactLoopAgent)) throw new Error('fixture requires the concrete driver')
    expect(() => { test.ctx.agents.attachInputDriver(concrete, {
      resolve: value => value, enqueue: () => {}, wake: () => {}, remove: () => false, replace: () => false, hold: () => false,
    }) }).toThrow(/already registered/)
    test.cap.bind(concrete.session)
    const enqueue = vi.spyOn(concrete.inbox, 'spliceControlled').mockImplementationOnce(() => {})
    await expect(test.ctx.agents.receiveInput(concrete, input('provider lost input'))).rejects.toThrow(/receipt is missing/)
    expect(test.adapter.requests).toHaveLength(0)
    enqueue.mockRestore()
  })

  it('contains a failing execution policy without opening a model turn', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    Object.defineProperty(test.policy, 'start', { get: () => { throw new Error('policy storage unavailable') } })
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    await test.ctx.agents.receiveInput(test.agent, input('stored, not run', true))
    expect(test.agent.status).toBe('idle')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('contains a failed driver wake after returning durable custody', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const concrete = test.agent
    if (!(concrete instanceof ReactLoopAgent)) throw new Error('fixture requires the concrete driver')
    const wake = vi.spyOn(concrete, 'wakePending').mockImplementationOnce(() => { throw new Error('driver wake unavailable') })
    const request = input('stored despite failed wake', true)
    expect(await test.ctx.agents.receiveInput(concrete, request)).toMatchObject({ location: 'inbox' })
    expect(test.adapter.requests).toHaveLength(0)
    expect(concrete.inbox.nextStep).toEqual([request.message])
    wake.mockRestore()
  })

  it('keeps bindings immutable and fails closed when the provider unloads', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.cap.bind(test.agent.session)
    expect(() => { test.ctx.agents.registerInputController(id, {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    }) }).toThrow(/already registered/)
    const other = test.ctx.agents.registerInputController(InputControllerId('different'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    expect(() => { other.bind(test.agent.session) }).toThrow(/another input controller/)
    await test.owner.dispose()
    await expect(test.ctx.agents.receiveInput(test.agent, input('provider gone', true))).rejects.toThrow(/unavailable/)
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects reuse of one input id with altered content or intent', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('original')
    await test.ctx.agents.receiveInput(test.agent, request)
    await expect(test.ctx.agents.receiveInput(test.agent, { ...request, wakeup: true })).rejects.toThrow(/identity reused/)
    await expect(test.ctx.agents.receiveInput(test.agent, { ...request,
      message: { ...request.message, content: [{ type: 'text', text: 'changed' }] } })).rejects.toThrow(/identity reused/)
    expect(splices(test.events, request)).toBe(1)
  })

  it('reconstructs held custody and wake intent from real storage after reactivation', async () => {
    const first = await boot()
    first.cap.bind(first.agent.session)
    first.policy.admission = 'hold'
    const request = input('held before restart', true)
    await first.ctx.agents.receiveInput(first.agent, request)
    await first.ctx.fiber.dispose()
    const second = await boot({ resources: first.resources, resume: true })
    expect(second.ctx.agents.inputControlState(second.agent.session).records[0]?.input).toEqual(request)
    expect(await second.ctx.agents.receiveInput(second.agent, request)).toMatchObject({ location: 'held' })
    expect(second.events.filter(event => event.type === 'agent/input/held')).toHaveLength(0)
    expect(second.adapter.requests).toHaveLength(0)
  })

  it('captures queued input in order and restores it without reclassifying or waking', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const first = input('first pending', true)
    const second = { ...input('next-turn reference'), target: 'next-turn' as const }
    const discarded = vi.fn()
    const claimed = vi.fn()
    test.ctx.on('agent/inbox/discarded', discarded)
    test.ctx.on('agent/inbox/claimed', claimed)
    test.policy.start = false
    await test.ctx.agents.receiveInput(test.agent, first)
    await test.ctx.agents.receiveInput(test.agent, second)
    expect(await test.cap.holdPending(test.agent)).toEqual([first, second])
    expect([...test.agent.inbox.nextStep, ...test.agent.inbox.nextTurn]).toHaveLength(0)
    expect(discarded).not.toHaveBeenCalled()
    expect(claimed).not.toHaveBeenCalled()
    expect(test.ctx.agents.inputControlState(test.agent.session).records.map(record => record.location))
      .toEqual(['held', 'held'])
    await test.cap.preload(test.agent, first)
    await test.cap.preload(test.agent, second)
    expect(test.agent.inbox.nextStep).toEqual([first.message])
    expect(test.agent.inbox.nextTurn).toEqual([second.message])
    expect(test.adapter.requests).toHaveLength(0)
    test.policy.start = true
    test.agent.wakePending?.()
    await test.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('captures an edited pending body while de-duplicating its original receipt', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const first = input('initial body')
    await test.ctx.agents.receiveInput(test.agent, first)
    await test.ctx.agents.mutateInput(test.agent, { kind: 'replace', messageId: first.message.id,
      content: [{ type: 'text', text: 'edited body' }] })
    await test.ctx.agents.mutateInput(test.agent, { kind: 'replace', messageId: first.message.id,
      content: [{ type: 'text', text: 'final body' }] })
    expect(test.agent.inbox.nextStep[0]?.content).toEqual([{ type: 'text', text: 'final body' }])
    await test.ctx.agents.receiveInput(test.agent, first)
    const captured = await test.cap.holdPending(test.agent)
    expect(captured[0]?.message.content).toEqual([{ type: 'text', text: 'final body' }])
    if (captured[0] === undefined) throw new Error('edited input was not captured')
    await test.cap.preload(test.agent, captured[0])
    expect(test.agent.inbox.nextStep).toEqual([captured[0].message])
    await test.ctx.agents.receiveInput(test.agent, first)
    expect(test.agent.inbox.nextStep).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects edits during a hold policy without changing pending content', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('unchanged')
    await test.ctx.agents.receiveInput(test.agent, request)
    test.policy.admission = 'hold'
    await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: request.message.id }))
      .rejects.toThrow(/admission is closed/)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
  })

  it('retains a pre-binding pending message instead of guessing its wake intent', async () => {
    const test = await boot()
    const unknown = input('pending before input control')
    test.agent.inject(unknown.message)
    test.cap.bind(test.agent.session)
    await expect(test.cap.holdPending(test.agent)).rejects.toThrow(/no reliable recorded/)
    expect(test.agent.inbox.nextStep).toEqual([unknown.message])
    expect(test.ctx.agents.inputControlState(test.agent.session).records).toHaveLength(0)
  })

  it('initializes providers serially before composition and prepares only the bound provider', async () => {
    const test = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const order: string[] = []
    await test.ctx.agents.prepareInput(test.agent.session)
    const first = test.ctx.agents.registerInputController(InputControllerId('first-initializer'), {
      admit: () => ({ kind: 'accept' }), canStart: () => false, canClaim: () => false,
      initialize: async () => { order.push('first'); entered.resolve(undefined); await release.promise },
    })
    const second = test.ctx.agents.registerInputController(InputControllerId('second-initializer'), {
      admit: () => ({ kind: 'accept' }), canStart: () => false, canClaim: () => false,
      initialize: (session, source) => { order.push(`second:${source}`); second.bind(session) },
      prepare: () => { order.push('bound preparation'); return Promise.resolve() },
    })
    const creation = test.ctx.agents.create({ sessionId: SessionId('initialized-agent'),
      agentOptions: { provider: 'mock', model: 'mock' }, setup: () => { order.push('composition') } })
    await entered.promise
    expect(order).toEqual(['first'])
    expect(test.ctx.agents.get(SessionId('initialized-agent'))).toBeUndefined()
    release.resolve(undefined)
    const created = await creation
    expect(order).toEqual(['first', 'second:startup', 'bound preparation', 'composition'])
    expect(test.adapter.requests).toHaveLength(0)
    await created.dispose()
    await second.dispose()
    await first.dispose()
  })

  it('steers and removes pending controlled input while retaining the original receipt identity', async () => {
    const test = await boot()
    const request = { ...input('queued turn', true), target: 'next-turn' as const }
    await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: request.message.id }))
      .rejects.toThrow(/no input controller/)
    test.cap.bind(test.agent.session)
    await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: request.message.id }))
      .rejects.toThrow(/no longer pending/)
    test.policy.start = false
    await test.ctx.agents.receiveInput(test.agent, request)
    await test.ctx.agents.mutateInput(test.agent, { kind: 'steer', messageId: request.message.id })
    expect(test.agent.inbox.nextTurn).toHaveLength(0)
    expect(test.agent.inbox.nextStep).toEqual([request.message])
    await test.ctx.agents.receiveInput(test.agent, request)
    expect(test.agent.inbox.nextStep).toHaveLength(1)
    await test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: request.message.id })
    expect(test.agent.inbox.nextStep).toHaveLength(0)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('reconfirms captured custody after a failed flush without duplicating the held fact', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('capture retry')
    await test.ctx.agents.receiveInput(test.agent, request)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.cap.holdPending(test.agent)).rejects.toThrow(/capture durability/)
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    expect(await test.cap.holdPending(test.agent)).toEqual([request])
    expect(test.events.filter(event => event.type === 'agent/input/held')).toHaveLength(1)
    await test.cap.release(test.agent, request.message.id)
    await expect(test.cap.preload(test.agent, request)).rejects.toThrow(/released input/)
    flush.mockRestore()
  })

  it('rejects a missing required fold and input to a disposed driver', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const state = vi.spyOn(test.ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
    expect(() => test.ctx.agents.isInputControlled(test.agent.session)).toThrow(/projection is not registered/)
    state.mockRestore()
    await test.handle.dispose()
    await expect(test.ctx.agents.receiveInput(test.agent, input('late input'))).rejects.toThrow(/driver is unavailable/)
    await expect(test.cap.holdPending(test.agent)).rejects.toThrow(/driver is unavailable/)
  })

  it('runs a synchronous initialization without adding asynchronous provider work', async () => {
    const test = await boot()
    const initialize = vi.fn(() => {})
    const cap = test.ctx.agents.registerInputController(InputControllerId('sync-initialize'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true, initialize,
    })
    expect(test.ctx.agents.initializeInput(test.agent.session, 'resume')).toBeUndefined()
    expect(initialize).toHaveBeenCalledWith(test.agent.session, 'resume')
    await cap.dispose()
  })

  it('refuses a mutation confirmation when persistence does not confirm it', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const request = input('unconfirmed removal')
    await test.ctx.agents.receiveInput(test.agent, request)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockResolvedValueOnce(false)
    await expect(test.ctx.agents.mutateInput(test.agent, { kind: 'remove', messageId: request.message.id }))
      .rejects.toThrow(/mutation durability/)
    expect(test.ctx.agents.canStartInput(test.agent)).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    flush.mockRestore()
  })

  it('does not let another provider capture the bound receiver', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const other = test.ctx.agents.registerInputController(InputControllerId('capture-other'), {
      admit: () => ({ kind: 'accept' }), canStart: () => true, canClaim: () => true,
    })
    await expect(other.holdPending(test.agent)).rejects.toThrow(/another controller/)
    await other.dispose()
  })

  it('rejects durable confirmation when the Session store is unavailable', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    const reflect = test.ctx.reflect
    const get = reflect.get.bind(reflect)
    const unavailable = vi.spyOn(reflect, 'get').mockImplementation(function(this: typeof reflect, name: string, strict?: boolean) {
      const value: unknown = name === 'sessions' ? undefined : get(name, strict)
      return value
    })
    try {
      await expect(test.ctx.agents.receiveInput(test.agent, input('store unavailable')))
        .rejects.toThrow(/Session store is unavailable/)
      expect(test.adapter.requests).toHaveLength(0)
    } finally {
      unavailable.mockRestore()
    }
  })

  it('closes a custom driver while one receipt is pending and refuses the queued operation', async () => {
    const test = await boot()
    test.cap.bind(test.agent.session)
    test.policy.start = false
    const concrete = test.agent
    if (!(concrete instanceof ReactLoopAgent)) throw new Error('fixture requires the default inbox')
    // A separate driver identity uses the same real Session and inbox to exercise
    // provider teardown without disposing the persistence fixture first.
    const receiver = new Proxy(test.agent, {})
    const detach = test.ctx.agents.attachInputDriver(receiver, {
      resolve: value => value,
      enqueue: (value, prepend) => { concrete.inbox.spliceControlled(value, prepend) },
      wake: () => {},
      remove: messageId => concrete.inbox.remove(messageId),
      replace: (messageId, message) => concrete.inbox.replace(messageId, message),
      hold: messageId => concrete.inbox.holdControlled(messageId),
    })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const first = test.ctx.agents.receiveInput(receiver, input('receipt before driver close'))
    const firstRejected = expect(first).rejects.toThrow(/driver is closed/)
    await entered.promise
    const second = test.ctx.agents.receiveInput(receiver, input('queued before driver close'))
    const secondRejected = expect(second).rejects.toThrow(/driver is closed/)
    const disposal = detach()
    release.resolve(undefined)
    await Promise.all([firstRejected, secondRejected, disposal])
    expect(test.adapter.requests).toHaveLength(0)
    flush.mockRestore()
  })
})
