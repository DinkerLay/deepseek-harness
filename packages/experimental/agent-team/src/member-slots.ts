/** Compare-and-set Profile associations, without parsing product Profile definitions. */

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamCompositionState, TeamMemberSnapshot, TeamProfileSlotBinding } from './types.ts'

/** Host-validated single-slot transfer against the exact current Profile and association cut. */
export interface TeamMemberSlotTransfer {
  readonly profileId: string
  readonly profileVersion: number
  readonly appliedTargetFingerprint: string
  readonly slotId: string
  readonly fromMemberId: SessionId
  readonly toMemberId: SessionId
  readonly previousSlots: readonly TeamProfileSlotBinding[]
}

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
/** Strict decoder for current slot references in native state. */
export const teamProfileSlotSchema: z.ZodType<TeamProfileSlotBinding> = z.object({
  slotId: z.string().min(1).max(200), memberId: sessionId,
}).strict()
/** Strict decoder for the one-slot effect carried by a confirmed member operation. */
export const teamMemberSlotTransferSchema: z.ZodType<TeamMemberSlotTransfer> = z.object({
  profileId: z.string().min(1).max(200), profileVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  appliedTargetFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), slotId: z.string().min(1).max(200),
  fromMemberId: sessionId, toMemberId: sessionId, previousSlots: z.array(teamProfileSlotSchema),
}).strict()

/** Confirm one product-validated slot transfer while retaining the original applied Profile target.
 * @param composition - current native composition policy.
 * @param members - native roster; no new member can be invented by the transfer.
 * @param transfer - expected profile, opaque target fingerprint and previous association map.
 * @returns updated associations with the same lock, permission table and Profile version.
 */
export function applyMemberSlotTransfer(composition: TeamCompositionState | undefined,
  members: readonly TeamMemberSnapshot[], transfer: TeamMemberSlotTransfer): TeamCompositionState {
  if (composition?.phase !== 'dynamic' || composition.profile?.id !== transfer.profileId
    || composition.profile.version !== transfer.profileVersion || composition.appliedTargetJson === undefined
    || createHash('sha256').update(composition.appliedTargetJson).digest('hex') !== transfer.appliedTargetFingerprint) {
    throw new Error('Profile association changed or composition is not unlocked')
  }
  const previous = composition.slotBindings ?? transfer.previousSlots
  if (!isDeepStrictEqual(previous, transfer.previousSlots)
    || new Set(previous.map(slot => slot.slotId)).size !== previous.length
    || new Set(previous.map(slot => slot.memberId)).size !== previous.length
    || previous.some(slot => !members.some(member => member.id === slot.memberId))) {
    throw new Error('Profile slot associations changed or contain unknown members')
  }
  if (previous.find(slot => slot.slotId === transfer.slotId)?.memberId !== transfer.fromMemberId
    || transfer.fromMemberId === transfer.toMemberId
    || previous.some(slot => slot.memberId === transfer.toMemberId && slot.slotId !== transfer.slotId)
    || !members.some(member => member.id === transfer.toMemberId && member.phase === 'active')) {
    throw new Error('Profile slot transfer needs its current source and an active unassigned target')
  }
  return { ...composition, profile: { ...composition.profile, modified: true },
    slotBindings: previous.map(slot => slot.slotId === transfer.slotId
      ? { slotId: slot.slotId, memberId: transfer.toMemberId } : { ...slot }) }
}

/** Resolve the displayed current slot while keeping creation metadata immutable.
 * @param composition - current native Profile association.
 * @param member - original roster snapshot.
 * @returns the current slot, or the creation slot when no explicit association map exists.
 */
export function currentMemberSlot(composition: TeamCompositionState | undefined, member: TeamMemberSnapshot): string | undefined {
  return composition?.slotBindings === undefined ? member.slotId
    : composition.slotBindings.find(slot => slot.memberId === member.id)?.slotId
}
