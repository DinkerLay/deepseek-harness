import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { InputControllerId } from '@deepseek-ai/dsh-agent'
import type { AgentInput, StoredInputCustody } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createUserMessage, ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const SOURCE = SessionId('stored-input-source')
const CONTROLLER = InputControllerId('stored-input-owner')
function input(text: string, target: AgentInput['target'] = 'next-step'): AgentInput {
  return { message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), target, wakeup: false }
}

async function boot(seed?: (session: Session) => void) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-stored-input-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const loop = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter([textResponse('never requested')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const cap = ctx.agents.registerInputController(CONTROLLER, { admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false })
  const session = ctx.sessions.prepare(SOURCE)
  cap.bind(session)
  seed?.(session)
  const stored = await ctx.sessionPersistence.create(session.header)
  await stored.append(session.snapshotEvents())
  await stored.flush()
  await stored.close()
  const scopes: StoredInputCustody[] = []
  onTestFinished(async () => { for (const scope of scopes) await scope.dispose() })
  const acquire = async (signal = new AbortController().signal) => {
    const scope = await cap.acquireStoredCustody(SOURCE, signal)
    scopes.push(scope)
    return scope
  }
  const read = async () => {
    const handle = await ctx.sessionPersistence.open(SOURCE, 'read')
    try { return (await handle.read()).events }
    finally { await handle.close() }
  }
  return { ctx, cap, session, adapter, loop, acquire, read }
}

function queued(session: Session, value: AgentInput): void {
  session.append('agent/inbox/spliced', { target: value.target, start: 0, inserted: [value.message], wakeup: value.wakeup })
}

describe('stored input custody', () => {
  it('runs exclusive source validation before repair or driver preparation and leaves a rejected source unchanged', async () => {
    const test = await boot((session) => { session.append('turn/start', { turn: 1 }) })
    const before = await test.read()
    const prepare = vi.spyOn(test.ctx.agentLoop, 'prepareStoredInput')
    await expect(test.cap.acquireStoredCustody(SOURCE, new AbortController().signal, (source) => {
      expect(source.header.id).toBe(SOURCE)
      expect(source.events).toEqual(before)
      expect(Object.isFrozen(source.header)).toBe(true)
      expect(Object.isFrozen(source.events)).toBe(true)
      expect(() => Object.defineProperty(source.header, 'parentSession', { value: SessionId('another-parent') })).toThrow()
      throw new Error('source belongs to another parent')
    })).rejects.toThrow(/another parent/)
    expect(prepare).not.toHaveBeenCalled()
    expect(await test.read()).toEqual(before)
    const scope = await test.cap.acquireStoredCustody(SOURCE, new AbortController().signal, (source) => {
      expect(source.events).toEqual(before)
      return undefined
    })
    expect(scope.read().events.some(event => event.type === 'turn/end')).toBe(true)
    await scope.dispose()
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('rechecks cancellation after synchronous exclusive validation without writing a repair', async () => {
    const test = await boot((session) => { session.append('turn/start', { turn: 1 }) })
    const before = await test.read()
    const abort = new AbortController()
    await expect(test.cap.acquireStoredCustody(SOURCE, abort.signal, () => {
      abort.abort(new Error('validation owner stopped'))
      return undefined
    })).rejects.toThrow(/owner stopped/)
    expect(await test.read()).toEqual(before)
  })

  it('captures only pending work in queue order and settles exact held identities without an Agent or model', async () => {
    const consumed = input('already consumed')
    const step = input('pending step')
    const turn = input('pending turn', 'next-turn')
    const arriving = input('already held')
    const test = await boot((session) => {
      queued(session, consumed)
      session.append('agent/inbox/spliced', { target: consumed.target, start: 0, removedCount: 1, inserted: [] })
      queued(session, step)
      queued(session, turn)
      session.append('agent/input/held', { version: 1, controllerId: CONTROLLER, input: arriving })
    })
    const scope = await test.acquire()
    const cut = scope.read()
    expect(cut.pending.map(item => item.message.id)).toEqual([step.message.id, turn.message.id])
    expect(cut.events).toEqual(await test.read())
    expect(await scope.holdPending()).toEqual([step, turn, arriving])
    expect(scope.read().pending).toEqual([])
    await expect(scope.releaseHeld(consumed.message.id)).rejects.toThrow(/held custody/)
    await expect(scope.releaseHeld(MessageId('unknown'))).rejects.toThrow(/held custody/)
    await scope.releaseHeld(step.message.id)
    await scope.releaseHeld(step.message.id)
    expect(await scope.holdPending()).toEqual([turn, arriving])
    expect((await test.read()).filter(event => event.type === 'agent/input/released')).toHaveLength(1)
    expect(scope.read()).not.toBe(cut)
    expect(test.ctx.agents.get(SOURCE)).toBeUndefined()
    expect(test.ctx.sessions.get(SOURCE)).toBeUndefined()
    expect(test.adapter.requests).toHaveLength(0)
    await scope.dispose()
    await scope.dispose()
    expect(() => scope.read()).toThrow(/closed/)
    await expect(scope.holdPending()).rejects.toThrow(/closed/)
  })

  it('completes a durable held-before-splice crash without duplicating the held record or replaying consumed input', async () => {
    const pending = input('capture interrupted')
    const test = await boot((session) => {
      queued(session, pending)
      session.append('agent/input/held', { version: 1, controllerId: CONTROLLER, input: pending, captured: true })
    })
    const scope = await test.acquire()
    expect(await scope.holdPending()).toEqual([pending])
    await scope.dispose()
    const again = await test.acquire()
    expect(await again.holdPending()).toEqual([pending])
    const saved = await test.read()
    expect(saved.filter(event => event.type === 'agent/input/held')).toHaveLength(1)
    expect(saved.filter(event => event.type === 'agent/inbox/spliced' && event.data.heldInput === pending.message.id)).toHaveLength(1)
  })

  it('repairs interrupted tools as unknown effects without activating the source', async () => {
    const callId = ToolCallId('unfinished-write')
    const test = await boot((session) => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({ role: 'assistant',
        source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }] }) },
      { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    })
    const scope = await test.acquire()
    expect(scope.read().events).toEqual(await test.read())
    expect(scope.read().events.some(event => event.type === 'tool/result' && event.data.error?.code === TOOL_OUTCOME_UNKNOWN)).toBe(true)
    await scope.dispose()
    const again = await test.acquire()
    expect(again.read().events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it.each(['append', 'flush'] as const)('does not acknowledge %s failure and recovers the same pending mutation', async (failure) => {
    const pending = input('retry exact custody')
    const test = await boot((session) => { queued(session, pending) })
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    let writer: SessionHandle | undefined
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const result = await open(...args)
      if (args[1] === 'write') writer = result
      return result
    })
    const scope = await test.acquire()
    if (writer === undefined) throw new Error('stored writer did not open')
    const append = writer.append.bind(writer)
    const spy = failure === 'append'
      ? vi.spyOn(writer, 'append').mockImplementationOnce(async (...args) => { await append(...args); throw new Error('uncertain append') })
      : vi.spyOn(writer, 'flush').mockRejectedValueOnce(new Error('flush unavailable'))
    await expect(scope.holdPending()).rejects.toThrow()
    spy.mockRestore()
    expect(await scope.holdPending()).toEqual([pending])
    const saved = await test.read()
    expect(saved.filter(event => event.type === 'agent/input/held')).toHaveLength(1)
    expect(saved.filter(event => event.type === 'agent/inbox/spliced' && event.data.heldInput !== undefined)).toHaveLength(1)
  })

  it('refuses another controller and a live source, and closes on owner cancellation', async () => {
    const test = await boot()
    const other = test.ctx.agents.registerInputController(InputControllerId('other-owner'), {
      admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
    })
    await expect(other.acquireStoredCustody(SOURCE, new AbortController().signal)).rejects.toThrow(/another input controller/)
    const abort = new AbortController()
    const scope = await test.acquire(abort.signal)
    abort.abort(new Error('caller stopped'))
    expect(() => scope.read()).toThrow(/caller stopped/)
    await expect(scope.releaseHeld(MessageId('anything'))).rejects.toThrow(/caller stopped/)
    await scope.dispose()
    const live = await test.ctx.agents.resume({ resumeSessionId: SOURCE, agentOptions: { provider: 'mock', model: 'mock' } })
    await expect(test.acquire()).rejects.toThrow(/source is live/)
    await live.dispose()
    const owned = await test.acquire()
    await test.cap.dispose()
    expect(() => owned.read()).toThrow(/closed/)
    expect(test.adapter.requests).toHaveLength(0)
  })

  it('closes a writer acquired after cancellation and rejects a source without persistence', async () => {
    const test = await boot()
    const acquired = await test.ctx.sessionPersistence.open(SOURCE, 'write')
    const close = vi.spyOn(acquired, 'close')
    const ready = Promise.withResolvers<SessionHandle>()
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockReturnValueOnce(ready.promise)
    const abort = new AbortController()
    const pending = test.acquire(abort.signal)
    await Promise.resolve()
    abort.abort(new Error('abandoned acquisition'))
    await expect(pending).rejects.toThrow(/abandoned acquisition/)
    ready.resolve(acquired)
    await vi.waitFor(() => { expect(close).toHaveBeenCalledOnce() })
    await acquired.close()
  })

  it.each(['unaudited', 'uncaptured-held'] as const)('refuses inconsistent %s pending custody without removing input', async (kind) => {
    const pending = input('inconsistent old queue')
    const test = await boot((session) => {
      if (kind === 'unaudited') session.append('agent/inbox/spliced', { target: pending.target, start: 0, inserted: [pending.message] })
      else {
        queued(session, pending)
        session.append('agent/input/held', { version: 1, controllerId: CONTROLLER, input: pending })
      }
    })
    const scope = await test.acquire()
    await expect(scope.holdPending()).rejects.toThrow(/reliable recorded/)
    expect(scope.read().pending.map(item => item.message.id)).toEqual([pending.message.id])
  })

  it('refuses a driver that loses the selected pending input and survives a factory becoming unavailable', async () => {
    const pending = input('driver-owned pending')
    const test = await boot((session) => { queued(session, pending) })
    const prepare = test.ctx.agentLoop.prepareStoredInput.bind(test.ctx.agentLoop)
    const fake = vi.spyOn(test.ctx.agentLoop, 'prepareStoredInput').mockImplementation((session) => {
      const driver = prepare(session)
      return { pending: () => driver.pending(), hold: () => false }
    })
    const scope = await test.acquire()
    await expect(scope.holdPending()).rejects.toThrow(/changed before custody removal/)
    await scope.dispose()
    fake.mockRestore()
    const recovered = await test.acquire()
    expect(await recovered.holdPending()).toEqual([pending])
    await test.loop.dispose()
    expect(() => recovered.read()).toThrow(/not active/)
  })

  it('closes on registry disposal and rejects new acquisition without the required storage service', async () => {
    const test = await boot()
    const scope = await test.acquire()
    await test.ctx.fiber.dispose()
    expect(() => scope.read()).toThrow(/closed/)
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const cap = ctx.agents.registerInputController(InputControllerId('no-storage'), {
      admit: () => ({ kind: 'hold' }), canStart: () => false, canClaim: () => false,
    })
    await expect(cap.acquireStoredCustody(SOURCE, new AbortController().signal)).rejects.toThrow(/requires Sessions and persistence/)
  })

  it('refuses a factory without stored-input support and leaves ordinary waking input unchanged', async () => {
    const test = await boot()
    const live = await test.ctx.agents.create({ sessionId: SessionId('ordinary-input'), agentOptions: { provider: 'mock', model: 'mock' } })
    expect(test.ctx.agents.sendInput(live.agent, { ...input('ordinary next turn', 'next-turn'), wakeup: true })).toBeUndefined()
    await live.agent.whenIdle()
    expect(test.adapter.requests).toHaveLength(1)
    await live.dispose()
    await test.loop.dispose()
    const stop = test.ctx.agents.setFactory({
      createAgent: async () => { throw new Error('creation must not run') },
      resume: async () => { throw new Error('resumption must not run') },
    })
    await expect(test.acquire()).rejects.toThrow(/does not support stored input/)
    stop()
  })

  it('never acknowledges close failure and refuses a mismatched writer identity', async () => {
    const test = await boot()
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    let writer: SessionHandle | undefined
    const spy = vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const result = await open(...args)
      if (args[1] === 'write') writer = result
      return result
    })
    const scope = await test.cap.acquireStoredCustody(SOURCE, new AbortController().signal)
    if (writer === undefined) throw new Error('stored writer did not open')
    const close = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementationOnce(async () => { await close(); throw new Error('close confirmation failed') })
    await expect(scope.dispose()).rejects.toThrow(/close confirmation failed/)
    spy.mockImplementationOnce(async (...args) => {
      const held = await open(...args)
      return { id: SessionId('wrong-source'), header: held.header, access: held.access, inheritedEventCount: held.inheritedEventCount,
        read: held.read.bind(held), append: held.append.bind(held), flush: held.flush.bind(held), close: held.close.bind(held),
        [Symbol.asyncDispose]: held[Symbol.asyncDispose].bind(held) }
    })
    await expect(test.acquire()).rejects.toThrow(/returned another Session/)
  })

  it('rejects operational open errors and contains late-writer close failures after cancellation', async () => {
    const test = await boot()
    const spy = vi.spyOn(test.ctx.sessionPersistence, 'open').mockRejectedValueOnce(new Error('writer ownership conflict'))
    await expect(test.acquire()).rejects.toThrow(/writer ownership conflict/)
    spy.mockRestore()
    const writer = await test.ctx.sessionPersistence.open(SOURCE, 'write')
    const close = writer.close.bind(writer)
    vi.spyOn(writer, 'close').mockImplementationOnce(async () => { await close(); throw new Error('late close failed') })
    const ready = Promise.withResolvers<SessionHandle>()
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockReturnValueOnce(ready.promise)
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    const abort = new AbortController()
    const acquiring = test.acquire(abort.signal)
    await Promise.resolve()
    abort.abort(new Error('late writer abandoned'))
    await expect(acquiring).rejects.toThrow(/abandoned/)
    ready.resolve(writer)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('late close failed')) })
  })

  it('contains a backend acquisition rejection that arrives after its caller abandoned the request', async () => {
    const test = await boot()
    const ready = Promise.withResolvers<SessionHandle>()
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockReturnValueOnce(ready.promise)
    const abort = new AbortController()
    const acquiring = test.acquire(abort.signal)
    await Promise.resolve()
    abort.abort(new Error('caller no longer owns acquisition'))
    await expect(acquiring).rejects.toThrow(/no longer owns/)
    ready.reject(new Error('backend failed after abandonment'))
    await Promise.resolve()
  })

  it('rejects an unexpected stored prefix rather than acknowledging or overwriting it', async () => {
    const pending = input('owned pending')
    const test = await boot((session) => { queued(session, pending) })
    const open = test.ctx.sessionPersistence.open.bind(test.ctx.sessionPersistence)
    let writer: SessionHandle | undefined
    vi.spyOn(test.ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const result = await open(...args)
      if (args[1] === 'write') writer = result
      return result
    })
    const scope = await test.acquire()
    if (writer === undefined) throw new Error('stored writer did not open')
    const read = writer.read.bind(writer)
    const spy = vi.spyOn(writer, 'read').mockImplementationOnce(async (...args) => {
      const result = await read(...args)
      return { ...result, events: result.events.map((event, index) => index === 0 ? { ...event, time: event.time + 1 } : event) }
    })
    await expect(scope.holdPending()).rejects.toThrow(/prefix changed/)
    spy.mockRestore()
    expect(await scope.holdPending()).toEqual([pending])
  })
})
