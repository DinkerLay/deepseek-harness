/**
 * Controlled Team start quota: the members that hold, or are about to hold, an execution. A member that has never received
 * Team input holds none, so a standby member takes no part of the quota until work reaches it.
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import { compositionOf } from './composition.ts'
import { TeamError } from './error.ts'
import { currentMemberExecution, memberExecutionControl } from './member-execution.ts'
import type { TeamState } from './projection.ts'
import type { TeamMemberSnapshot, TeamStartQuota } from './types.ts'

/** Whether a message is still waiting to be delivered: neither delivered nor cancelled. */
function pendingFor(state: TeamState, memberId: SessionId): boolean {
  return state.messages.some(message => message.targetId === memberId && !state.delivered.includes(message.id)
    && !state.cancelled.some(item => item.messageId === message.id))
}

/**
 * Whether any execution generation of a member has received Team input. A rebuild keeps the member started: its new
 * generation exists only because an earlier one ran.
 * @param state - authoritative Team state.
 * @param member - stable roster identity.
 * @returns true once the member has ever started.
 */
export function memberEverStarted(state: TeamState, member: TeamMemberSnapshot): boolean {
  return currentMemberExecution(state, member).generation > 1
    || state.memberDeliveries?.some(receipt => receipt.targetId === member.id) === true
    || state.messages.some(message => message.targetId === member.id && state.delivered.includes(message.id))
}

/**
 * Members counted against the start quota: every started member that has not retired, a retired source whose change
 * operation still holds it, and every member in post that has not started but already has Team input waiting, which will
 * start it on delivery. Failed members never start and are not counted.
 * @param state - authoritative Team state.
 * @returns counted member ids.
 */
export function countedStarters(state: TeamState): Set<SessionId> {
  const counted = new Set<SessionId>()
  for (const member of state.members) {
    if (member.phase === 'failed' || member.phase === 'provisioning') continue
    const started = memberEverStarted(state, member)
    if (member.phase === 'retired') {
      if (started && memberExecutionControl(state, member.id) !== undefined) counted.add(member.id)
      continue
    }
    if (started || member.phase === 'active' && pendingFor(state, member.id)) counted.add(member.id)
  }
  return counted
}

/**
 * Whether a started member could retire at once: the composition admits retirement, and the member owns no unfinished
 * Task, has no waiting Team input and no change operation holds it.
 * @param state - authoritative Team state.
 * @param member - started roster identity.
 * @returns true when retiring it needs no other step first.
 */
function retirableNow(state: TeamState, member: TeamMemberSnapshot): boolean {
  return compositionOf(state.composition).phase === 'dynamic' && member.phase === 'active'
    && memberExecutionControl(state, member.id) === undefined && !pendingFor(state, member.id)
    && !state.tasks.some(task => task.ownerId === member.id && task.status !== 'completed' && task.status !== 'deleted')
}

/**
 * Counted members that could retire at once.
 * @param state - authoritative Team state.
 * @param counted - members counted against the start quota.
 * @returns their ids, in roster order.
 */
function retirable(state: TeamState, counted: ReadonlySet<SessionId>): SessionId[] {
  return state.members.filter(member => counted.has(member.id) && retirableNow(state, member)).map(member => member.id)
}

/**
 * Refuse a write whose Team input would start members past the start quota. Only a write that raises the count is refused:
 * input for a member already counted always passes, also when a lowered limit is already exceeded.
 * @param state - authoritative Team state under the Team lock.
 * @param targetIds - every target the write sends Team input to.
 * @param limit - `maxStartedMembers`; undefined applies no quota.
 */
export function assertStartQuota(state: TeamState, targetIds: Iterable<SessionId>, limit: number | undefined): void {
  if (limit === undefined || state.mode === undefined) return
  const counted = countedStarters(state)
  const starting = [...new Set(targetIds)].flatMap((id) => {
    const member = state.members.find(candidate => candidate.id === id)
    return member?.phase === 'active' && !counted.has(id) ? [member] : []
  })
  if (starting.length === 0 || counted.size + starting.length <= limit) return
  const names = (ids: ReadonlySet<SessionId>) => state.members.filter(member => ids.has(member.id)).map(member => member.name).join(', ')
  const free = new Set(retirable(state, counted))
  const locked = compositionOf(state.composition).phase !== 'dynamic'
  throw new TeamError(`start quota ${limit} reached: ${starting.map(member => member.name).join(', ')} would start; `
    + `members already counted: ${counted.size}${counted.size === 0 ? '' : ` (${names(counted)})`}; `
    + (locked ? 'the Team composition is locked, so the user unlocks it before anyone retires; '
      : free.size === 0 ? 'none can retire at once; ' : `${names(free)} can retire at once; `)
    + 'retire one, or give the work to a started member', 'TEAM_START_QUOTA_REACHED')
}

/**
 * The start quota facts a Task writer or member change reads at one cut.
 * @param state - authoritative Team state.
 * @param limit - `maxStartedMembers`.
 * @returns `{ startQuota }` for a controlled Team with a limit, otherwise an empty object.
 */
export function startQuotaOf(state: TeamState, limit: number | undefined): { readonly startQuota?: TeamStartQuota } {
  if (limit === undefined || state.mode === undefined) return {}
  const counted = countedStarters(state)
  return { startQuota: { limit, counted: [...counted], retirable: retirable(state, counted) } }
}
