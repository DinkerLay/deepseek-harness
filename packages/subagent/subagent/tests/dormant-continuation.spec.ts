/** Dormant custody uses real JSONL, Core input control and continuation ownership without an Agent. */
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import type { AgentInput } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { snapshotSubagentDescriptor } from '../src/descriptor.ts'
import { continuationActivations } from './continuation-internals.ts'
import { loadStoredSession, seedStoredSession } from './persistence-helpers.ts'

class PointQuery extends SessionQuery {
  override searchSessions(): Promise<never> { return Promise.reject(new Error('search is not used')) }
  override searchEvents(): Promise<never> { return Promise.reject(new Error('search is not used')) }
}

function gate() {
  const value = Promise.withResolvers<undefined>()
  return { promise: value.promise, resolve: () => { value.resolve(undefined) } }
}

async function setup() {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-dormant-continuation-'))
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  const removePreset = await ctx.agentPresets.register({ id: 'dormant-worker', plugins: [] })
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(PointQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new MockAdapter([])
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('dormant-parent'), { provider: 'mock', model: 'mock' })
  const input = ctx.agents.registerInputController(InputControllerId('dormant-test-owner'), {
    initialize: (session) => { if (session.header.parentSession !== undefined) input.bind(session) },
    admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
  })
  const signal = new AbortController().signal
  const prepare = async (id = SessionId('dormant-child')) => {
    await using preset = await ctx.agentPresets.acquireComposition('dormant-worker')
    if (preset.revision === undefined) throw new Error('fixture needs the declared revision')
    await ctx.subagents.prepareContinuable({ childId: id, provider: 'spawn', label: preset.id,
      preset: { id: preset.id, revision: preset.revision }, request: { parent }, signal })
    return id
  }
  return { ctx, root, adapter, parent, input, signal, prepare, removePreset }
}

it('holds and releases cold identified input after the original Preset is unavailable without materializing a child', async () => {
  const test = await setup()
  const id = await test.prepare()
  const received: AgentInput = { message: createUserMessage({ content: [{ type: 'text', text: 'Pending work' }], source: { kind: 'user' } }),
    target: 'next-turn', wakeup: true }
  await test.ctx.subagents.withContinuableExecution(test.parent, id, test.signal, async (execution) => {
    await test.ctx.agents.receiveInput(execution, received)
  })
  await test.removePreset()
  const before = await loadStoredSession(test.ctx.sessionPersistence, id)
  const result = await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    if (scope === undefined) throw new Error('stored child was reported absent')
    expect(test.ctx.agents.get(id)).toBeUndefined()
    expect(test.ctx.sessions.get(id)).toBeUndefined()
    expect(scope.read().header).toEqual(before.meta)
    expect(await scope.holdPending()).toEqual([received])
    await scope.releaseHeld(received.message.id)
    return 'custody-settled'
  })
  expect(result).toBe('custody-settled')
  const after = await loadStoredSession(test.ctx.sessionPersistence, id)
  expect(after.events.filter(event => event.type === 'agent/input/released')).toHaveLength(1)
  expect(test.adapter.requests).toHaveLength(0)
  await expect(test.ctx.subagents.withContinuableExecution(test.parent, id, test.signal, async () => {}))
    .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
})

it('reserves a truly uncreated child through its absence callback and blocks concurrent creation', async () => {
  const test = await setup()
  const id = SessionId('never-created-dormant-child')
  const result = await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    expect(scope).toBeUndefined()
    await expect(test.ctx.subagents.startContinuable({ childId: id, provider: 'spawn', label: 'new worker',
      request: { parent: test.parent, prompt: [] }, signal: test.signal })).rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    return 'not-started'
  })
  expect(result).toBe('not-started')
  expect(await test.ctx.sessionPersistence.stat(id)).toBeUndefined()
  expect(test.adapter.requests).toHaveLength(0)
})

it('rejects a lost previously catalogued source instead of treating it as uncreated', async () => {
  const test = await setup()
  const id = await test.prepare()
  const directory = join(test.root, '_no-cwd', id), parked = join(test.root, 'parked-source')
  renameSync(directory, parked)
  const callback = vi.fn(async () => {})
  try {
    await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, callback))
      .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  } finally { renameSync(parked, directory) }
  expect(callback).not.toHaveBeenCalled()
})

it('rejects foreign-parent custody before repairing an interrupted turn or altering its sequence', async () => {
  const test = await setup()
  const id = await test.prepare()
  const write = await test.ctx.sessionPersistence.open(id, 'write')
  try {
    const original = await write.read()
    await write.append([{ type: 'turn/start', seq: SessionSeq(original.events.length), time: 1, data: { turn: 1 } }])
    await write.flush()
  } finally { await write.close() }
  const before = await loadStoredSession(test.ctx.sessionPersistence, id)
  const other = await test.ctx.agents.create({ sessionId: SessionId('foreign-dormant-parent'), agentOptions: { provider: 'mock', model: 'mock' } })
  const callback = vi.fn(async () => {})
  await expect(test.ctx.subagents.withDormantContinuable(other.agent, id, test.input, test.signal, callback))
    .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  expect((await loadStoredSession(test.ctx.sessionPersistence, id)).events).toEqual(before.events)
  expect(callback).not.toHaveBeenCalled()
  await other.dispose()
})

it('rejects overlapping dormant callbacks while keeping the child lock free for other identities', async () => {
  const test = await setup()
  const id = await test.prepare()
  const entered = gate(), exit = gate()
  let secondEntered = false
  const first = test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {
    entered.resolve(); await exit.promise
  })
  await entered.promise
  const second = test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => { secondEntered = true })
  const rejection = expect(second).rejects.toMatchObject({ code: 'EXECUTION_NOT_DORMANT' })
  try {
    await test.ctx.subagents.withDormantContinuable(test.parent, SessionId('independent-dormant-id'), test.input, test.signal, async (scope) => {
      expect(scope).toBeUndefined()
    })
    expect(secondEntered).toBe(false)
  } finally { exit.resolve(); await first; await rejection }
})

it('refuses ordinary cold message materialization while the stored identity is reserved', async () => {
  const test = await setup()
  const id = await test.prepare()
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {
    await expect(test.ctx.subagents.sendMessage(test.parent, id, [{ type: 'text', text: 'must not cold-resume' }], { signal: test.signal }))
      .rejects.toMatchObject({ code: 'DUPLICATE_CHILD' })
    expect(test.ctx.agents.get(id)).toBeUndefined()
  })
  expect(test.adapter.requests).toHaveLength(0)
})

it('does not enter stored maintenance with a different registered input owner', async () => {
  const test = await setup()
  const id = await test.prepare()
  const wrong = test.ctx.agents.registerInputController(InputControllerId('not-this-custody-owner'), {
    admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
  })
  const callback = vi.fn(async () => {})
  await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, wrong, test.signal, callback))
    .rejects.toThrow('stored custody belongs to another input controller')
  expect(callback).not.toHaveBeenCalled()
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {})
})

it('rejects an absence callback result if an external writer creates the source during maintenance', async () => {
  const test = await setup()
  const templateId = await test.prepare(SessionId('dormant-source-template'))
  const template = await loadStoredSession(test.ctx.sessionPersistence, templateId)
  const id = SessionId('externally-created-dormant-source')
  await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    expect(scope).toBeUndefined()
    await seedStoredSession(test.ctx.sessionPersistence, { ...template.meta, id }, template.events, template.inheritedEventCount)
    return 'must-not-ack-absence'
  })).rejects.toMatchObject({ code: 'EXECUTION_NOT_DORMANT' })
  expect(await test.ctx.sessionPersistence.stat(id)).toBeDefined()
  expect(test.ctx.agents.get(id)).toBeUndefined()
})

it('cancels cooperative dormant work and permits a later acquisition after its writer closes', async () => {
  const test = await setup()
  const id = await test.prepare()
  const entered = gate()
  const incoming = new AbortController(), reason = new Error('caller cancelled dormant work')
  const pending = test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, incoming.signal, async (_scope, signal) => {
    entered.resolve()
    return new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => {
      const aborted: unknown = signal.reason
      reject(aborted instanceof Error ? aborted : new Error('dormant callback aborted', { cause: aborted }))
    }, { once: true }) })
  })
  const rejected = expect(pending).rejects.toBe(reason)
  await entered.promise
  incoming.abort(reason); await rejected
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    expect(scope?.read().header.id).toBe(id)
  })
})

it.each(['false', 'throw'] as const)('does not enter Agent maintenance callbacks before their source writer confirms (%s)', async (failure) => {
  const test = await setup()
  const id = await test.prepare()
  const original = test.ctx.sessions.flush.bind(test.ctx.sessions)
  let failed = false
  const flush = vi.spyOn(test.ctx.sessions, 'flush').mockImplementation(async (session) => {
    if (!failed && session.id === id && continuationActivations(test.ctx).get(id) !== undefined) {
      failed = true
      if (failure === 'throw') throw new Error('source checkpoint failed')
      return false
    }
    return original(session)
  })
  const callback = vi.fn(async () => {})
  try {
    const pending = test.ctx.subagents.withContinuableExecution(test.parent, id, test.signal, callback)
    if (failure === 'throw') await expect(pending).rejects.toThrow('source checkpoint failed')
    else await expect(pending).rejects.toMatchObject({ code: 'PREPARATION_NOT_DURABLE' })
  } finally { flush.mockRestore() }
  expect(callback).not.toHaveBeenCalled()
  expect(test.ctx.agents.get(id)).toBeUndefined()
  expect(test.adapter.requests).toHaveLength(0)
})

it('refuses a live held execution instead of opening a competing dormant writer', async () => {
  const test = await setup()
  const id = await test.prepare()
  await test.ctx.subagents.withContinuableExecution(test.parent, id, test.signal, async () => {
    await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {}))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_DORMANT' })
  })
})

it('does not treat an in-flight unpublished materialization as a dormant or missing execution', async () => {
  const test = await setup()
  const id = SessionId('initial-materialization-in-flight')
  const entered = gate(), exit = gate()
  const original = test.ctx.agentPresets.acquireComposition.bind(test.ctx.agentPresets)
  const lease = await original('dormant-worker')
  if (lease.revision === undefined) throw new Error('fixture needs its declared revision')
  const acquire = vi.spyOn(test.ctx.agentPresets, 'acquireComposition').mockImplementation(async (selected) => {
    const actual = await original(selected)
    return { ...actual, mount: async (scope) => { entered.resolve(); await exit.promise; return actual.mount(scope) } }
  })
  const preparing = test.ctx.subagents.prepareContinuable({ childId: id, provider: 'spawn', label: lease.id,
    preset: { id: lease.id, revision: lease.revision }, request: { parent: test.parent }, signal: test.signal })
  try {
    await entered.promise
    expect(test.ctx.agents.get(id)).toBeUndefined()
    expect(test.ctx.sessions.get(id)).toBeUndefined()
    await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {}))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_DORMANT' })
  } finally { exit.resolve(); await preparing; acquire.mockRestore(); await lease[Symbol.asyncDispose]() }
})

it.each(['missing', 'one-shot'] as const)('rejects a stored child whose descriptor is %s without writing repair', async (mode) => {
  const test = await setup()
  const id = SessionId('unsupported-dormant-descriptor')
  const child = await test.ctx.agents.create({ sessionId: id, meta: { parentSession: test.parent.id },
    agentOptions: { provider: 'mock', model: 'mock' }, setup: async (_scope, agent) => {
      if (mode === 'one-shot') agent.session.append('subagent/descriptor', snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'spawn' }))
    } })
  await child.dispose()
  const before = await loadStoredSession(test.ctx.sessionPersistence, id)
  await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {}))
    .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  expect((await loadStoredSession(test.ctx.sessionPersistence, id)).events).toEqual(before.events)
})

it.each(['manager', 'parent', 'selected'] as const)('cancels a cooperating dormant callback and closes its writer (%s)', async (owner) => {
  const test = await setup()
  const id = await test.prepare()
  const entered = gate()
  const pending = test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope, signal) => {
    if (scope === undefined) throw new Error('stored child was reported absent')
    entered.resolve()
    return new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => {
      const aborted: unknown = signal.reason
      reject(aborted instanceof Error ? aborted : new Error('dormant callback aborted', { cause: aborted }))
    }, { once: true }) })
  })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'DRAINING' })
  await entered.promise
  const registry = continuationActivations(test.ctx)
  if (owner === 'manager') await registry.drain()
  else if (owner === 'parent') await registry.drainDescendants([test.parent])
  else await registry.drainChildren(test.parent, [id])
  await rejected
  const source = await test.ctx.sessionPersistence.open(id, 'write')
  await source.close()
  expect(test.ctx.agents.get(id)).toBeUndefined()
})

it('rejects a successful callback result when its stored writer cannot close successfully', async () => {
  const test = await setup()
  const id = await test.prepare()
  const original = test.input.acquireStoredCustody.bind(test.input)
  const close = new Error('stored writer close failed')
  const acquire = vi.spyOn(test.input, 'acquireStoredCustody').mockImplementation(async (...args) => {
    const custody = await original(...args)
    return { ...custody, dispose: async () => { await custody.dispose(); throw close } }
  })
  try {
    await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => 'must-not-ack'))
      .rejects.toBe(close)
  } finally { acquire.mockRestore() }
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    expect(scope?.read().header.id).toBe(id)
  })
})

it('closes exclusive custody after a callback throws and rejects use of the escaped callback scope', async () => {
  const test = await setup()
  const id = await test.prepare()
  const reason = new Error('maintenance failed')
  let escaped: import('../src/types.ts').DormantContinuableScope | undefined
  await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async (scope) => {
    escaped = scope; throw reason
  })).rejects.toBe(reason)
  expect(() => escaped?.read()).toThrow('closed')
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {})
})

it.each([false, true])('retains ownership after cancellation until the admitted callback exits (stored=%s)', async (stored) => {
  const test = await setup()
  const id = stored ? await test.prepare() : SessionId('uncreated-callback-drain')
  const entered = gate(), exit = gate()
  const incoming = new AbortController(), reason = new Error('stop this callback')
  const original = test.input.acquireStoredCustody.bind(test.input)
  const closed = vi.fn()
  const acquire = vi.spyOn(test.input, 'acquireStoredCustody').mockImplementation(async (...args) => {
    const custody = await original(...args)
    return { ...custody, dispose: async () => { closed(); await custody.dispose() } }
  })
  let done = false
  const pending = test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, incoming.signal, async (_scope, signal) => {
    entered.resolve(); await exit.promise
    expect(signal.aborted).toBe(true)
  }).finally(() => { done = true })
  const rejected = expect(pending).rejects.toBe(reason)
  try {
    await entered.promise
    incoming.abort(reason)
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    expect(closed).not.toHaveBeenCalled()
    await expect(test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {}))
      .rejects.toMatchObject({ code: 'EXECUTION_NOT_DORMANT' })
    exit.resolve(); await rejected
    expect(closed).toHaveBeenCalledTimes(stored ? 1 : 0)
  } finally { exit.resolve(); await Promise.allSettled([pending, rejected]); acquire.mockRestore() }
  await test.ctx.subagents.withDormantContinuable(test.parent, id, test.input, test.signal, async () => {})
})
