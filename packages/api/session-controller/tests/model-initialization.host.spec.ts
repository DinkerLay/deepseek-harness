/** Factory and live Session model initialization through the real Controller, loop and JSONL providers. */

import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { initializationHarness } from './model-initialization-harness.ts'

type Harness = Awaited<ReturnType<typeof initializationHarness>>

async function createLive(test: Harness, id = 'live-initialization') {
  const handle = await test.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: test.root },
    agentOptions: { provider: 'initialization', model: 'default' } })
  await test.controller.rename({ sessionId: handle.agent.id, title: 'Stored initializer fixture' })
  await test.ctx.sessions.flush(handle.agent.session)
  return handle
}

async function storedSelections(test: Harness, agent: Agent) {
  await using reader = await test.ctx.sessionPersistence.open(agent.id, 'read')
  return (await reader.read()).events.filter(event => event.type === 'model/selection').map(event => event.data)
}

async function run(test: Harness, agent: Agent): Promise<void> {
  const receipt = test.ctx.agents.sendInput(agent, { target: 'next-turn', wakeup: true,
    message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the initialized execution' }] }) })
  if (receipt !== undefined) await receipt
  await agent.whenIdle()
}

describe('Host-owned execution model initialization', () => {
  it('stores an unpublished factory selection before the first request without saving the global default or waking a model', async () => {
    const test = await initializationHarness()
    const save = vi.spyOn(test.ctx.agentDefaultModel, 'saveSelection')
    const selected = { provider: 'initialization', model: 'prepared-target', reasoningEffort: ReasoningEffortId('high') }
    const handle = await test.ctx.agents.create({ sessionId: SessionId('prepared-initialization'), meta: { cwd: test.root },
      agentOptions: { provider: 'initialization', model: 'factory-default' },
      setup: async (_scope, agent) => {
        expect(test.ctx.agents.get(agent.id)).toBeUndefined()
        expect(test.ctx.sessions.get(agent.id)).toBeUndefined()
        await expect(test.controller.initializeModelSelection(agent, selected)).resolves.toEqual(selected)
        expect(agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toHaveLength(1)
        expect(test.adapter.requests).toHaveLength(0)
      } })
    expect(await storedSelections(test, handle.agent)).toEqual([selected])
    expect(test.adapter.requests).toHaveLength(0)
    expect(save).not.toHaveBeenCalled()
    expect(test.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'initialization', model: 'default' })
    await run(test, handle.agent)
    expect(test.adapter.requests).toHaveLength(1)
    expect(test.adapter.requests[0]).toMatchObject({ provider: 'initialization', model: selected.model, reasoningEffort: 'high' })
    expect(handle.agent.session.snapshotEvents().findIndex(event => event.type === 'model/selection'))
      .toBeLessThan(handle.agent.session.snapshotEvents().findIndex(event => event.type === 'request/header'))
    save.mockRestore()
  })

  it.each(['false', 'throw'] as const)('does not acknowledge a live selection when its durable flush returns %s', async (failure) => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    const save = vi.spyOn(test.ctx.agentDefaultModel, 'saveSelection')
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async () => {
      if (failure === 'throw') throw new Error('initialization checkpoint unavailable')
      return false
    })
    try {
      await expect(test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'live-target' }))
        .rejects.toThrow(failure === 'false' ? 'durability was not confirmed' : 'checkpoint unavailable')
      expect(test.adapter.requests).toHaveLength(0)
      expect(save).not.toHaveBeenCalled()
      flush.mockRestore()
      await expect(test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'confirmed-target' }))
        .resolves.toMatchObject({ provider: 'initialization', model: 'confirmed-target' })
      expect((await storedSelections(test, handle.agent)).at(-1)).toMatchObject({ model: 'confirmed-target' })
      expect(test.adapter.requests).toHaveLength(0)
    } finally { flush.mockRestore(); save.mockRestore() }
  })

  it('waits for live flush confirmation and checks cancellation before returning acknowledgement', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const abort = new AbortController()
    const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await original(session)
    })
    const initialization = test.controller.initializeModelSelection(handle.agent,
      { provider: 'initialization', model: 'flushing-target' }, abort.signal)
    const denied = expect(initialization).rejects.toThrow('cancelled during confirmation')
    try {
      await entered.promise
      expect(test.adapter.requests).toHaveLength(0)
      abort.abort(new Error('cancelled during confirmation'))
      release.resolve(undefined)
      await denied
      expect((await storedSelections(test, handle.agent)).at(-1)).toMatchObject({ model: 'flushing-target' })
    } finally { release.resolve(undefined); await denied; flush.mockRestore() }
  })

  it('records a model without reasoning support without inventing a reasoning selection', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    test.adapter.nonReasoningModels.add('plain-target')
    const selected = await test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'plain-target' })
    expect(selected).toEqual({ provider: 'initialization', model: 'plain-target' })
    expect(await storedSelections(test, handle.agent)).toEqual([selected])
    await run(test, handle.agent)
    expect(test.adapter.requests[0]?.model).toBe('plain-target')
    expect(test.adapter.requests[0]).not.toHaveProperty('reasoningEffort')
  })

  it('rejects an unresolved provider without recording a selection or substituting the default', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    await expect(test.controller.initializeModelSelection(handle.agent, { provider: 'missing-provider', model: 'unresolved-target' }))
      .rejects.toThrow()
    expect(await storedSelections(test, handle.agent)).toEqual([])
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'initialization', model: 'default' })
  })

  it.each(['cancelled', 'Agent disposed', 'Controller unloaded', 'Agent replaced'] as const)
  ('does not write after provider resolution when the owning execution is %s', async (stage) => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    const barrier = test.adapter.hold('held-target')
    const abort = new AbortController()
    const initialization = test.controller.initializeModelSelection(handle.agent,
      { provider: 'initialization', model: 'held-target' }, abort.signal)
    const denied = expect(initialization).rejects.toThrow()
    try {
      await barrier.entered
      if (stage === 'cancelled') abort.abort(new Error('cancelled during resolution'))
      else if (stage === 'Controller unloaded') {
        await test.ctx.loader.update(test.controllerEntry.id, { disabled: true })
        await test.ctx.loader.await()
        expect(test.ctx.get('sessionController')).toBeUndefined()
        expect(test.ctx.agents.get(handle.agent.id)).toBe(handle.agent)
      } else {
        await handle.dispose()
        if (stage === 'Agent replaced') {
          const next = await test.ctx.agents.resume({ resumeSessionId: handle.agent.id,
            agentOptions: { provider: 'initialization', model: 'replacement' } })
          expect(next.agent).not.toBe(handle.agent)
        }
      }
      barrier.release()
      await denied
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
      expect(await storedSelections(test, handle.agent)).toEqual([])
      expect(test.adapter.requests).toHaveLength(0)
    } finally { barrier.release(); await denied }
  })

  it('rejects an already-cancelled initializer without contacting the provider', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test)
    const abort = new AbortController()
    abort.abort(new Error('initialization already cancelled'))
    await expect(test.controller.initializeModelSelection(handle.agent,
      { provider: 'initialization', model: 'never-resolved' }, abort.signal)).rejects.toThrow('already cancelled')
    expect(test.adapter.resolutions).toEqual([])
    expect(await storedSelections(test, handle.agent)).toEqual([])
  })

  it('rejects a prepared initializer when a different real Session occupies its id during resolution', async () => {
    const test = await initializationHarness()
    const id = SessionId('prepared-collision')
    const barrier = test.adapter.hold('prepared-held-target')
    let prepared: Agent | undefined
    const creating = test.ctx.agents.create({ sessionId: id, meta: { cwd: test.root },
      setup: async (_scope, agent) => {
        prepared = agent
        await test.controller.initializeModelSelection(agent, { provider: 'initialization', model: 'prepared-held-target' })
      } })
    const denied = expect(creating).rejects.toThrow('another execution')
    try {
      await barrier.entered
      const occupant = test.ctx.sessions.create(id, { meta: { cwd: test.root } })
      barrier.release()
      await denied
      expect(test.ctx.sessions.get(id)).toBe(occupant)
      expect(prepared?.session.snapshotEvents().filter(event => event.type === 'model/selection')).toEqual([])
      expect(occupant.snapshotEvents()).toEqual([])
      expect(test.ctx.agents.get(id)).toBeUndefined()
      expect(test.adapter.requests).toHaveLength(0)
    } finally { barrier.release(); await denied }
  })

  it('checks the captured owner at queue entry and rejects retained calls before starting another resolution', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test, 'queued-owner')
    const other = await createLive(test, 'closed-owner')
    const barrier = test.adapter.hold('queued-first')
    const first = test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'queued-first' })
    const firstDenied = expect(first).rejects.toThrow()
    await barrier.entered
    const second = test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'never-queued-resolution' })
    const secondDenied = expect(second).rejects.toThrow()
    try {
      await test.ctx.loader.update(test.controllerEntry.id, { disabled: true })
      await test.ctx.loader.await()
      await expect(test.controller.initializeModelSelection(other.agent,
        { provider: 'initialization', model: 'never-closed-resolution' })).rejects.toThrow()
      expect(test.adapter.resolutions).toEqual(['queued-first'])
      barrier.release()
      await Promise.all([firstDenied, secondDenied])
      expect(test.adapter.resolutions).toEqual(['queued-first'])
      expect(await storedSelections(test, handle.agent)).toEqual([])
      expect(await storedSelections(test, other.agent)).toEqual([])
    } finally { barrier.release(); await Promise.all([firstDenied, secondDenied]) }
  })

  it('serializes one Agent through model resolution and confirmation while another Agent can progress', async () => {
    const test = await initializationHarness()
    const handle = await createLive(test, 'ordered-initialization')
    const other = await createLive(test, 'parallel-initialization')
    const barrier = test.adapter.hold('ordered-first')
    const first = test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'ordered-first' })
    await barrier.entered
    const second = test.controller.initializeModelSelection(handle.agent, { provider: 'initialization', model: 'ordered-second' })
    try {
      await test.controller.initializeModelSelection(other.agent, { provider: 'initialization', model: 'independent' })
      expect(test.adapter.resolutions).toEqual(['ordered-first', 'independent'])
      expect(await storedSelections(test, handle.agent)).toEqual([])
      barrier.release()
      await Promise.all([first, second])
      expect((await storedSelections(test, handle.agent)).map(selection => selection.model)).toEqual(['ordered-first', 'ordered-second'])
      expect(test.adapter.resolutions).toEqual(['ordered-first', 'independent', 'ordered-second'])
      expect(test.adapter.requests).toHaveLength(0)
    } finally { barrier.release(); await Promise.allSettled([first, second]) }
  })

  it('cold-restores detached owner options and the pending selection before its first model request', async () => {
    const initial = await initializationHarness()
    const id = SessionId('cold-initialization')
    const created = await initial.ctx.agents.create({ sessionId: id, meta: { cwd: initial.root },
      agentOptions: { provider: 'initialization', model: 'creation-options' },
      setup: async (_scope, agent) => {
        await initial.controller.initializeModelSelection(agent,
          { provider: 'initialization', model: 'pending-before-model', reasoningEffort: ReasoningEffortId('high') })
      } })
    expect(initial.adapter.requests).toHaveLength(0)
    expect(await storedSelections(initial, created.agent)).toMatchObject([{ model: 'pending-before-model' }])
    await initial.ctx.fiber.dispose()

    const cold = await initializationHarness(initial.root)
    const options: AgentOptions = { provider: 'initialization', model: 'owner-options', maxTokens: 777 }
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let released = 0
    cold.controller.registerActivationPreparation('recorded-execution', observation => observation.header.id === id ? {
      agentOptions: options, setup: (_scope, agent) => {
        expect(agent.options).toEqual({ provider: 'initialization', model: 'owner-options', maxTokens: 777 })
        expect(cold.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending).toMatchObject({ model: 'pending-before-model' })
      }, [Symbol.asyncDispose]: async () => { released++ },
    } : undefined)
    cold.controller.registerActivationPreparation('later-provider', async () => {
      entered.resolve(undefined)
      await release.promise
      return undefined
    })
    const restoring = cold.controller.resolveAgent(id)
    try {
      await entered.promise
      options.model = 'mutated-after-capture'
      options.maxTokens = 999
      release.resolve(undefined)
      const restored = await restoring
      if ('error' in restored) throw restored.error
      expect(restored.agent.options).toMatchObject({ model: 'owner-options', maxTokens: 777 })
      expect(released).toBe(1)
      expect(cold.adapter.requests).toHaveLength(0)
      await run(cold, restored.agent)
      expect(cold.adapter.requests[0]).toMatchObject({ model: 'pending-before-model', reasoningEffort: 'high', maxTokens: 777 })
      expect(cold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'initialization', model: 'default' })
    } finally { release.resolve(undefined); await restoring }
  })

  it('preserves ordinary cold activation defaults when no owner supplies options', async () => {
    const initial = await initializationHarness()
    const id = SessionId('ordinary-initialization')
    await initial.controller.create({ sessionId: id, cwd: initial.root })
    await initial.controller.rename({ sessionId: id, title: 'Ordinary stored fixture' })
    const ordinary = initial.ctx.agents.get(id)
    if (ordinary === undefined) throw new Error('ordinary fixture was not published')
    await initial.ctx.sessions.flush(ordinary.session)
    await initial.ctx.fiber.dispose()
    const cold = await initializationHarness(initial.root)
    cold.controller.registerActivationPreparation('unowned-ordinary', () => undefined)
    const restore = await cold.controller.resolveAgent(id)
    if ('error' in restore) throw restore.error
    expect(restore.agent.options).toEqual({ provider: 'initialization', model: 'default' })
    expect(await storedSelections(cold, restore.agent)).toEqual([])
    await run(cold, restore.agent)
    expect(cold.adapter.requests[0]).toMatchObject({ provider: 'initialization', model: 'default' })
  })
})
