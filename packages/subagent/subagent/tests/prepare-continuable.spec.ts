/** Reserved continuable candidates through a real Loader and JSONL composition. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { InputControllerId, type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import Subagents, { type ContinuablePrepareSpec, type SubagentSettlementNoticeFacts } from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession, seedStoredSession } from './persistence-helpers.ts'
import { continuationActivations } from './continuation-internals.ts'

/** Boot owning production rows from a temporary cordis.yml; only model output is scripted. */
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prepare-continuable-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const prerequisites = { name: 'prepare-prerequisites', apply: mountAgentLoopTestDependencies }
  const modules = new Map<string, object>([
    ['prepare-prerequisites', prerequisites], ['prepare-query', TestSessionQuery],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop], ['@deepseek-ai/dsh-agent-preset-registry', AgentPresets],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlPersistence], ['@deepseek-ai/dsh-subagent', Subagents],
    ['@deepseek-ai/dsh-subagent-spawn-in-process', Spawn], ['@deepseek-ai/dsh-subagent-fork-in-process', Fork],
  ])
  const internal: ModuleLoaderV2 = { version: 'v2', loadCache: new Map(),
    import: async (specifier: string) => {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader row ${specifier}`)
      return module
    },
    register(): never { throw new Error('fixture does not register module hooks') },
    getOrCreateModuleJob(): never { throw new Error('fixture does not create module jobs') },
    resolveSync(): never { throw new Error('fixture does not resolve module jobs') },
    load(): never { throw new Error('fixture does not run load hooks') },
  }
  ctx.loader.internal = internal
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([
    { name: 'prepare-prerequisites' },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
    { name: 'prepare-query' },
    { name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    { name: '@deepseek-ai/dsh-agent-loop', config: { agents: [] } },
    { name: '@deepseek-ai/dsh-subagent' },
    { name: '@deepseek-ai/dsh-subagent-spawn-in-process', config: { providerName: 'spawn' } },
    { name: '@deepseek-ai/dsh-subagent-fork-in-process', config: { providerName: 'fork' } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const unregisterReviewer = await ctx.agentPresets.register({ id: 'reviewer', plugins: [] })
  const adapter = new MockAdapter([textResponse('first delivery complete')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agents.create({ sessionId: SessionId('prepare-parent'),
    meta: { cwd: root }, agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (scope) => { await ctx.agentPresets.mount(scope, 'standard') } })
  const unpark = ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent.agent ? { kind: 'reject' } : next())
  const preparedPreset = await ctx.agentPresets.acquireComposition('reviewer')
  if (preparedPreset.revision === undefined) throw new Error('fixture Preset requires a captured revision')
  const preset = { id: 'reviewer', revision: preparedPreset.revision }
  await preparedPreset[Symbol.asyncDispose]()
  const spec: ContinuablePrepareSpec = { childId: SessionId('prepared-child'), provider: 'spawn', label: 'Reserved reviewer',
    preset, signal: new AbortController().signal,
    request: { parent: parent.agent, persona: 'Review accurately.', toolFilter: { allow: [] },
      agentOptions: { provider: 'mock', model: 'mock' } } }
  return { ctx, root, parent: parent.agent, adapter, spec, unpark, unregisterReviewer, modules }
}

type Harness = Awaited<ReturnType<typeof setup>>

/** Bind one real input controller only to this fixture's reserved child. */
function controlled(test: Harness, initiallyHeld = true) {
  let held = initiallyHeld
  let holdInput = initiallyHeld
  const controller = test.ctx.agents.registerInputController(InputControllerId('prepare-input-owner'), {
    admit: () => holdInput ? { kind: 'hold' } : { kind: 'accept' },
    canStart: () => !held, canClaim: () => !held,
    initialize: (session) => { if (session.id === test.spec.childId) controller.bind(session) },
  })
  onTestFinished(() => controller.dispose())
  return { controller, setHeld: (value: boolean) => { held = value }, setHoldInput: (value: boolean) => { holdInput = value } }
}

/** Read the child's actual JSONL rather than trusting an API receipt. */
async function stored(test: Harness) { return loadStoredSession(test.ctx.sessionPersistence, test.spec.childId) }

describe('input-free continuable preparation', () => {
  it('confirms descriptor, Preset, lineage and catalog without any run or input', async () => {
    const test = await setup()
    const starts = vi.fn()
    const ends = vi.fn()
    test.ctx.on('subagent/start', starts)
    test.ctx.on('subagent/end', ends)
    expect(await test.ctx.subagents.prepareContinuable(test.spec)).toEqual({ childId: test.spec.childId })
    const child = await stored(test)
    expect(child.meta).toMatchObject({ parentSession: test.parent.id, origin: 'subagent', cwd: test.root, delegationDepth: 1,
      agentPreset: 'reviewer' })
    expect(child.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(child.events.filter(event => event.type === 'subagent/continuable-preset')).toHaveLength(1)
    expect(child.events.some(event => ['turn/start', 'user/message', 'agent/inbox/spliced'].includes(event.type))).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    expect(starts).not.toHaveBeenCalled()
    expect(ends).not.toHaveBeenCalled()
    expect(test.parent.inbox.nextTurn).toHaveLength(0)
    expect(test.parent.inbox.nextStep).toHaveLength(0)
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toEqual([{
      id: test.spec.childId, createdAt: child.meta.createdAt, mode: 'continuable', label: test.spec.label,
    }])
  })

  it('retries a cold candidate without recreating it or duplicating its catalog', async () => {
    const test = await setup()
    await test.ctx.subagents.prepareContinuable(test.spec)
    const first = await stored(test)
    const create = vi.spyOn(test.ctx.agents, 'create')
    await test.ctx.subagents.prepareContinuable(test.spec)
    expect(create).not.toHaveBeenCalled()
    expect(await stored(test)).toEqual(first)
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
  })

  it('uses existing first-delivery flow and records one stable input across retries', async () => {
    const test = await setup()
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Review the selected Task.' }], source: { kind: 'user' } })
    const delivery = { ...test.spec, request: { ...test.spec.request, prompt: [...input.content] } }
    expect(await test.ctx.subagents.deliverContinuableInput(delivery, input)).toEqual({ childId: test.spec.childId, messageId: input.id })
    await test.ctx.subagents.deliverContinuableInput(delivery, input)
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    const child = await stored(test)
    expect(child.events.filter(event => event.type === 'user/message' && event.data.id === input.id)).toHaveLength(1)
    expect(child.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(1)
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
  })

  it.each(['label', 'provider', 'persona', 'tools', 'model', 'effort', 'preset'] as const)(
    'rejects a changed immutable %s without modifying the candidate', async (field) => {
      const test = await setup()
      await test.ctx.subagents.prepareContinuable(test.spec)
      const before = await stored(test)
      const spec = test.spec
      const { preset: _preset, ...withoutPreset } = spec
      const changed: ContinuablePrepareSpec = field === 'label' ? { ...spec, label: 'Another purpose' }
        : field === 'provider' ? { ...spec, provider: 'fork' }
          : field === 'preset' ? withoutPreset
            : { ...spec, request: { ...spec.request,
              ...field === 'persona' ? { persona: 'Other persona' } : {},
              ...field === 'tools' ? { toolFilter: { allow: ['other_tool'] } } : {},
              ...field === 'model' ? { agentOptions: { ...spec.request.agentOptions, model: 'other' } } : {},
              ...field === 'effort' ? { agentOptions: { ...spec.request.agentOptions, reasoningEffort: ReasoningEffortId('low') } } : {},
            } }
      await expect(test.ctx.subagents.prepareContinuable(changed)).rejects.toBeInstanceOf(Error)
      expect(await stored(test)).toEqual(before)
      expect(test.adapter.requests).toHaveLength(0)
    })

  it.each(['false', 'throw'] as const)('rejects child confirmation %s; retry confirms without input', async (failure) => {
    const test = await setup()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failed = false
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!failed && session.id === test.spec.childId) {
        failed = true
        if (failure === 'throw') throw new Error('candidate checkpoint failed')
        return false
      }
      return original(session)
    })
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toThrow(
      failure === 'throw' ? 'candidate checkpoint failed' : 'durability acknowledgement')
    checkpoint.mockRestore()
    expect(test.adapter.requests).toHaveLength(0)
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(0)
    await test.ctx.subagents.prepareContinuable(test.spec)
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
    expect((await stored(test)).events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it.each(['false', 'throw'] as const)('rejects catalog confirmation %s; retry does not append a second fact', async (failure) => {
    const test = await setup()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failed = false
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!failed && session.id === test.parent.id) {
        failed = true
        if (failure === 'throw') throw new Error('catalog checkpoint failed')
        return false
      }
      return original(session)
    })
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toThrow(
      failure === 'throw' ? 'catalog checkpoint failed' : 'durability acknowledgement')
    checkpoint.mockRestore()
    await test.ctx.subagents.prepareContinuable(test.spec)
    const parent = await loadStoredSession(test.ctx.sessionPersistence, test.parent.id)
    expect(parent.events.filter(event => event.type === 'subagent/catalog')).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('shares preparation/delivery reservation without holding the child lock during confirmation', async () => {
    const test = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let held = false
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!held && session.id === test.spec.childId) {
        held = true
        entered.resolve(undefined)
        await release.promise
      }
      return original(session)
    })
    const prepared = test.ctx.subagents.prepareContinuable(test.spec)
    await entered.promise
    const second = test.ctx.subagents.prepareContinuable(test.spec)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Start after confirmation.' }], source: { kind: 'user' } })
    const delivered = test.ctx.subagents.deliverContinuableInput({ ...test.spec,
      request: { ...test.spec.request, prompt: [...input.content] } }, input)
    await continuationActivations(test.ctx).locks.run(test.spec.childId, () => Promise.resolve())
    expect(test.adapter.requests).toHaveLength(0)
    release.resolve(undefined)
    await prepared
    await second
    await delivered
    checkpoint.mockRestore()
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('checks only the fork child own descriptor and does not execute inherited input', async () => {
    const test = await setup()
    test.unpark()
    await test.ctx.agents.sendInput(test.parent, { message: createUserMessage({
      content: [{ type: 'text', text: 'Finish one parent Turn before forking.' }], source: { kind: 'user' },
    }), target: 'next-turn', wakeup: true })
    await test.parent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    const spec = { ...test.spec, provider: 'fork' }
    await test.ctx.subagents.prepareContinuable(spec)
    const child = await stored(test)
    expect(child.meta.isSeeded).toBe(true)
    expect(child.inheritedEventCount).toBeGreaterThan(0)
    const own = child.events.slice(child.inheritedEventCount)
    expect(own.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
    expect(own.some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
    await test.ctx.subagents.prepareContinuable(spec)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('confirms controlled held custody without any model run and returns the same receipt on retry', async () => {
    const test = await setup()
    controlled(test)
    const started = vi.fn()
    const ended = vi.fn()
    test.ctx.on('subagent/start', started)
    test.ctx.on('subagent/end', ended)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Held business input.' }], source: { kind: 'user' } })
    const spec = { ...test.spec, request: { ...test.spec.request, prompt: [...input.content] } }
    const expected = { childId: test.spec.childId, messageId: input.id, inputLocation: 'held' }
    expect(await test.ctx.subagents.deliverContinuableInput(spec, input)).toEqual(expected)
    expect(await test.ctx.subagents.deliverContinuableInput(spec, input)).toEqual(expected)
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    const child = await stored(test)
    expect(child.events.filter(event => event.type === 'agent/input/held' && event.data.input.message.id === input.id)).toHaveLength(1)
    expect(child.events.some(event => event.type === 'turn/start' || event.type === 'user/message')).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
    expect(started).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
    expect(test.parent.inbox.nextTurn).toHaveLength(0)
  })

  it('captures the first controlled inbox splice inside the actual run interval', async () => {
    const test = await setup()
    controlled(test, false)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const facts = vi.fn((_facts: SubagentSettlementNoticeFacts) => 'suppress' as const)
    test.ctx.subagents.registerSettlementNoticePolicy(facts)
    const input = createUserMessage({ content: [{ type: 'text', text: 'One actual controlled request.' }], source: { kind: 'user' } })
    await test.ctx.subagents.deliverContinuableInput({ ...test.spec,
      request: { ...test.spec.request, prompt: [...input.content] } }, input)
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    expect(test.adapter.requests).toHaveLength(1)
    expect(facts).toHaveBeenCalledOnce()
    const notice = facts.mock.calls[0]?.[0]
    expect(notice?.firstInputOnly).toBe(false)
    expect(notice?.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === input.id))).toBe(true)
    expect(notice?.events.some(event => event.type === 'user/message' && event.data.id === input.id)).toBe(true)
  })

  it('marks a directly started controlled first input as the sole initial input', async () => {
    const test = await setup()
    controlled(test, false)
    const facts = vi.fn((_facts: SubagentSettlementNoticeFacts) => 'suppress' as const)
    test.ctx.subagents.registerSettlementNoticePolicy(facts)
    await test.ctx.subagents.startContinuable({ ...test.spec,
      request: { ...test.spec.request, prompt: [{ type: 'text', text: 'Start and execute the initial input.' }] } })
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    expect(test.adapter.requests).toHaveLength(1)
    expect(facts.mock.calls[0]?.[0].firstInputOnly).toBe(true)
  })

  it.each(['false', 'throw'] as const)('reconfirms a failed controlled input %s without duplicating its inbox', async (failure) => {
    const test = await setup()
    controlled(test, false)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Retry this exact input.' }], source: { kind: 'user' } })
    const spec = { ...test.spec, request: { ...test.spec.request, prompt: [...input.content] } }
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let failed = false
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!failed && session.id === test.spec.childId
        && test.ctx.agents.inputControlState(session).records.some(record => record.input.message.id === input.id)) {
        failed = true
        if (failure === 'throw') throw new Error('input checkpoint failed')
        return false
      }
      return original(session)
    })
    await expect(test.ctx.subagents.deliverContinuableInput(spec, input)).rejects.toThrow(
      failure === 'throw' ? 'input checkpoint failed' : 'input durability was not confirmed')
    expect(test.adapter.requests).toHaveLength(0)
    checkpoint.mockRestore()
    await test.ctx.subagents.deliverContinuableInput(spec, input)
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    const child = await stored(test)
    expect(child.events.filter(event => event.type === 'user/message' && event.data.id === input.id)).toHaveLength(1)
    expect(child.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === input.id))).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('keeps the controlled Activation alive while confirming input without holding its lock', async () => {
    const test = await setup()
    controlled(test, false)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Durability-gated input.' }], source: { kind: 'user' } })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    let gated = false
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (!gated && session.id === test.spec.childId
        && test.ctx.agents.inputControlState(session).records.some(record => record.input.message.id === input.id)) {
        gated = true
        entered.resolve(undefined)
        await release.promise
      }
      return original(session)
    })
    const delivery = test.ctx.subagents.deliverContinuableInput({ ...test.spec,
      request: { ...test.spec.request, prompt: [...input.content] } }, input)
    try {
      await entered.promise
      await continuationActivations(test.ctx).locks.run(test.spec.childId, () => Promise.resolve())
      expect(test.ctx.agents.get(test.spec.childId)).toBeDefined()
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined) }
    await delivery
    checkpoint.mockRestore()
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    expect(test.adapter.requests).toHaveLength(1)
  })

  it('cold-maintains a held child without model work, run publication or retained capacity', async () => {
    const test = await setup()
    controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const started = vi.fn()
    const ended = vi.fn()
    test.ctx.on('subagent/start', started)
    test.ctx.on('subagent/end', ended)
    const callback = vi.fn(async (agent: Agent, signal: AbortSignal) => {
      signal.throwIfAborted()
      expect(agent.id).toBe(test.spec.childId)
      expect(test.ctx.agents.get(agent.id)).toBe(agent)
      await continuationActivations(test.ctx).locks.run(test.spec.childId, () => Promise.resolve())
      return 42
    })
    expect(await test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, callback)).toBe(42)
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    expect(started).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
  })

  it('retains uncaptured pending input on callback failure and safely captures it on retry', async () => {
    const test = await setup()
    const { controller } = controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'Do not lose this pending input.' }],
      source: { kind: 'user' } }), target: 'next-turn' as const, wakeup: true }
    await expect(test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, async (agent) => {
      await controller.preload(agent, input)
      throw new Error('callback failed before custody capture')
    })).rejects.toMatchObject({ code: 'EXECUTION_PENDING_INPUT' })
    const retained = test.ctx.agents.get(test.spec.childId)
    expect(retained?.inbox.nextTurn.map(message => message.id)).toEqual([input.message.id])
    expect(test.adapter.requests).toHaveLength(0)
    const resumed = vi.spyOn(test.ctx.agents, 'resume')
    const captured = await test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal,
      async (agent) => {
        expect(agent).toBe(retained)
        return controller.holdPending(agent)
      })
    expect(captured).toEqual([input])
    expect(resumed).not.toHaveBeenCalled()
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect((await stored(test)).events.some(event => event.type === 'agent/input/held'
      && event.data.input.message.id === input.message.id && event.data.captured === true)).toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('refuses an unheld execution without running the Host callback', async () => {
    const test = await setup()
    controlled(test, false)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const callback = vi.fn(async () => undefined)
    await expect(test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, callback))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_HELD' })
    expect(callback).not.toHaveBeenCalled()
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('prepares an inherited-composition candidate and validates the same cold specification', async () => {
    const test = await setup()
    const { preset: _preset, ...spec } = test.spec
    await test.ctx.subagents.prepareContinuable(spec)
    await test.ctx.subagents.prepareContinuable(spec)
    const child = await stored(test)
    expect(child.meta.agentPreset).toBe('standard')
    expect(child.events.some(event => event.type === 'subagent/continuable-preset')).toBe(false)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('reads an already-live held member and borrows its existing epoch without recreating it', async () => {
    const test = await setup()
    const owner = controlled(test)
    owner.setHoldInput(false)
    await test.ctx.subagents.startContinuable({ ...test.spec,
      request: { ...test.spec.request, prompt: [{ type: 'text', text: 'Pending under a closed run gate.' }] } })
    const live = test.ctx.agents.get(test.spec.childId)
    expect(live).toBeDefined()
    await test.ctx.subagents.prepareContinuable(test.spec)
    expect(test.ctx.agents.get(test.spec.childId)).toBe(live)
    const resume = vi.spyOn(test.ctx.agents, 'resume')
    await test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, async (agent) => {
      expect(agent).toBe(live)
      return owner.controller.holdPending(agent)
    })
    expect(resume).not.toHaveBeenCalled()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects missing or changed current Preset declarations during preparation retry', async () => {
    const test = await setup()
    await test.ctx.subagents.prepareContinuable(test.spec)
    await test.unregisterReviewer()
    const empty = { name: 'prepare-empty', apply: () => {} }
    test.modules.set('prepare-empty', empty)
    await test.ctx.agentPresets.register({ id: 'reviewer', plugins: [{ name: 'prepare-empty' }] })
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toMatchObject({ code: 'PREPARATION_MISMATCH' })
    const entry = [...test.ctx.loader.entries()].find(row => row.options.name === '@deepseek-ai/dsh-agent-preset-registry')
    if (entry === undefined) throw new Error('fixture must own the Preset row')
    await test.ctx.loader.update(entry.id, { disabled: true })
    await test.ctx.loader.await()
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toThrow('explicit preparation requires')
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rejects a missing parent catalog projection instead of claiming preparation', async () => {
    const test = await setup()
    const original = test.ctx.sessionQuery.observeSession.bind(test.ctx.sessionQuery)
    const query = vi.spyOn(test.ctx.sessionQuery, 'observeSession').mockImplementation(async (id, options) => {
      const observed = await original(id, options)
      if (id !== test.parent.id) return observed
      const { projections: _projections, ...withoutProjection } = observed
      return withoutProjection
    })
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toThrow('requires the child catalog projection')
    query.mockRestore()
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    await test.ctx.subagents.prepareContinuable(test.spec)
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
  })

  it('rejects a contradictory catalog fact rather than appending a duplicate', async () => {
    const test = await setup()
    test.parent.session.append('subagent/catalog', { version: 0, childId: test.spec.childId,
      childCreatedAt: 1, mode: 'continuable', label: 'Wrong immutable label' })
    await expect(test.ctx.subagents.prepareContinuable(test.spec)).rejects.toMatchObject({ code: 'PREPARATION_MISMATCH' })
    expect(await test.ctx.subagents.listChildren(test.parent.id)).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('reports direct identified held creation as custody, not executable delivery', async () => {
    const test = await setup()
    controlled(test)
    const input = createUserMessage({ content: [{ type: 'text', text: 'Held from first creation.' }], source: { kind: 'user' } })
    expect(await test.ctx.subagents.deliverContinuableInput({ ...test.spec,
      request: { ...test.spec.request, prompt: [...input.content] } }, input)).toEqual({
      childId: test.spec.childId, messageId: input.id, inputLocation: 'held',
    })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['confirmed', 'failed'] as const)('awaits %s notification to a controlled resident parent', async (outcome) => {
    const test = await setup()
    const owner = controlled(test)
    owner.setHoldInput(false)
    await test.ctx.subagents.startContinuable({ ...test.spec,
      request: { ...test.spec.request, prompt: [{ type: 'text', text: 'Keep the parent resident.' }] } })
    const parent = test.ctx.agents.get(test.spec.childId)
    if (parent === undefined) throw new Error('fixture owns the resident parent')
    const notice = createUserMessage({ content: [{ type: 'text', text: 'A child notification.' }], source: { kind: 'user' } })
    const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
    const checkpoint = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
      if (outcome === 'failed' && session === parent.session) throw new Error('parent notification checkpoint failed')
      return original(session)
    })
    const receipt = continuationActivations(test.ctx).sendWaking(parent, notice, 'queue')
    if (outcome === 'failed') await expect(receipt).rejects.toThrow('parent notification checkpoint failed')
    else await expect(receipt).resolves.toMatchObject({ messageId: notice.id, location: 'inbox' })
    checkpoint.mockRestore()
    expect(parent.inbox.nextTurn.some(message => message.id === notice.id)).toBe(true)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('does not report success after its exact held execution begins disposal during maintenance', async () => {
    const test = await setup()
    controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    let disposing: Promise<void> | undefined
    await expect(test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, async () => {
      const registry = continuationActivations(test.ctx)
      const activation = registry.get(test.spec.childId)
      if (activation === undefined) throw new Error('fixture owns a maintenance epoch')
      disposing = registry.dispose(activation)
      return 1
    })).rejects.toThrow()
    await disposing
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('does not hand back a replaced maintenance epoch as the current execution', async () => {
    const test = await setup()
    controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const registry = continuationActivations(test.ctx)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const maintaining = test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal,
      async () => {
        entered.resolve(undefined)
        await release.promise
        return 1
      })
    const failure = expect(maintaining).rejects.toMatchObject({ code: 'ACTIVATION_CLOSING' })
    await entered.promise
    const current = registry.get(test.spec.childId)
    if (current === undefined) throw new Error('fixture owns the exact maintenance epoch')
    const replacementClosed = current.inbox.close(async () => { release.resolve(undefined) })
    await failure
    await replacementClosed
    // The diagnostic must not claim the closed epoch succeeded; its memoized
    // close deliberately leaves handle release with this test's exact owner.
    await current.handle.dispose()
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('keeps an unexpected pending candidate intact rather than silently disposing it', async () => {
    const test = await setup()
    const { controller } = controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'Preserve pending custody.' }],
      source: { kind: 'user' } }), target: 'next-turn' as const, wakeup: true }
    await expect(test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal, async (agent) => {
      await controller.preload(agent, input)
    })).rejects.toMatchObject({ code: 'EXECUTION_PENDING_INPUT' })
    const registry = continuationActivations(test.ctx)
    const activation = registry.get(test.spec.childId)
    if (activation === undefined) throw new Error('fixture owns a retained candidate')
    expect(() => registry.releasePrepared(activation)).toThrow('received input before release')
    const agent = activation.handle.agent
    expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([input.message.id])
    await controller.holdPending(agent)
    registry.enableDelivery(activation)
    await vi.waitFor(() => { expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined() })
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('waits outside the child lock for a closing epoch before cold Host maintenance', async () => {
    const test = await setup()
    const { controller } = controlled(test)
    await test.ctx.subagents.prepareContinuable(test.spec)
    const input = { message: createUserMessage({ content: [{ type: 'text', text: 'Retain and capture before close.' }],
      source: { kind: 'user' } }), target: 'next-turn' as const, wakeup: true }
    await expect(test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal,
      agent => controller.preload(agent, input))).rejects.toMatchObject({ code: 'EXECUTION_PENDING_INPUT' })
    const registry = continuationActivations(test.ctx)
    const previous = registry.get(test.spec.childId)
    if (previous === undefined) throw new Error('fixture owns the closing epoch')
    await controller.holdPending(previous.handle.agent)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const dispose = previous.handle.dispose.bind(previous.handle)
    vi.spyOn(previous.handle, 'dispose').mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return dispose()
    })
    const closing = registry.dispose(previous)
    await entered.promise
    const maintaining = test.ctx.subagents.withContinuableExecution(test.parent, test.spec.childId, test.spec.signal,
      async (agent) => {
        expect(agent).not.toBe(previous.handle.agent)
        return 7
      })
    try {
      await registry.locks.run(test.spec.childId, () => Promise.resolve())
      expect(test.adapter.requests).toHaveLength(0)
    } finally { release.resolve(undefined) }
    await closing
    expect(await maintaining).toBe(7)
    expect(test.ctx.agents.get(test.spec.childId)).toBeUndefined()
  })

  it.each(['cwd', 'depth', 'preset', 'origin'] as const)('refuses a stored candidate with incompatible %s metadata', async (field) => {
    const test = await setup()
    await test.ctx.subagents.prepareContinuable(test.spec)
    const original = await stored(test)
    const childId = SessionId(`wrong-${field}`)
    const { origin: _origin, ...withoutOrigin } = original.meta
    const header = field === 'origin' ? { ...withoutOrigin, id: childId }
      : { ...original.meta, id: childId,
        ...field === 'cwd' ? { cwd: join(test.root, 'another-workspace') } : {},
        ...field === 'depth' ? { delegationDepth: 2 } : {},
        ...field === 'preset' ? { agentPreset: 'standard' } : {},
      }
    await seedStoredSession(test.ctx.sessionPersistence, header, original.events, original.inheritedEventCount)
    await expect(test.ctx.subagents.prepareContinuable({ ...test.spec, childId })).rejects.toMatchObject({ code: 'PREPARATION_MISMATCH' })
    expect(test.adapter.requests).toHaveLength(0)
  })
})
