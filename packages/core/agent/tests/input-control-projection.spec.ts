import { describe, expect, it } from 'vitest'
import { InputControllerId, type AgentInput } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { inputControlProjection as projection } from '../src/input-control-projection.ts'

const id = InputControllerId('policy')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('projection'), createdAt: 0, isSeeded: false }
const input: AgentInput = { message: createUserMessage({ content: [{ type: 'text', text: 'source' }],
  source: { kind: 'user' } }), target: 'next-step', wakeup: true }

// Durable payloads are decoded before this owner validates their fields.
function event(type: SessionEvent['type'], data: unknown, seq = 0): SessionEvent {
  return { type, data, seq: SessionSeq(seq), time: 0 } as SessionEvent
}
const binding = () => event('agent/input/controller-bound', { version: 1, controllerId: id })
function initial() { return projection.init(header, SessionLogOffset(0)) }
function bound() { return projection.apply(initial(), binding()) }
function held(value: unknown = input) { return event('agent/input/held', { version: 1, controllerId: id, input: value }, 1) }
function queued(value: AgentInput = input) {
  return event('agent/inbox/spliced', { target: value.target, start: 0, inserted: [value.message], wakeup: value.wakeup,
    ...value.requestedTarget === undefined ? {} : { requestedTarget: value.requestedTarget } }, 2)
}

describe('durable input custody fold', () => {
  it('excludes fork-inherited bindings and has no client or executable queue view', () => {
    const state = projection.init({ ...header, isSeeded: true }, SessionLogOffset(1))
    expect(projection.apply(state, binding())).toBe(state)
    expect(state.controllerId).toBeNull()
    expect('wire' in projection).toBe(false)
    expect(projection.stateSchema.safeParse(state).success).toBe(true)
  })

  it('requires one immutable versioned binding and ignores unowned ordinary splices', () => {
    expect(projection.apply(initial(), queued())).toEqual(initial())
    expect(() => projection.apply(bound(), binding())).toThrow(/duplicate/)
    expect(() => projection.apply(initial(), event('agent/input/controller-bound', { version: 2, controllerId: id }))).toThrow()
    expect(() => projection.apply(bound(), event('agent/input/held', { version: 1,
      controllerId: InputControllerId('other'), input }))).toThrow(/binding/)
  })

  it('retains unknown legacy wake intent instead of guessing from message contents', () => {
    const state = bound()
    expect(projection.apply(state, event('agent/inbox/spliced', { target: input.target, start: 0,
      inserted: [input.message] }))).toBe(state)
  })

  it('supports an explicit custody move without losing original queue intent', () => {
    const captured: AgentInput = { ...input, target: 'next-turn', requestedTarget: 'next-step' }
    const first = projection.apply(bound(), queued(captured))
    const paused = projection.apply(first, held(captured))
    expect(paused.records[0]).toEqual({ input: captured, location: 'held' })
    expect(projection.apply(paused, held(captured))).toBe(paused)
    const restored = projection.apply(paused, queued(captured))
    expect(restored.records).toEqual([{ input: captured, location: 'inbox' }])
    expect(projection.apply(restored, queued(captured))).toBe(restored)
  })

  it('rejects conflicting identities and cannot reinsert released custody', () => {
    const paused = projection.apply(bound(), held())
    expect(() => projection.apply(paused, held({ ...input, wakeup: false }))).toThrow(/identity reused/)
    const another: AgentInput = { ...input, message: createUserMessage({
      content: [{ type: 'text', text: 'another' }], source: { kind: 'user' } }) }
    const two = projection.apply(paused, held(another))
    const done = projection.apply(two, event('agent/input/released', { version: 1, controllerId: id,
      messageId: input.message.id }, 3))
    expect(done.records.find(record => record.input.message.id === another.message.id)?.location).toBe('held')
    expect(() => projection.apply(done, held())).toThrow(/released input/)
    expect(() => projection.apply(bound(), event('agent/input/released', { version: 1,
      controllerId: id, messageId: input.message.id }))).toThrow(/held custody/)
  })

  it('validates custody removal and refuses a forged change of pending source', () => {
    const state = projection.apply(bound(), held())
    const removal = event('agent/inbox/spliced', { target: input.target, start: 0, removedCount: 1,
      inserted: [], heldInput: input.message.id }, 3)
    expect(projection.apply(state, removal)).toBe(state)
    expect(() => projection.apply(bound(), removal)).toThrow(/recorded held input/)
    const queuedState = projection.apply(bound(), queued())
    expect(() => projection.apply(queuedState, queued({ ...input, message: { ...input.message,
      source: { kind: 'user-approval' } } }))).toThrow(/source cannot change/)
  })

  it('changes one pending body without replacing another receipt', () => {
    const another: AgentInput = { ...input, message: createUserMessage({ content: [{ type: 'text', text: 'another input' }], source: { kind: 'user' } }) }
    const one = projection.apply(bound(), queued())
    const two = projection.apply(one, queued(another))
    const updated = projection.apply(two, queued({ ...input, message: { ...input.message,
      content: [{ type: 'text', text: 'updated' }] } }))
    expect(updated.records[0]?.originalInput).toEqual(input)
    expect(updated.records[1]).toBe(two.records[1])
    expect(projection.stateSchema.safeParse(updated).success).toBe(true)
  })

  it.each([
    null, 1, {}, { ...input.message, id: '' }, { ...input.message, role: 'assistant' },
    { ...input.message, source: null }, { ...input.message, source: {} },
    { ...input.message, source: { kind: 1 } }, { ...input.message, content: null },
    { ...input.message, content: [null] }, { ...input.message, content: [1] },
    { ...input.message, content: [{}] }, { ...input.message, content: [{ type: 1 }] },
  ])('rejects malformed durable input envelopes %j', (message) => {
    expect(() => projection.apply(bound(), held({ ...input, message }))).toThrow()
  })
})
