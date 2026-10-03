import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { leadExecutionProjection } from '../src/lead-execution.ts'
import { TeamId } from '../src/types.ts'

const anchor = SessionId('anchor')
const execution = SessionId('execution')
const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: execution,
  createdAt: 0, parentSession: anchor, agentPreset: 'analyst', isSeeded: false }
const identity = { version: 1 as const, teamId: TeamId(anchor), term: 2,
  presetId: 'analyst', revision: 'a'.repeat(64) }

// The event envelope is decoded before the domain validates its persisted payload.
function record(data: unknown = identity, seq = 0): SessionEvent {
  return { type: 'team/lead/execution', data, seq: SessionSeq(seq), time: 0 } as SessionEvent
}

function empty(meta: SessionHeader = header, inherited = 0) {
  return leadExecutionProjection.init(meta, SessionLogOffset(inherited))
}

describe('Lead execution identity fold', () => {
  it('keeps a validated immutable identity without publishing a client projection', () => {
    const before = empty()
    const after = leadExecutionProjection.apply(before, record())
    expect(after.identity).toEqual(identity)
    expect(after.failure).toBeUndefined()
    expect(before.identity).toBeNull()
    expect('wire' in leadExecutionProjection).toBe(false)
    expect(leadExecutionProjection.stateSchema.safeParse(after).success).toBe(true)
  })

  it('ignores inherited identities instead of granting a normal fork a seat', () => {
    const state = empty({ ...header, isSeeded: true }, 1)
    expect(leadExecutionProjection.apply(state, record())).toBe(state)
    expect(state.identity).toBeNull()
    expect(leadExecutionProjection.apply(state, record(identity, 1)).failure).toMatch(/unseeded/)
  })

  it('does not change state for unrelated initialization records', () => {
    const state = empty()
    const unrelated: SessionEvent<'approval/policy'> = { type: 'approval/policy',
      data: { policy: 'ask' }, seq: SessionSeq(0), time: 0 }
    expect(leadExecutionProjection.apply(state, unrelated)).toBe(state)
    const marked = leadExecutionProjection.apply(state, record(identity, 1))
    const active: SessionEvent<'turn/start'> = { type: 'turn/start',
      data: { turn: 1 }, seq: SessionSeq(2), time: 0 }
    expect(leadExecutionProjection.apply(marked, active)).toMatchObject({ eligible: false, identity })
  })

  it.each(['turn/start', 'user/message', 'request/header', 'team/member'] as const)(
    'rejects an identity written after %s activity', (type) => {
      const before = { type, seq: SessionSeq(0), time: 0, data: {} } as SessionEvent
      const state = leadExecutionProjection.apply(empty(), before)
      expect(leadExecutionProjection.apply(state, before)).toBe(state)
      expect(leadExecutionProjection.apply(state, record(identity, 1)).failure).toMatch(/precede/)
    },
  )

  it('rejects a duplicate and retains the first failure', () => {
    const marked = leadExecutionProjection.apply(empty(), record())
    const failed = leadExecutionProjection.apply(marked, record(identity, 1))
    expect(failed.failure).toMatch(/duplicate/)
    expect(leadExecutionProjection.apply(failed, record(identity, 2))).toBe(failed)
  })

  it.each([
    { version: SESSION_FORMAT_VERSION, id: execution, createdAt: 0, agentPreset: 'analyst', isSeeded: false } satisfies SessionHeader,
    { ...header, parentSession: SessionId('different-parent') },
    { ...header, id: anchor },
  ])('requires the distinct durable parent (%j)', (meta) => {
    expect(leadExecutionProjection.apply(empty(meta), record()).failure).toMatch(/anchor/)
  })

  it('requires the header Preset and an ordinary origin', () => {
    expect(leadExecutionProjection.apply(empty({ ...header, agentPreset: 'other' }), record()).failure).toMatch(/Preset/)
    expect(leadExecutionProjection.apply(empty({ ...header, origin: 'subagent' }), record()).failure).toMatch(/ordinary/)
  })

  it.each([
    { ...identity, version: 2 }, { ...identity, term: 1 }, { ...identity, term: 2.5 },
    { ...identity, term: Number.MAX_SAFE_INTEGER + 1 }, { ...identity, revision: 'wrong' },
    { ...identity, teamId: '' }, { ...identity, presetId: '' }, { ...identity, extra: true },
  ])('rejects malformed durable identity %j', (data) => {
    expect(leadExecutionProjection.apply(empty(), record(data)).failure).toBeDefined()
  })

  it('validates the host cache metadata independently of an event payload', () => {
    const minimal: SessionHeader = { version: SESSION_FORMAT_VERSION, id: execution,
      createdAt: 0, isSeeded: false }
    expect(empty(minimal)).toEqual({ sessionId: execution, inheritedEventCount: 0,
      seeded: false, eligible: true, identity: null })
    expect(empty({ ...header, origin: 'subagent' }).origin).toBe('subagent')
    expect(leadExecutionProjection.stateSchema.safeParse({ ...empty(), sessionId: 1 }).success).toBe(false)
    expect(leadExecutionProjection.stateSchema.safeParse({ ...empty(), inheritedEventCount: -1 }).success).toBe(false)
    expect(leadExecutionProjection.stateSchema.safeParse({ ...empty(), inheritedEventCount: '0' }).success).toBe(false)
  })
})
