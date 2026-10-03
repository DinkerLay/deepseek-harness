// @vitest-environment jsdom
/** UI schedulers preserve canonical Controller identity and native immutable event cuts. */
import { expect, it, onTestFinished, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { UiConversation } from '../src/client/conversation/assembly.ts'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Fixture-owned frame-paced target. */
    paced?: number
  }
}

function heldSource(source: SessionEventSource) {
  let current = source.getSnapshot()
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    },
    flush: () => { current = source.getSnapshot(); for (const listener of [...listeners]) listener() },
    listeners: () => listeners.size,
  }
}
async function bench() {
  const runtime = await SlotTestRuntime.create()
  const id = await runtime.sessions.add({ id: 'event-source-test' })
  const reference = runtime.sessions.retain(id, { source: 'mainView' })
  await reference.ready
  const assembly = new UiConversation(runtime.ctx, runtime.sessions)
  onTestFinished(async () => { reference.release(); await runtime.dispose() })
  return { runtime, id, reference, assembly }
}
async function turn(runtime: SlotTestRuntime, id: SessionId, value: number) {
  await runtime.sessions.replaceEvents(id, [{ type: 'event', event: { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: value } } }])
}

it('schedules only UI reads while ids and canonical retained references share one binding', async () => {
  const { runtime, id, reference, assembly } = await bench()
  const native = reference.binding
  const held = heldSource(native.eventSource)
  const remove = assembly.registerEventSourceAdapter('reader', (owner, source) => {
    expect(owner).toBe(native)
    expect(source).toBe(native.eventSource)
    return held.source
  })
  const conversation = assembly.binding(native)
  expect(assembly.eventSourceAdapterVersion).toBe(1)
  expect(assembly.binding(id)).toBe(conversation)
  expect(() => assembly.binding({ ...native, eventSource: held.source })).toThrow('inactive session')
  await turn(runtime, id, 1)
  expect(native.eventSource.getSnapshot().entries).toHaveLength(1)
  expect(conversation.openTurn.getSnapshot()).toBeUndefined()
  held.flush()
  expect(conversation.openTurn.getSnapshot()).toBe(1)
  expect(reference.binding).toBe(native)
  remove()
  expect(held.listeners()).toBe(0)
})

it('keeps observable identities and catches up immediately when the caller removes a scheduler', async () => {
  const { runtime, id, reference, assembly } = await bench()
  const conversation = assembly.binding(reference.binding)
  const snapshot = conversation.snapshot, openTurn = conversation.openTurn
  const held = heldSource(reference.binding.eventSource)
  const remove = assembly.registerEventSourceAdapter('reader', () => held.source)
  await turn(runtime, id, 2)
  expect(openTurn.getSnapshot()).toBeUndefined()
  remove(); remove()
  expect(openTurn.getSnapshot()).toBe(2)
  expect(assembly.binding(id)).toBe(conversation)
  expect(conversation.snapshot).toBe(snapshot)
  expect(conversation.openTurn).toBe(openTurn)
  expect(held.listeners()).toBe(0)
})

it('does not rewind an observed cut when a scheduler begins from an older retained cut', async () => {
  const { runtime, id, reference, assembly } = await bench()
  const held = heldSource(reference.binding.eventSource)
  const conversation = assembly.binding(reference.binding)
  await turn(runtime, id, 7)
  expect(conversation.openTurn.getSnapshot()).toBe(7)
  const remove = assembly.registerEventSourceAdapter('reader', () => held.source)
  expect(conversation.openTurn.getSnapshot()).toBe(7)
  held.flush()
  expect(conversation.openTurn.getSnapshot()).toBe(7)
  remove()
})

it('composes in registration order and removes caller-owned wrappers on plugin teardown', async () => {
  const { runtime, id, reference, assembly } = await bench()
  const held = heldSource(reference.binding.eventSource)
  const first = assembly.registerEventSourceAdapter('first', () => held.source)
  const order: SessionEventSource[] = []
  const consumer = runtime.ctx.plugin({ inject: ['uiConversation'], apply(ctx) {
    ctx.effect(() => ctx.uiConversation.registerEventSourceAdapter('second', (_binding, source) => { order.push(source); return source }))
  } })
  await consumer.await()
  const conversation = assembly.binding(reference.binding)
  expect(order.at(-1)).toBe(held.source)
  expect(() => assembly.registerEventSourceAdapter('first', source => source.eventSource)).toThrow('already registered')
  expect(() => assembly.registerEventSourceAdapter('', source => source.eventSource)).toThrow('must not be empty')
  await consumer.dispose()
  first()
  await turn(runtime, id, 3)
  expect(conversation.openTurn.getSnapshot()).toBe(3)
  expect(held.listeners()).toBe(0)
})

it('unsubscribes a scheduled source when its exact native generation ends', async () => {
  const { id, reference, assembly } = await bench()
  const held = heldSource(reference.binding.eventSource)
  assembly.registerEventSourceAdapter('reader', () => held.source)
  assembly.binding(reference.binding)
  expect(held.listeners()).toBe(1)
  reference.release()
  await Promise.resolve()
  expect(held.listeners()).toBe(0)
  expect(() => assembly.binding(id)).toThrow('unknown session')
})

it('rolls back a refused scheduler without stranding existing native readers', async () => {
  const { runtime, id, reference, assembly } = await bench()
  const conversation = assembly.binding(reference.binding)
  expect(() => assembly.registerEventSourceAdapter('bad', () => { throw new Error('invalid UI scheduler') })).toThrow('invalid UI scheduler')
  await turn(runtime, id, 4)
  expect(conversation.openTurn.getSnapshot()).toBe(4)
  const remove = assembly.registerEventSourceAdapter('bad', (_owner, source) => source)
  remove()
  expect(assembly.binding(id)).toBe(conversation)
})

it('keeps an accepted pending publication when an older scheduler seed replaces its source', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => { frames.delete(key) })
  onTestFinished(() => { vi.unstubAllGlobals() })
  const { reference, assembly } = await bench()
  const source = reference.binding.eventSource
  if (!(source instanceof MutableSessionEventSource)) throw new Error('Fixture must expose the native mutable source.')
  assembly.events.register({ kind: 'paced', target: 'paced',
    match: event => event.type === 'assistant/live-chunk' ? { id: 'one', role: 'start' } : null,
    start: () => 1, update: context => context.state,
    publication: () => 'animation-frame',
    buildViewNode: context => ({ key: context.key, kind: 'paced', target: 'paced', id: context.id, data: context.state }),
  })
  assembly.views.register({ target: 'paced', create: () => ({ empty: 0, replace: ({ nodes }) => nodes.length, apply: () => 1 }) })
  await Promise.resolve()
  const conversation = assembly.binding(reference.binding)
  conversation.activate('paced')
  const published = vi.fn()
  const off = conversation.snapshot.subscribe(published)
  const held = heldSource(source)
  source.append({ type: 'transient', event: { seq: SessionSeq(1), time: 1, type: 'assistant/live-chunk',
    data: { attemptId: LlmAttemptId('pending-publication'), turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'a' } } } })
  expect(published).not.toHaveBeenCalled()
  expect(frames.size).toBe(1)
  const remove = assembly.registerEventSourceAdapter('old-seed', () => held.source)
  expect(frames.size).toBe(1)
  for (let count = 0; count < 3; count++) {
    const current = frames.entries().next().value
    if (current === undefined) throw new Error('Pending publication must remain scheduled.')
    frames.delete(current[0]); current[1](count)
  }
  expect(published).toHaveBeenCalledOnce()
  expect(conversation.snapshot.getSnapshot().views.get('paced')).toBe(1)
  remove(); off()
})
