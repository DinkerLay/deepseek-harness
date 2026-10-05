import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyMemberControl, currentMemberExecution, memberExecutionControl,
  memberExecutionOwner, memberExecutionStarted, teamMemberControlSchema } from '../src/member-execution.ts'
import type { TeamMemberExecutionChange, TeamMemberExecutionControl } from '../src/member-execution.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import { TeamId, TeamMessageId } from '../src/types.ts'

const anchor = SessionId('member-anchor')
const teamId = TeamId(anchor)
const member = { id: SessionId('first-execution'), name: 'worker', description: 'Worker',
  provider: 'spawn', context: 'fresh' as const, phase: 'active' as const,
  preset: { id: 'standard', revision: 'a'.repeat(64) } }
const binding = { memberId: member.id, executionId: SessionId('second-execution'), generation: 2 }
const change: TeamMemberExecutionChange = { version: 1, teamId, operationId: 'renew-1', previousGeneration: 1, binding }
const control: TeamMemberExecutionControl = { memberId: member.id, ownerId: 'member-owner', operationId: change.operationId,
  executionId: member.id, generation: 1, leadExecutionId: anchor, leadTerm: 1, held: true, nextExecutionId: binding.executionId }

function initial(controlled = true) {
  let state = teamProjectionDefinition.init({ id: anchor, createdAt: 0,
    version: SESSION_FORMAT_VERSION, isSeeded: false })
  if (controlled) state = teamProjectionDefinition.apply(state, { type: 'team/mode', seq: SessionSeq(0), time: 0,
    data: { version: 1, teamId, mode: { kind: 'controlled', requiredTaskExtensionId: 'tasks',
      permissionTableId: 'groups', permissionRevision: 'rev', maxOrdinaryMessageBytes: 4096 } } })
  state = teamProjectionDefinition.apply(state, { type: 'team/member/configured', seq: SessionSeq(1), time: 0,
    data: { version: 3, teamId, member: { ...member, phase: 'provisioning' } } })
  return teamProjectionDefinition.apply(state, { type: 'team/member/configured', seq: SessionSeq(2), time: 0,
    data: { version: 3, teamId, member } })
}

function renew(state = initial(), data: unknown = change) {
  const candidate = data as TeamMemberExecutionChange
  const prepared = { ...state, memberControls: [{ memberId: member.id, ownerId: 'member-owner',
    operationId: candidate.operationId, generation: candidate.previousGeneration,
    executionId: currentMemberExecution(state, member).executionId,
    leadExecutionId: anchor, leadTerm: 1, held: true, nextExecutionId: candidate.binding.executionId }] }
  return teamProjectionDefinition.apply(prepared, { type: 'team/member/execution', seq: SessionSeq(3), time: 0, data } as SessionEvent)
}

describe('native teammate execution identity', () => {
  it('keeps the original member and its history while resolving a new current execution', () => {
    const before = initial()
    expect(currentMemberExecution(before, member)).toEqual({ memberId: member.id, executionId: member.id, generation: 1 })
    const state = renew(before)
    expect(state.failure).toBeUndefined()
    expect(state.members).toBe(before.members)
    expect(state.tasks).toBe(before.tasks)
    expect(state.messages).toBe(before.messages)
    expect(currentMemberExecution(state, member)).toEqual(binding)
    expect(memberExecutionOwner(state, member.id)).toEqual({ member, binding: {
      memberId: member.id, executionId: member.id, generation: 1,
    } })
    expect(memberExecutionOwner(state, binding.executionId)).toEqual({ member, binding })
    expect(memberExecutionOwner(state, SessionId('unrelated'))).toBeUndefined()
    expect(teamProjectionDefinition.stateSchema.parse(state)).toEqual(state)
    const view = teamProjectionDefinition.wire.view(state)
    expect(view.members[1]).toMatchObject({ id: member.id, execution: binding })
    expect(teamProjectionDefinition.wire.viewSchema.safeParse(view).success).toBe(true)
  })

  it('retains every execution across more than one renewal without adding member quota', () => {
    const state = renew()
    const nextBinding = { ...binding, executionId: SessionId('third-execution'), generation: 3 }
    const next = renew(state, { ...change, operationId: 'renew-2', previousGeneration: 2, binding: nextBinding })
    expect(next.failure).toBeUndefined()
    expect(next.members).toEqual([member])
    expect(next.memberExecutions).toEqual([{ ...binding, operationId: 'renew-1' }, { ...nextBinding, operationId: 'renew-2' }])
    expect(currentMemberExecution(next, member)).toEqual(nextBinding)
    expect(memberExecutionOwner(next, binding.executionId)?.binding).toEqual(binding)
  })

  it.each([
    { ...change, previousGeneration: 2 },
    { ...change, binding: { ...binding, generation: 3 } },
    { ...change, binding: { ...binding, generation: 0 } },
    { ...change, binding: { ...binding, memberId: 'unknown' } },
    { ...change, binding: { ...binding, executionId: anchor } },
    { ...change, binding: { ...binding, executionId: member.id } },
    { ...change, operationId: '' },
    { ...change, version: 2 },
  ])('rejects invalid persisted changes without mutating the current member: %j', (data) => {
    const state = renew(initial(), data)
    expect(state.failure).toBeDefined()
    expect(currentMemberExecution(state, member).executionId).toBe(member.id)
    expect(state.memberExecutions).toBeUndefined()
  })

  it('rejects a repeated execution and another member or Lead historical execution', () => {
    expect(renew(renew(), { ...change, previousGeneration: 2, binding: { ...binding, generation: 3 } }).failure)
      .toMatch(/already used/)
    const other = { ...member, id: SessionId('another-member'), name: 'other' }
    expect(renew({ ...initial(), members: [member, other] }, { ...change,
      binding: { ...binding, executionId: other.id } }).failure).toMatch(/already used/)
    expect(renew({ ...initial(), leadHistory: [{ executionId: binding.executionId,
      term: 2, presetId: 'standard', revision: 'a'.repeat(64) }] }).failure).toMatch(/already used/)
  })

  it.each(['provisioning', 'failed', 'retiring', 'retired'] as const)('does not rebind a %s member', (phase) => {
    expect(renew({ ...initial(), members: [{ ...member, phase }] }).failure).toMatch(/active member/)
  })

  it('leaves official composition unchanged and rejects product-only execution replacement', () => {
    const state = initial(false)
    expect(teamProjectionDefinition.wire.view(state).members[1]).toEqual({ id: member.id, name: member.name,
      role: 'teammate', phase: 'active', preset: member.preset })
    expect(state.memberExecutions).toBeUndefined()
    expect(renew(state).failure).toMatch(/controlled Team/)
  })

  it('does not mark a renewed execution started from the previous execution receipt', () => {
    let before = initial()
    const id = TeamMessageId('old-input')
    before = teamProjectionDefinition.apply(before, { type: 'team/message/queued', seq: SessionSeq(3), time: 0,
      data: { version: 2, teamId, message: { id, senderId: anchor, senderName: 'lead', targetId: member.id,
        content: [{ type: 'text', text: 'first work' }] } } })
    before = teamProjectionDefinition.apply(before, { type: 'team/message/delivered', seq: SessionSeq(4), time: 0,
      data: { version: 2, teamId, messageId: id, targetId: member.id } })
    expect(teamProjectionDefinition.wire.view(before).members[1]?.executionStarted).toBe(true)
    const state = renew(before)
    expect(teamProjectionDefinition.wire.view(state).members[1]?.executionStarted).toBe(false)
  })

  it('requires the held operation, generation and reserved execution before changing the binding', () => {
    const before = initial()
    for (const memberControls of [undefined, [{ ...control, operationId: 'another-operation' }],
      [{ ...control, generation: 2 }], [{ ...control, nextExecutionId: SessionId('different-candidate') }]]) {
      const prepared = memberControls === undefined ? before : { ...before, memberControls }
      const state = teamProjectionDefinition.apply(prepared, { type: 'team/member/execution', seq: SessionSeq(3), time: 0, data: change })
      expect(state.failure).toMatch(/held preparation/)
      expect(state.memberExecutions).toBeUndefined()
      expect(state.members).toBe(before.members)
    }
  })

  it('does not reuse an operation for a different generation and respects reserved candidate ownership', () => {
    const current = renew()
    expect(renew(current, { ...change, previousGeneration: 2,
      binding: { ...binding, executionId: SessionId('different-next-execution'), generation: 3 } }).failure).toMatch(/already used/)
    const reservation = { ...binding, operationId: change.operationId }
    expect(renew({ ...initial(), memberCandidates: [reservation] }).failure).toBeUndefined()
    expect(renew({ ...initial(), memberCandidates: [{ ...reservation, operationId: 'another-operation' }] }).failure)
      .toMatch(/already used/)
    expect(renew({ ...initial(), memberCandidates: [{ ...reservation, executionId: SessionId('unrelated-reservation') }] }).failure)
      .toBeUndefined()
  })

  it('counts renewed startup only from the exact member, execution and generation', () => {
    const state = renew()
    const receipt = { messageId: TeamMessageId('renewed-first-work'), targetId: member.id,
      executionId: binding.executionId, generation: binding.generation }
    for (const stale of [{ ...receipt, targetId: SessionId('another-member') },
      { ...receipt, executionId: member.id }, { ...receipt, generation: 1 }]) {
      expect(memberExecutionStarted({ ...state, memberDeliveries: [stale] }, member)).toBe(false)
    }
    expect(memberExecutionStarted({ ...state, memberDeliveries: [] }, member)).toBe(false)
    expect(memberExecutionStarted({ ...state, memberDeliveries: [receipt] }, member)).toBe(true)
    const queued = teamProjectionDefinition.apply(state, { type: 'team/message/queued', seq: SessionSeq(4), time: 0,
      data: { version: 2, teamId, message: { id: receipt.messageId, senderId: anchor, senderName: 'lead', targetId: member.id,
        content: [{ type: 'text', text: 'work for the renewed execution' }] } } })
    const received = teamProjectionDefinition.apply(queued, { type: 'team/message/member-delivered', seq: SessionSeq(5), time: 0,
      data: { version: 1, teamId, ...receipt } })
    expect(received.failure).toBeUndefined()
    expect(memberExecutionStarted(received, member)).toBe(true)
    expect(teamProjectionDefinition.wire.view(received).members[1]?.executionStarted).toBe(true)
  })
})

describe('native member-local execution hold', () => {
  it('preserves unrelated controls and repeats only the exact original held operation', () => {
    const before = initial()
    const other = { ...member, id: SessionId('other-member'), name: 'other' }
    const otherControl = { ...control, memberId: other.id, executionId: other.id,
      operationId: 'other-operation', nextExecutionId: SessionId('other-candidate') }
    const state = { ...before, members: [member, other], memberControls: [otherControl] }
    const held = applyMemberControl(state, control)
    expect(held).toEqual([otherControl, control])
    expect(state.memberControls).toEqual([otherControl])
    const current = { ...state, memberControls: held }
    expect(memberExecutionControl(current, member.id)).toEqual(control)
    expect(memberExecutionControl(current, SessionId('unrelated'))).toBeUndefined()
    expect(applyMemberControl(current, control)).toBe(held)
    const released = applyMemberControl(current, { ...control, held: false })
    expect(released).toEqual([otherControl, { ...control, held: false }])
    expect(memberExecutionControl({ ...state, memberControls: released }, member.id)).toBeUndefined()
    expect(current.memberControls).toBe(held)
    expect(teamMemberControlSchema.parse(control)).toEqual(control)
  })

  it('holds failed members for recovery and accepts a current post-Handoff Lead cut without reserving a candidate', () => {
    const lead = { executionId: SessionId('current-lead'), term: 2, presetId: 'standard', revision: 'a'.repeat(64) }
    const { nextExecutionId: _candidate, ...withoutCandidate } = control
    const updated = { ...withoutCandidate, leadExecutionId: lead.executionId, leadTerm: lead.term }
    const state = { ...initial(), members: [{ ...member, phase: 'failed' as const }], lead, leadHistory: [lead] }
    expect(applyMemberControl(state, updated)).toEqual([updated])
    expect(applyMemberControl({ ...state, memberControls: [{ ...updated, held: false }] }, updated)).toEqual([updated])
  })

  it.each([
    { ...control, operationId: 'different-operation' }, { ...control, ownerId: 'different-owner' },
    { ...control, executionId: SessionId('different-execution') }, { ...control, generation: 2 },
    { ...control, leadExecutionId: SessionId('different-lead') }, { ...control, leadTerm: 2 },
    { ...control, nextExecutionId: SessionId('different-candidate') },
  ])('refuses a changed operation while the original member-local hold owns admission: %j', (changed) => {
    const state = { ...initial(), memberControls: [control] }
    expect(() => applyMemberControl(state, changed)).toThrow(/current owner/)
    expect(state.memberControls).toEqual([control])
  })

  it.each([
    { ...control, operationId: 'different-operation' }, { ...control, ownerId: 'different-owner' },
    { ...control, generation: 2 }, { ...control, executionId: SessionId('different-execution') },
    { ...control, leadExecutionId: SessionId('different-lead') }, { ...control, leadTerm: 2 },
    { ...control, nextExecutionId: SessionId('different-candidate') },
  ])('refuses release by a different captured admission owner: %j', (changed) => {
    const state = { ...initial(), memberControls: [control] }
    expect(() => applyMemberControl(state, { ...changed, held: false })).toThrow(/release does not match/)
    expect(state.memberControls).toEqual([control])
  })

  it('requires controlled roster identity and an existing held owner to release', () => {
    expect(() => applyMemberControl(initial(false), control)).toThrow(/controlled Team/)
    expect(() => applyMemberControl({ ...initial(), members: [] }, control)).toThrow(/roster identity/)
    expect(() => applyMemberControl(initial(), { ...control, held: false })).toThrow(/release does not match/)
  })

  it.each(['provisioning', 'retiring', 'retired'] as const)('does not begin a new hold for a %s member', (phase) => {
    expect(() => applyMemberControl({ ...initial(), members: [{ ...member, phase }] }, control)).toThrow(/current owner/)
  })

  it('rejects applying Profile, stale execution/generation and stale Lead identity before holding', () => {
    const before = initial()
    expect(() => applyMemberControl({ ...before, composition: { phase: 'applying' } }, control)).toThrow(/current owner/)
    for (const changed of [{ ...control, executionId: SessionId('stale-execution') }, { ...control, generation: 2 },
      { ...control, leadExecutionId: SessionId('stale-lead') }, { ...control, leadTerm: 2 }]) {
      expect(() => applyMemberControl(before, changed)).toThrow(/current owner/)
    }
  })

  it('does not reserve a member, historical member execution, historical Lead or abandoned candidate identity', () => {
    const before = initial()
    expect(() => applyMemberControl(before, { ...control, nextExecutionId: anchor })).toThrow(/already reserved/)
    expect(() => applyMemberControl(before, { ...control, nextExecutionId: member.id })).toThrow(/already reserved/)
    const current = renew()
    expect(() => applyMemberControl({ ...current, memberControls: [] }, { ...control, operationId: 'next-operation',
      executionId: binding.executionId, generation: 2 })).toThrow(/already reserved/)
    const lead = { executionId: binding.executionId, term: 2, presetId: 'standard', revision: 'a'.repeat(64) }
    expect(() => applyMemberControl({ ...before, lead, leadHistory: [lead] }, { ...control,
      leadExecutionId: lead.executionId, leadTerm: lead.term })).toThrow(/already reserved/)
    expect(() => applyMemberControl({ ...before, memberCandidates: [{ ...binding, operationId: 'abandoned-operation' }] }, control))
      .toThrow(/already reserved/)
  })
})
