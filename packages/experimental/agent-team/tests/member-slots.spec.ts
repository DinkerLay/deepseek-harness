import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { applyMemberSlotTransfer, currentMemberSlot, teamMemberSlotTransferSchema } from '../src/member-slots.ts'
import type { TeamMemberSlotTransfer } from '../src/member-slots.ts'
import type { TeamCompositionState, TeamMemberSnapshot } from '../src/types.ts'

const source: TeamMemberSnapshot = { id: SessionId('source'), name: 'source', description: '', provider: 'spawn',
  context: 'fresh', phase: 'active', slotId: 'research' }
const target: TeamMemberSnapshot = { ...source, id: SessionId('target'), name: 'target', slotId: 'unrelated-birth-slot' }
const composition = { phase: 'dynamic', profile: { id: 'profile', version: 1, modified: false },
  appliedTargetJson: '{"opaque":"product-target"}' } satisfies TeamCompositionState
const transfer: TeamMemberSlotTransfer = { profileId: 'profile', profileVersion: 1,
  appliedTargetFingerprint: createHash('sha256').update(composition.appliedTargetJson).digest('hex'),
  slotId: 'research', fromMemberId: source.id, toMemberId: target.id,
  previousSlots: [{ slotId: 'research', memberId: source.id }] }

describe('native member Profile slot effect', () => {
  it('keeps Profile application and roster metadata immutable and marks only current association modified', () => {
    const next = applyMemberSlotTransfer(composition, [source, target], transfer)
    expect(next).toEqual({ ...composition, profile: { ...composition.profile, modified: true },
      slotBindings: [{ slotId: 'research', memberId: target.id }] })
    expect(currentMemberSlot(undefined, source)).toBe('research')
    expect(currentMemberSlot(next, source)).toBeUndefined()
    expect(currentMemberSlot(next, target)).toBe('research')
    expect(source.slotId).toBe('research')
    expect(target.slotId).toBe('unrelated-birth-slot')
    expect(teamMemberSlotTransferSchema.parse(transfer)).toEqual(transfer)
  })

  it.each([
    undefined, { ...composition, phase: 'fixed' as const },
    { ...composition, profile: { id: 'another', version: 1, modified: false } },
    { ...composition, profile: { id: 'profile', version: 2, modified: false } },
    { phase: 'dynamic' as const, profile: composition.profile },
    { ...composition, appliedTargetJson: '{}' },
  ])('rejects a changed or locked Profile cut', (state) => {
    expect(() => applyMemberSlotTransfer(state, [source, target], transfer)).toThrow(/changed|unlocked/)
  })

  it.each([
    { ...transfer, previousSlots: [] },
    { ...transfer, previousSlots: [...transfer.previousSlots, ...transfer.previousSlots] },
    { ...transfer, previousSlots: [{ slotId: 'research', memberId: SessionId('missing') }] },
    { ...transfer, fromMemberId: target.id },
    { ...transfer, toMemberId: source.id },
    { ...transfer, toMemberId: SessionId('absent') },
    { ...transfer, previousSlots: [...transfer.previousSlots, { slotId: 'other', memberId: target.id }] },
  ])('rejects invalid or occupied slot effects', (effect) => {
    expect(() => applyMemberSlotTransfer(composition, [source, target], effect)).toThrow()
  })

  it('requires current associations and a live target at the effect boundary', () => {
    expect(() => applyMemberSlotTransfer({ ...composition, slotBindings: [{ slotId: 'research', memberId: target.id }] },
      [source, target], transfer)).toThrow(/changed/)
    expect(() => applyMemberSlotTransfer(composition, [source, { ...target, phase: 'retired' }], transfer))
      .toThrow(/active/)
    const next = applyMemberSlotTransfer({ ...composition, slotBindings: transfer.previousSlots }, [source, target], transfer)
    expect(next.slotBindings?.[0]?.memberId).toBe(target.id)
  })

  it('transfers one slot and retains every other association without sharing mutable slot rows', () => {
    const other: TeamMemberSnapshot = { ...source, id: SessionId('other-member'), name: 'other', slotId: 'verification' }
    const previousSlots = [...transfer.previousSlots, { slotId: 'verification', memberId: other.id }]
    const state = { ...composition, slotBindings: previousSlots }
    const next = applyMemberSlotTransfer(state, [source, target, other], { ...transfer, previousSlots })
    expect(next.slotBindings).toEqual([{ slotId: 'research', memberId: target.id }, previousSlots[1]])
    expect(next.slotBindings?.[1]).not.toBe(previousSlots[1])
    expect(state.slotBindings).toEqual(previousSlots)
    expect(currentMemberSlot(next, other)).toBe('verification')
    expect(currentMemberSlot(next, target)).toBe('research')
    expect(currentMemberSlot(next, source)).toBeUndefined()
    expect(next.profile).toEqual({ ...composition.profile, modified: true })
    expect(next.appliedTargetJson).toBe(composition.appliedTargetJson)
    expect(next.phase).toBe(composition.phase)
  })
})
