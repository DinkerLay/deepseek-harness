/** Current teammate executions and immutable historical bindings in the native roster. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TeamState } from './projection.ts'
import { TeamMessageId } from './types.ts'
import type { TeamId, TeamMemberSnapshot, TeamMemberExecution } from './types.ts'
import type { TeamMemberSlotTransfer } from './member-slots.ts'

export type { TeamMemberExecution } from './types.ts'

/** One confirmed historical binding with the operation that produced it. */
export interface TeamMemberExecutionRecord extends TeamMemberExecution {
  readonly operationId: string
}

/** Durable compare-and-set binding, independent of member configuration and Task history. */
export interface TeamMemberExecutionChange {
  readonly version: 1
  readonly teamId: TeamId
  readonly operationId: string
  readonly previousGeneration: number
  readonly binding: TeamMemberExecution
  readonly record?: { readonly ownerId: string; readonly recordId: string; readonly dataJson: string }
}

/** One mailbox receipt identifying the member's actual receiving execution. */
export interface TeamMemberDeliveryReceipt {
  readonly messageId: TeamMessageId
  readonly targetId: SessionId
  readonly executionId: SessionId
  readonly generation: number
}

/** One Host operation's member-local admission hold; product progress is opaque. */
export interface TeamMemberExecutionControl {
  readonly memberId: SessionId
  readonly operationId: string
  readonly ownerId: string
  readonly generation: number
  readonly executionId: SessionId
  readonly leadExecutionId: SessionId
  readonly leadTerm: number
  readonly held: boolean
  /** Reserved child identity, prepared without business input before the binding changes. */
  readonly nextExecutionId?: SessionId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A new current execution for the same immutable teammate configuration. */
    'team/member/execution': TeamMemberExecutionChange
    /** Confirmed delivery to a renewed member execution, without reinterpreting old receipts. */
    'team/message/member-delivered': { readonly version: 1; readonly teamId: TeamId } & TeamMemberDeliveryReceipt
    /** Member-local execution admission and its Host-owned audit share one durable event. */
    'team/member/control': {
      readonly version: 1
      readonly teamId: TeamId
      readonly control: TeamMemberExecutionControl
      readonly record: { readonly recordId: string; readonly dataJson: string }
      readonly slotTransfer?: TeamMemberSlotTransfer
    }
    /** A new reserved candidate for the same held source; abandoned candidates remain identifiable. */
    'team/member/candidate': {
      readonly version: 1
      readonly teamId: TeamId
      readonly previousExecutionId: SessionId
      readonly control: TeamMemberExecutionControl
      readonly record: { readonly recordId: string; readonly dataJson: string }
    }
  }
}

const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const executionFields = {
  memberId: sessionId,
  executionId: sessionId,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}
/** Strict execution decoder used by durable events and browser views. */
export const teamMemberExecutionSchema: z.ZodType<TeamMemberExecution> = z.object(executionFields).strict()
/** Strict native execution-history decoder retaining idempotent operation results. */
export const teamMemberExecutionRecordSchema: z.ZodType<TeamMemberExecutionRecord> = z.object({
  ...executionFields, operationId: z.string().min(1).max(200),
}).strict()

/** Strict recipient decoder for durable member delivery observations. */
export const teamMemberDeliverySchema: z.ZodType<TeamMemberDeliveryReceipt> = z.object({
  messageId: z.string().min(1).transform(TeamMessageId), targetId: sessionId, executionId: sessionId,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict()

/** Strict decoder for the owner of member-local admission. */
export const teamMemberControlSchema = z.object({
  memberId: sessionId, operationId: z.string().min(1).max(200), ownerId: z.string().min(1).max(200),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), executionId: sessionId,
  leadExecutionId: sessionId, leadTerm: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), held: z.boolean(),
  nextExecutionId: sessionId.optional(),
}).strict() as z.ZodType<TeamMemberExecutionControl>

/** Find the active native admission owner without interpreting its product record.
 * @param state - authoritative native Team state.
 * @param memberId - immutable teammate address.
 * @returns the held operation, or undefined when ordinary dispatch is admitted.
 */
export function memberExecutionControl(state: TeamState, memberId: SessionId): TeamMemberExecutionControl | undefined {
  return state.memberControls?.find(control => control.memberId === memberId && control.held)
}

/** Fold one validated member hold while preserving unrelated members' admission.
 * @param state - previous authoritative Team state.
 * @param control - decoded operation and expected native identities.
 * @returns detached current control rows after the transition.
 */
export function applyMemberControl(state: TeamState, control: TeamMemberExecutionControl): readonly TeamMemberExecutionControl[] {
  if (state.mode === undefined) throw new Error('member control requires a controlled Team')
  const member = state.members.find(candidate => candidate.id === control.memberId)
  if (member === undefined) throw new Error('member control has no roster identity')
  const controls = state.memberControls ?? []
  const previous = controls.find(item => item.memberId === member.id && item.held)
  if (control.held) {
    if (previous !== undefined && previous.operationId === control.operationId && previous.ownerId === control.ownerId
      && previous.executionId === control.executionId && previous.generation === control.generation
      && previous.leadExecutionId === control.leadExecutionId && previous.leadTerm === control.leadTerm
      && previous.nextExecutionId === control.nextExecutionId) return controls
    const binding = currentMemberExecution(state, member)
    if (previous !== undefined || member.phase !== 'active' && member.phase !== 'failed' || state.composition?.phase === 'applying'
      || binding.executionId !== control.executionId || binding.generation !== control.generation
      || control.leadExecutionId !== (state.lead?.executionId ?? brandString<SessionId>(state.id))
      || control.leadTerm !== (state.lead?.term ?? 1)) {
      throw new Error('member control conflicts with its current owner or execution')
    }
    const candidate = control.nextExecutionId
    if (candidate !== undefined && (candidate === brandString<SessionId>(state.id)
      || state.members.some(item => item.id === candidate)
      || state.memberExecutions?.some(item => item.executionId === candidate)
      || state.leadHistory?.some(item => item.executionId === candidate)
      || state.memberCandidates?.some(item => item.executionId === candidate))) {
      throw new Error('member preparation identity was already reserved')
    }
  } else if (previous === undefined || previous.operationId !== control.operationId
    || previous.ownerId !== control.ownerId || previous.generation !== control.generation
    || previous.executionId !== control.executionId || previous.leadExecutionId !== control.leadExecutionId
    || previous.leadTerm !== control.leadTerm || previous.nextExecutionId !== control.nextExecutionId) {
    throw new Error('member control release does not match its admission owner')
  }
  return [...controls.filter(item => item.memberId !== control.memberId), { ...control }]
}

/** Resolve the current execution without rewriting the roster's original Session identity.
 * @param state - native Team state, including any committed replacement executions.
 * @param member - original immutable roster record.
 * @returns detached initial or committed current binding.
 */
export function currentMemberExecution(state: TeamState, member: TeamMemberSnapshot): TeamMemberExecution {
  const history = state.memberExecutions ?? []
  const binding = history.findLast(candidate => candidate.memberId === member.id)
  return binding === undefined ? { memberId: member.id, executionId: member.id, generation: 1 }
    : { memberId: binding.memberId, executionId: binding.executionId, generation: binding.generation }
}

/** Resolve an actual current or historical execution back to its stable member.
 * @param state - authoritative Team projection.
 * @param executionId - actual Session identity, not a model-supplied member claim.
 * @returns its member and execution generation, or undefined for an unrelated Session.
 */
export function memberExecutionOwner(state: TeamState, executionId: SessionId): {
  member: TeamMemberSnapshot
  binding: TeamMemberExecution
} | undefined {
  const binding = state.memberExecutions?.find(candidate => candidate.executionId === executionId)
  const member = state.members.find(candidate => candidate.id === (binding?.memberId ?? executionId))
  if (member === undefined) return undefined
  return { member, binding: binding === undefined
    ? { memberId: member.id, executionId: member.id, generation: 1 }
    : { memberId: binding.memberId, executionId: binding.executionId, generation: binding.generation } }
}

/** Read startup only from receipts belonging to this member's current execution.
 * @param state - authoritative native receipt and execution state.
 * @param member - stable original roster identity.
 * @returns whether the current generation has durably received Team work.
 */
export function memberExecutionStarted(state: TeamState, member: TeamMemberSnapshot): boolean {
  const binding = currentMemberExecution(state, member)
  if (binding.generation > 1) return state.memberDeliveries?.some(receipt =>
    receipt.targetId === member.id && receipt.executionId === binding.executionId
    && receipt.generation === binding.generation) ?? false
  return state.messages.some(message => message.targetId === member.id && state.delivered.includes(message.id))
}

/** Apply a decoded binding only when its generation and execution identity are fresh.
 * @param state - previous native Team state.
 * @param change - decoded durable execution change.
 * @returns a new execution history; immutable member and Task records remain untouched.
 */
export function applyMemberExecution(state: TeamState, change: TeamMemberExecutionChange): readonly TeamMemberExecutionRecord[] {
  if (state.mode === undefined) throw new Error('member execution binding requires a controlled Team')
  const member = state.members.find(candidate => candidate.id === change.binding.memberId)
  if (member?.phase !== 'active') throw new Error('member execution binding requires an active member')
  const current = currentMemberExecution(state, member)
  const control = memberExecutionControl(state, member.id)
  if (control === undefined || control.operationId !== change.operationId
    || control.generation !== change.previousGeneration || control.nextExecutionId !== change.binding.executionId) {
    throw new Error('member execution binding requires its held preparation')
  }
  if (change.previousGeneration !== current.generation || change.binding.generation !== current.generation + 1) {
    throw new Error('member execution binding has a stale generation')
  }
  const id = change.binding.executionId
  if (id === brandString<SessionId>(state.id) || state.members.some(candidate => candidate.id === id)
    || state.memberExecutions?.some(candidate => candidate.executionId === id || candidate.operationId === change.operationId)
    || state.memberCandidates?.some(candidate => candidate.executionId === id && candidate.operationId !== change.operationId)
    || state.leadHistory?.some(candidate => candidate.executionId === id)) {
    throw new Error('member execution identity was already used')
  }
  return [...state.memberExecutions ?? [], { ...change.binding, operationId: change.operationId }]
}
