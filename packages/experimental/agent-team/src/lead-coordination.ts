/** Durable native admission for one Host-owned Lead transition. */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamState } from './projection.ts'
import { TeamLeadOperationId } from './types.ts'
import type { TeamLeadCoordination, TeamLeadTransition } from './types.ts'

export type { TeamLeadCoordination, TeamLeadTransition, TeamLeadCoordinationPhase } from './types.ts'

const fields = {
  operationId: z.string().min(1).max(200).transform(TeamLeadOperationId),
  previousTerm: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousExecutionId: z.string().min(1).transform(value => brandString<SessionId>(value)),
}

/** Decoder for newly introduced transition metadata. */
export const teamLeadTransitionSchema: z.ZodType<TeamLeadTransition> = z.object({ ...fields,
  phase: z.enum(['requested', 'frozen', 'safe', 'prepared', 'ready', 'cancelled', 'failed']),
}).strict()

/** Checkpoint decoder for native coordinator admission state. */
export const teamLeadCoordinationSchema: z.ZodType<TeamLeadCoordination> = z.object({ ...fields,
  coordinatorId: z.string().min(1).max(200),
  phase: z.enum(['requested', 'frozen', 'safe', 'prepared', 'committed', 'ready', 'cancelled', 'failed']),
}).strict()

/** Whether a recorded coordination still exclusively owns the current transition.
 * @param value - last native transition control.
 * @returns whether another transition or Profile application must be refused.
 */
export function leadCoordinationActive(value: TeamLeadCoordination | undefined): boolean {
  return value !== undefined && value.phase !== 'ready' && value.phase !== 'cancelled' && value.phase !== 'failed'
}

/** Whether the current Lead must neither consume input nor perform model Team writes.
 * @param value - native transition state.
 * @returns whether the transition has frozen execution admission.
 */
export function leadCoordinationFrozen(value: TeamLeadCoordination | undefined): boolean {
  return leadCoordinationActive(value) && value?.phase !== 'requested'
}

/** Validate one native transition independently of opaque product data.
 * @param state - authoritative Team state before the record.
 * @param coordinatorId - registered record owner.
 * @param transition - new native phase and original seat identity.
 * @returns native coordination state after the event.
 */
export function applyLeadTransition(
  state: TeamState, coordinatorId: string, transition: TeamLeadTransition,
): TeamLeadCoordination {
  if (state.mode === undefined || coordinatorId === state.mode.requiredTaskExtensionId) {
    throw new Error('Lead coordination requires a distinct coordinator in a controlled Team')
  }
  const current = state.leadCoordination
  const term = state.lead?.term ?? 1
  const executionId = state.lead?.executionId ?? brandString<SessionId>(state.id)
  if (transition.phase === 'requested') {
    if (leadCoordinationActive(current) || state.composition?.phase === 'applying') {
      throw new Error('Lead coordination conflicts with an active transition or Profile application')
    }
    if (transition.previousTerm !== term || transition.previousExecutionId !== executionId) {
      throw new Error('Lead coordination has a stale seat')
    }
    return { ...transition, coordinatorId }
  }
  if (current === undefined || current.coordinatorId !== coordinatorId
    || current.operationId !== transition.operationId || current.previousTerm !== transition.previousTerm
    || current.previousExecutionId !== transition.previousExecutionId) {
    throw new Error('Lead coordination does not own this operation')
  }
  const { phase } = transition
  const prior = current.phase
  if (phase === 'ready') {
    if (prior !== 'committed' || term !== current.previousTerm + 1) throw new Error('Lead is not committed for readiness')
    if (state.messages.some(message => message.targetId === brandString<SessionId>(state.id)
      && !state.delivered.includes(message.id) && !state.cancelled.some(item => item.messageId === message.id))) {
      throw new Error('Lead mailbox has not durably delivered every queued item')
    }
  } else {
    if (term !== current.previousTerm || executionId !== current.previousExecutionId) {
      throw new Error('Lead coordination has a stale seat')
    }
    if (!(phase === 'frozen' && prior === 'requested'
      || phase === 'safe' && (prior === 'frozen' || prior === 'safe' || prior === 'prepared')
      || phase === 'prepared' && (prior === 'safe' || prior === 'prepared')
      || (phase === 'cancelled' || phase === 'failed') && leadCoordinationActive(current))) {
      throw new Error('Lead coordination phase is not an admitted transition')
    }
  }
  return { ...transition, coordinatorId }
}
